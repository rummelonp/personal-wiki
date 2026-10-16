import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Principal } from "../auth/principal";
import {
  createPageAs,
  describeWriteError,
  type PageWriteContext,
  updatePageAs,
} from "./operations";
import { createPage, type Page } from "./store";

function contextOf(principal: Principal): PageWriteContext {
  return { db: env.DB, principal, now: () => 1, recordWrite: () => {} };
}

// REST と MCP の入口はどちらも write の scope を求め、write は read を含むので、read の無い主体は
// 入口を通っては作れない。operations が scope を見ていることを、主体を直に渡して確かめる
const noRead: Principal = { kind: "token", issuer: "api", id: 1, name: "no-read", scopes: [] };
const writer: Principal = {
  kind: "token",
  issuer: "api",
  id: 2,
  name: "writer",
  scopes: ["write"],
};

async function seed(title: string, visibility: "draft" | "public" = "draft"): Promise<Page> {
  const result = await createPage(env.DB, { title, body: "", actor: "token:seed", now: 1 });
  if (!result.ok) throw new Error(result.reason);
  if (visibility === "public") {
    await env.DB.prepare("UPDATE pages SET visibility = 'public' WHERE id = ?1")
      .bind(result.page.id)
      .run();
  }
  return result.page;
}

describe("title_conflict の existing", () => {
  it("読める主体には、重なった既存のページの id、title、visibility を添える", async () => {
    const taken = await seed("Taken Title");
    const result = await createPageAs(contextOf(writer), { title: "taken_title", body: "" });
    expect(result).toEqual({
      ok: false,
      reason: "title_conflict",
      existing: { id: taken.id, title: "Taken Title", visibility: "draft" },
    });
    if (result.ok) throw new Error("重なる title で作れてしまった");
    expect(describeWriteError(result).body).toMatchObject({
      error: "title_conflict",
      existing: { id: taken.id, title: "Taken Title", visibility: "draft" },
    });
  });

  it("read の scope の無い主体には、draft の id と title を返さない", async () => {
    await seed("Secret Draft");
    const own = await seed("Own Page");
    const created = await createPageAs(contextOf(noRead), { title: "secret draft", body: "" });
    expect(created).toEqual({ ok: false, reason: "title_conflict" });
    const updated = await updatePageAs(contextOf(noRead), {
      id: own.id,
      expectedVersion: 1,
      title: "Secret Draft",
      body: "",
    });
    expect(updated).toEqual({ ok: false, reason: "title_conflict" });
    const body = describeWriteError({ ok: false, reason: "title_conflict" }).body;
    expect(body).not.toHaveProperty("existing");
  });

  it("read の scope の無い主体にも、public のページは添える", async () => {
    const open = await seed("Open Page", "public");
    const result = await createPageAs(contextOf(noRead), { title: "open page", body: "" });
    expect(result).toEqual({
      ok: false,
      reason: "title_conflict",
      existing: { id: open.id, title: "Open Page", visibility: "public" },
    });
  });

  it("更新では、title を改行やタブ込みで送っても 1 行にして引く", async () => {
    const taken = await seed("Two Words");
    const own = await seed("Mine");
    const result = await updatePageAs(contextOf(writer), {
      id: own.id,
      expectedVersion: 1,
      title: " two\twords\n",
      body: "",
    });
    expect(result).toMatchObject({ reason: "title_conflict", existing: { id: taken.id } });
  });
});
