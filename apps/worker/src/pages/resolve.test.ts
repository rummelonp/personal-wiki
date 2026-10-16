import { env } from "cloudflare:workers";
import { MAX_TITLE_BYTES } from "@personal-wiki/domain";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { SESSION_TTL_SECONDS } from "../auth/session";
import { hashApiToken } from "../auth/token";
import { ownerCookie, ownerEnv } from "../test/owner";
import { type PageJson, T0 } from "../test/pages";
import { generateTestToken, insertToken } from "../test/tokens";
import { RESOLVE_MAX_TITLES } from "./routes";

const ORIGIN = "http://localhost";

interface Resolved {
  title: string;
  page: { id: string; title: string; visibility: string } | null;
}

/** public の Open Note、draft の Hidden Plan、削除済みの Gone を作る。 */
async function seed() {
  const clock = { now: T0 };
  const app = createApp({ now: () => clock.now, recordWrite: () => {} });
  const cookie = await ownerCookie(T0);
  const call = (path: string, init: RequestInit = {}) => app.request(path, init, ownerEnv());
  const asOwner = (path: string, method = "GET", json?: unknown, headers = {}) =>
    call(path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        ...headers,
      },
      body: json === undefined ? null : JSON.stringify(json),
    });
  async function create(title: string, visibility: "public" | "draft"): Promise<PageJson> {
    clock.now += 1000;
    const created = await asOwner("/api/pages", "POST", { title, body: "" });
    if (created.status !== 201) throw new Error(`create failed: ${created.status}`);
    const page = await created.json<PageJson>();
    if (visibility === "draft") return page;
    const res = await asOwner(`/api/pages/${page.id}/visibility`, "PUT", { visibility });
    if (res.status !== 200) throw new Error(`visibility failed: ${res.status}`);
    return res.json<PageJson>();
  }
  const open = await create("Open Note", "public");
  const draft = await create("Hidden Plan", "draft");
  const gone = await create("Gone", "public");
  const removed = await asOwner(`/api/pages/${gone.id}`, "DELETE", undefined, {
    "If-Match": `"${gone.version}"`,
  });
  if (removed.status !== 204) throw new Error(`delete failed: ${removed.status}`);
  return { app, clock, call, asOwner, create, open, draft, gone };
}

const resolvePath = (titles: readonly string[]) =>
  `/api/pages/resolve?${titles.map((title) => `title=${encodeURIComponent(title)}`).join("&")}`;

const MIXED = ["Open Note", "Hidden Plan", "Gone", "Missing Page"];

