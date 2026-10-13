import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { snapshotDb } from "../test/pages";
import {
  APPEND_MAX_ATTEMPTS,
  appendText,
  appendToPage,
  createPage,
  findPageById,
  type Page,
  updatePage,
} from "./store";

async function seedPage(body: string): Promise<Page> {
  const result = await createPage(env.DB, { title: "memo", body, actor: "token:seed", now: 1 });
  if (!result.ok) throw new Error(result.reason);
  return result.page;
}

/**
 * batch を送る直前に別の保存を割り込ませる D1。追記が読んでから書くまでの間に競合が起きた状況を作る。
 * workerd の D1Database は private field を持つので、メソッドは元のオブジェクトに bind して返す。
 */
function interruptingDb(interruptions: number, interrupt: () => Promise<void>): D1Database {
  let remaining = interruptions;
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (remaining > 0) {
            remaining -= 1;
            await interrupt();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function concurrentEdit(id: string, suffix: string) {
  const current = await findPageById(env.DB, id);
  if (current === null) throw new Error("page not found");
  const result = await updatePage(env.DB, {
    id,
    expectedVersion: current.version,
    title: current.title,
    body: `${current.body}${suffix}`,
    actor: "token:other",
    now: 2,
  });
  if (!result.ok) throw new Error(result.reason);
}

describe("appendToPage", () => {
  it("読んだあとに別の保存が入ったら、読み直して最新版に足す", async () => {
    const page = await seedPage("base");
    const db = interruptingDb(1, () => concurrentEdit(page.id, " edited"));
    const result = await appendToPage(db, {
      id: page.id,
      text: "appended",
      actor: "token:agent",
      now: 3,
    });
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    const latest = await findPageById(env.DB, page.id);
    expect(latest?.body).toBe("base edited\nappended");
    expect(latest?.version).toBe(3);
  });

  it("競合が上限まで続いたら append_conflict で、追記は書かれない", async () => {
    const page = await seedPage("base");
    let n = 0;
    const db = interruptingDb(APPEND_MAX_ATTEMPTS, () => concurrentEdit(page.id, ` e${++n}`));
    const result = await appendToPage(db, {
      id: page.id,
      text: "appended",
      actor: "token:agent",
      now: 3,
    });
    expect(result).toEqual({ ok: false, reason: "append_conflict" });
    const snapshot = await snapshotDb();
    expect(snapshot.revisions.map((r) => r.actor)).toEqual([
      "token:seed",
      "token:other",
      "token:other",
      "token:other",
    ]);
    expect((await findPageById(env.DB, page.id))?.body).toBe("base e1 e2 e3");
  });
});

describe("appendText", () => {
  it("行の途中に続けない", () => {
    expect(appendText("", "a")).toBe("a");
    expect(appendText("x", "a")).toBe("x\na");
    expect(appendText("x\n", "a")).toBe("x\na");
    expect(appendText("x\n\n", "a")).toBe("x\n\na");
  });
});
