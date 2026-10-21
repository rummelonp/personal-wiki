import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linksFrom, snapshotDb, tagsOf } from "../test/pages";
import {
  APPEND_MAX_ATTEMPTS,
  appendText,
  appendToPage,
  createPage,
  deletePage,
  findPageById,
  type Page,
  pageExists,
  rebuildDerived,
  setVisibility,
  updatePage,
} from "./store";

async function seedPage(body: string): Promise<Page> {
  const result = await createPage(env.DB, { title: "memo", body, actor: "token:seed", now: 1 });
  if (!result.ok) throw new Error(result.reason);
  return result.page;
}

/**
 * batch を送る直前に before を呼ぶ D1。call は 1 から数えた batch の呼び出し回数。
 * workerd の D1Database は private field を持つので、メソッドは元のオブジェクトに bind して返す。
 */
function hookedDb(before: (call: number) => Promise<void>): D1Database {
  let calls = 0;
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          calls += 1;
          await before(calls);
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** 読んでから書くまでの間に別の保存が入った状況を、最初の interruptions 回の batch で作る。 */
function interruptingDb(interruptions: number, interrupt: () => Promise<void>): D1Database {
  return hookedDb(async (call) => {
    if (call <= interruptions) await interrupt();
  });
}

async function concurrentEdit(id: string, suffix: string) {
  const current = await findPageById(env.DB, id, "all");
  if (current === null) throw new Error("page not found");
  const result = await updatePage(env.DB, {
    id,
    expectedVersion: current.version,
    title: current.title,
    body: `${current.body}${suffix}`,
    actor: "token:other",
    now: 2,
    mergeOwnerSaves: true,
  });
  if (!result.ok) throw new Error(result.reason);
}

describe("pageExists", () => {
  it("draft は all では true、public だけの範囲では false", async () => {
    const page = await seedPage("");
    expect(await pageExists(env.DB, page.id, "all")).toBe(true);
    expect(await pageExists(env.DB, page.id, "public")).toBe(false);
  });

  it("public のページはどちらの範囲でも true", async () => {
    const page = await seedPage("");
    const published = await setVisibility(env.DB, { id: page.id, visibility: "public", now: 2 });
    if (!published.ok) throw new Error(published.reason);
    expect(await pageExists(env.DB, page.id, "all")).toBe(true);
    expect(await pageExists(env.DB, page.id, "public")).toBe(true);
  });

  it("削除した public のページはどちらの範囲でも false", async () => {
    const page = await seedPage("");
    const published = await setVisibility(env.DB, { id: page.id, visibility: "public", now: 2 });
    if (!published.ok) throw new Error(published.reason);
    const deleted = await deletePage(env.DB, {
      id: page.id,
      expectedVersion: published.page.version,
      actor: "owner",
      now: 3,
    });
    if (!deleted.ok) throw new Error(deleted.reason);
    expect(await pageExists(env.DB, page.id, "all")).toBe(false);
    expect(await pageExists(env.DB, page.id, "public")).toBe(false);
  });
});

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
    const latest = await findPageById(env.DB, page.id, "all");
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
    expect((await findPageById(env.DB, page.id, "all"))?.body).toBe("base e1 e2 e3");
  });
});

describe("rebuildDerived", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedTitled(title: string, body: string): Promise<Page> {
    const result = await createPage(env.DB, { title, body, actor: "token:seed", now: 1 });
    if (!result.ok) throw new Error(result.reason);
    return result.page;
  }

  it("版の競合以外で失敗したページは failed に入れ、cursor を進めて次のページを作り直す", async () => {
    const [first, second] = [await seedTitled("a", "#a"), await seedTitled("b", "#b")].sort(
      (p, q) => (p.id < q.id ? -1 : 1),
    );
    if (first === undefined || second === undefined) throw new Error("seed failed");
    await env.DB.prepare("DELETE FROM tags").run();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const db = hookedDb(async (call) => {
      if (call === 1) throw new Error("injected");
    });
    const result = await rebuildDerived(db, { after: null, limit: 2 });

    expect(result).toMatchObject({ rebuilt: 1, skipped: 0, failed: [first.id], next: second.id });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(first.id));
    expect(await tagsOf(first.id)).toEqual([]);
    expect(await tagsOf(second.id)).toEqual([{ key: second.title, tag: second.title }]);
  });

  it("読んでから書くまでに保存が入ったページは skipped にし、古い本文で上書きしない", async () => {
    const page = await seedTitled("p", "[[Old]] #old");
    const db = interruptingDb(1, async () => {
      const result = await updatePage(env.DB, {
        id: page.id,
        expectedVersion: 1,
        title: "p",
        body: "[[New]] #new",
        actor: "token:other",
        now: 2,
        mergeOwnerSaves: true,
      });
      if (!result.ok) throw new Error(result.reason);
    });

    const result = await rebuildDerived(db, { after: null, limit: 1 });

    expect(result).toMatchObject({ rebuilt: 0, skipped: 1, failed: [], next: page.id });
    expect(await linksFrom(page.id)).toEqual([{ key: "new", target: null }]);
    expect(await tagsOf(page.id)).toEqual([{ key: "new", tag: "new" }]);
  });

  it("既存の links 行の target_page_id が別のページを指していたら、解決し直した値で上書きする", async () => {
    const source = await seedTitled("source", "[[B]]");
    const b = await seedTitled("B", "");
    const other = await seedTitled("other", "");
    await env.DB.prepare("UPDATE links SET target_page_id = ?1 WHERE source_page_id = ?2")
      .bind(other.id, source.id)
      .run();

    // source だけを作り直す。他のページの作り直しが付け直す経路を通さないため
    const { results } = await env.DB.prepare("SELECT id FROM pages WHERE id < ?1 ORDER BY id")
      .bind(source.id)
      .all<{ id: string }>();
    const result = await rebuildDerived(env.DB, {
      after: results.at(-1)?.id ?? null,
      limit: 1,
    });

    expect(result).toMatchObject({ rebuilt: 1, next: source.id });
    expect(await linksFrom(source.id)).toEqual([{ key: "b", target: b.id }]);
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