describe("GET /api/pages/resolve", () => {
  it("owner には draft も visibility 付きで解決し、応答は private, no-store", async () => {
    const { asOwner, open, draft } = await seed();
    const res = await asOwner(resolvePath(MIXED));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Vary")).toBe("Authorization, Cookie");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(await res.json()).toEqual({
      results: [
        { title: "Open Note", page: { id: open.id, title: "Open Note", visibility: "public" } },
        {
          title: "Hidden Plan",
          page: { id: draft.id, title: "Hidden Plan", visibility: "draft" },
        },
        { title: "Gone", page: null },
        { title: "Missing Page", page: null },
      ],
    });
  });

  it("read と write の token にも draft を解決する", async () => {
    const { call, draft } = await seed();
    for (const scopes of ["read", "read write"] as const) {
      const token = await insertToken({ name: `t-${scopes}`, scopes });
      const res = await call(resolvePath(["hidden plan"]), {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status, scopes).toBe(200);
      expect(res.headers.get("Cache-Control"), scopes).toBe("private, no-store");
      expect(await res.json(), scopes).toEqual({
        results: [
          {
            title: "hidden plan",
            page: { id: draft.id, title: "Hidden Plan", visibility: "draft" },
          },
        ],
      });
    }
  });

  it("匿名には draft を存在しない title と同じ null で返し、応答のどこにも draft の id と title を含めない", async () => {
    const { call, open, draft } = await seed();
    // 入力の title は応答にそのまま返るので、draft は正式な title と違う表記で引き、正式な表記が
    // 応答に出ないことを確かめる
    const res = await call(
      resolvePath(["Open Note", "hidden plan", "ＨＩＤＤＥＮ　ＰＬＡＮ", "Gone", "Missing Page"]),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Vary")).toBe("Authorization, Cookie");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    const text = await res.text();
    for (const word of [draft.id, "Hidden Plan", '"draft"']) expect(text).not.toContain(word);
    expect(JSON.parse(text)).toEqual({
      results: [
        { title: "Open Note", page: { id: open.id, title: "Open Note", visibility: "public" } },
        { title: "hidden plan", page: null },
        { title: "ＨＩＤＤＥＮ　ＰＬＡＮ", page: null },
        { title: "Gone", page: null },
        { title: "Missing Page", page: null },
      ],
    });
  });

  it("重複や正規化で同じになる title は入力ごとに同じページへ解決し、入力の順を保つ", async () => {
    const { asOwner, open } = await seed();
    const titles = [
      "Missing",
      "open note",
      "Open Note",
      "ＯＰＥＮ　ＮＯＴＥ",
      "  open   note ",
      "open note",
    ];
    const res = await asOwner(resolvePath(titles));
    const { results } = await res.json<{ results: Resolved[] }>();
    expect(results.map((r) => r.title)).toEqual(titles);
    expect(results[0]?.page).toBeNull();
    for (const r of results.slice(1)) {
      expect(r.page, r.title).toEqual({ id: open.id, title: "Open Note", visibility: "public" });
    }
  });

  it("title_key にできない title は 400 にせず null で返し、他の title は解決する", async () => {
    const { asOwner, open } = await seed();
    const res = await asOwner(resolvePath(["", "   ", "Open Note"]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { title: "", page: null },
        { title: "   ", page: null },
        { title: "Open Note", page: { id: open.id, title: "Open Note", visibility: "public" } },
      ],
    });
  });

  it("title が無ければ 400 missing_field", async () => {
    const { asOwner, call } = await seed();
    for (const res of [await asOwner("/api/pages/resolve"), await call("/api/pages/resolve")]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "missing_field", field: "title" });
    }
  });

  it(`title の数は ${RESOLVE_MAX_TITLES} まで。超えたら 400`, async () => {
    const { call, open } = await seed();
    const titles = Array.from({ length: RESOLVE_MAX_TITLES }, (_, i) => `t${i}`);
    titles[RESOLVE_MAX_TITLES - 1] = "Open Note";
    const ok = await call(resolvePath(titles));
    expect(ok.status).toBe(200);
    const { results } = await ok.json<{ results: Resolved[] }>();
    expect(results).toHaveLength(RESOLVE_MAX_TITLES);
    expect(results.at(-1)?.page?.id).toBe(open.id);

    const over = await call(resolvePath([...titles, "extra"]));
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual({
      error: "invalid_field",
      field: "title",
      max: RESOLVE_MAX_TITLES,
    });
  });

  it("UTF-8 で MAX_TITLE_BYTES ちょうどの title は解決し、1 バイトでも超えた title は 400 にせず null", async () => {
    const { asOwner, create, open } = await seed();
    // 多バイト文字の title と、UTF-16 の長さだけで上限を超える ASCII の title の両方を確かめる
    const wide = await create(`${"あ".repeat(Math.floor(MAX_TITLE_BYTES / 3))}a`, "public");
    const ascii = await create("a".repeat(MAX_TITLE_BYTES), "public");
    for (const page of [wide, ascii]) {
      expect(new TextEncoder().encode(page.title).length).toBe(MAX_TITLE_BYTES);
    }
    // 末尾の空白は正規化で消えるので、上限で切らなければ同じページに解決する入力になる
    const titles = [wide.title, ascii.title, `${wide.title} `, `${ascii.title} `, "Open Note"];
    const res = await asOwner(resolvePath(titles));
    expect(res.status).toBe(200);
    const { results } = await res.json<{ results: Resolved[] }>();
    expect(results.map((r) => r.page?.id ?? null)).toEqual([
      wide.id,
      ascii.id,
      null,
      null,
      open.id,
    ]);
  });

  it("URL で意味を持つ記号を含む title も、encodeURIComponent で組んだクエリで解決する", async () => {
    const { asOwner, create } = await seed();
    const pages = [];
    for (const title of ["A&B", "C#1", "1+1", "100%", "a=b?"])
      pages.push(await create(title, "draft"));
    const res = await asOwner(resolvePath(pages.map((page) => page.title)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: pages.map(({ id, title }) => ({ title, page: { id, title, visibility: "draft" } })),
    });
  });

  it("検証できないセッション cookie は 401 にする", async () => {
    const { call, clock } = await seed();
    const expired = await ownerCookie(clock.now - SESSION_TTL_SECONDS * 1000 - 1000);
    const res = await call(resolvePath(["Open Note"]), { headers: { Cookie: expired } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("read の scope を持たない token は 403", async () => {
    const { call } = await seed();
    // 発行スクリプトは read か write を必ず付けるが、未知の scope だけの行は権限なしとして読まれる
    const token = generateTestToken();
    await env.DB.prepare(
      "INSERT INTO api_tokens (name, token_hash, scopes, created_at) VALUES (?, ?, ?, 0)",
    )
      .bind("scopeless", await hashApiToken(token), "admin")
      .run();
    const res = await call(resolvePath(["Open Note"]), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("POST のルートは無く、匿名の POST は 404", async () => {
    const { call } = await seed();
    const res = await call(resolvePath(["Open Note"]), { method: "POST" });
    expect(res.status).toBe(404);
  });
});
