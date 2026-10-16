import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { stepLinkRewrites } from "./link-rewrites";
import { actorOf, REVISION_MERGE_WINDOW_MS } from "./revisions";
import { appendToPage, createPage, findPageById, setVisibility, updatePage } from "./store";

describe("actorOf", () => {
  it("api_tokens の token は id と name、OAuth は client_id、owner は owner", () => {
    expect(actorOf({ kind: "owner" })).toBe("owner");
    expect(
      actorOf({ kind: "token", issuer: "api", id: 7, name: "air-claude", scopes: ["read"] }),
    ).toBe("token:7:air-claude");
    expect(actorOf({ kind: "token", issuer: "oauth", name: "client-1", scopes: ["read"] })).toBe(
      "oauth:client-1",
    );
  });

  it("同じ名前の token でも id が違えば別の actor になる", () => {
    const of = (id: number) =>
      actorOf({ kind: "token", issuer: "api", id, name: "air-claude", scopes: ["read"] });
    expect(of(1)).not.toBe(of(2));
  });

  it("数字だけの name でも、name の UNIQUE を外す前の形（token:<name>）と重ならない", () => {
    // 前の形で name が "12" の token と、新しい形で id が 12 の token
    expect(actorOf({ kind: "token", issuer: "api", id: 12, name: "x", scopes: [] })).not.toBe(
      "token:12",
    );
  });

  it("anonymous は書き込めない", () => {
    expect(() => actorOf({ kind: "anonymous" })).toThrow();
  });
});

describe("保存の revision のまとめ", () => {
  const T = Date.UTC(2026, 9, 1);
  const MINUTE = 60 * 1000;

  async function revisionsOf(pageId: string) {
    const { results } = await env.DB.prepare(
      "SELECT version, title, body, actor, created_at FROM revisions WHERE page_id = ?1 ORDER BY version",
    )
      .bind(pageId)
      .all<{ version: number; title: string; body: string; actor: string; created_at: number }>();
    return results;
  }

  async function create(actor: string, now: number, title = "memo") {
    const result = await createPage(env.DB, { title, body: "v1", actor, now });
    if (!result.ok) throw new Error(result.reason);
    return result.page.id;
  }

  /** 今の版に対して保存する。title を省くと今の title のまま */
  async function save(id: string, body: string, actor: string, now: number, title?: string) {
    const current = await findPageById(env.DB, id);
    if (current === null) throw new Error("page not found");
    const result = await updatePage(env.DB, {
      id,
      expectedVersion: current.version,
      title: title ?? current.title,
      body,
      actor,
      now,
    });
    if (!result.ok) throw new Error(result.reason);
    return result;
  }

  it("owner の保存は、最初の保存から 10 分以内なら 1 つにまとめ、最新の版と内容を持つ", async () => {
    const id = await create("owner", T);
    await save(id, "v2", "owner", T + MINUTE);
    const last = await save(id, "v3", "owner", T + 9 * MINUTE, "renamed");
    expect(last.page.version).toBe(3);
    expect(await revisionsOf(id)).toEqual([
      { version: 3, title: "renamed", body: "v3", actor: "owner", created_at: T },
    ]);
  });

  it("10 分は直前の保存ではなく、まとめた最初の保存から数える", async () => {
    const id = await create("owner", T);
    await save(id, "v2", "owner", T + 6 * MINUTE);
    await save(id, "v3", "owner", T + 12 * MINUTE);
    await save(id, "v4", "owner", T + 18 * MINUTE);
    expect(await revisionsOf(id)).toMatchObject([
      { version: 2, body: "v2", created_at: T },
      { version: 4, body: "v4", created_at: T + 12 * MINUTE },
    ]);
  });

  it("ちょうど 10 分ならまとめ、それを過ぎたら新しく積む", async () => {
    const at = await create("owner", T);
    await save(at, "v2", "owner", T + REVISION_MERGE_WINDOW_MS);
    expect((await revisionsOf(at)).map((r) => r.version)).toEqual([2]);

    const over = await create("owner", T, "other");
    await save(over, "v2", "owner", T + REVISION_MERGE_WINDOW_MS + 1);
    expect((await revisionsOf(over)).map((r) => r.version)).toEqual([1, 2]);
  });

  it("token と OAuth の保存は、続けても毎回 1 件残す", async () => {
    const id = await create("token:1:agent", T);
    await save(id, "v2", "token:1:agent", T + 1);
    await save(id, "v3", "oauth:client", T + 2);
    await save(id, "v4", "oauth:client", T + 3);
    expect((await revisionsOf(id)).map((r) => r.version)).toEqual([1, 2, 3, 4]);
  });

  it("owner の保存を token の revision にはまとめない", async () => {
    const id = await create("token:1:agent", T);
    await save(id, "v2", "owner", T + 1);
    expect((await revisionsOf(id)).map((r) => [r.version, r.actor])).toEqual([
      [1, "token:1:agent"],
      [2, "owner"],
    ]);
  });

  it("間に別の actor の保存が入ると、その前の owner の revision にはまとめない", async () => {
    const id = await create("owner", T);
    await save(id, "v2", "token:1:agent", T + 1);
    await save(id, "v3", "owner", T + 2);
    await save(id, "v4", "owner", T + 3);
    expect((await revisionsOf(id)).map((r) => [r.version, r.actor, r.body])).toEqual([
      [1, "owner", "v1"],
      [2, "token:1:agent", "v2"],
      [4, "owner", "v4"],
    ]);
  });

  it("公開範囲を切り替えると、切り替えた時点の本文を残してまとめの境目にする", async () => {
    const id = await create("owner", T);
    await save(id, "v2", "owner", T + 1);
    const published = await setVisibility(env.DB, { id, visibility: "public", now: T + 2 });
    expect(published).toMatchObject({ ok: true, page: { version: 3, visibility: "public" } });
    await save(id, "v4", "owner", T + 3);
    await save(id, "v5", "owner", T + 4);
    expect((await revisionsOf(id)).map((r) => [r.version, r.body])).toEqual([
      [2, "v2"],
      [5, "v5"],
    ]);
    expect((await findPageById(env.DB, id))?.visibility).toBe("public");
  });

  it("owner の追記もまとめる", async () => {
    const id = await create("owner", T);
    const result = await appendToPage(env.DB, { id, text: "added", actor: "owner", now: T + 1 });
    expect(result).toMatchObject({ ok: true, page: { version: 2 } });
    expect(await revisionsOf(id)).toMatchObject([{ version: 2, body: "v1\nadded" }]);
  });

  it("古い版に対する owner の保存は version_conflict で、revisions を変えない", async () => {
    // 古い版 1 の owner の revision を版 2 に進めようとすると、token の版 2 の行と主キーが重なる。
    // guard が batch の先頭になければ、版の競合ではなく主キーの違反で失敗する
    const id = await create("owner", T);
    await save(id, "v2", "token:1:agent", T + 1);
    const before = await revisionsOf(id);
    const result = await updatePage(env.DB, {
      id,
      expectedVersion: 1,
      title: "memo",
      body: "stale",
      actor: "owner",
      now: T + 2,
    });
    expect(result).toEqual({ ok: false, reason: "version_conflict", currentVersion: 2 });
    expect(await revisionsOf(id)).toEqual(before);
  });

  it("保存が失敗したら、まとめるはずだった revision も元のまま残る", async () => {
    const id = await create("owner", T);
    await create("owner", T, "taken");
    const before = await revisionsOf(id);
    const result = await updatePage(env.DB, {
      id,
      expectedVersion: 1,
      title: "taken",
      body: "v2",
      actor: "owner",
      now: T + 1,
    });
    expect(result).toMatchObject({ ok: false, reason: "title_conflict" });
    expect(await revisionsOf(id)).toEqual(before);
  });

  it("owner の rename によるリンクの書き換えは直前の revision にまとめず、続く owner の保存はまとめる", async () => {
    const target = await create("owner", T, "Old");
    const source = await create("owner", T, "Source");
    await save(source, "[[Old]]", "owner", T + 1);
    await save(target, "v2", "owner", T + 2, "New");
    const step = await stepLinkRewrites(env.DB, { targetPageId: null, now: T + 3 });
    expect(step.result.processed).toMatchObject({ sourcePageId: source, version: 3 });
    expect((await revisionsOf(source)).map((r) => [r.version, r.actor, r.body])).toEqual([
      [2, "owner", "[[Old]]"],
      [3, "owner", "[[New]]"],
    ]);

    await save(source, "[[New]] edited", "owner", T + 4);
    expect((await revisionsOf(source)).map((r) => [r.version, r.created_at, r.body])).toEqual([
      [2, T, "[[Old]]"],
      [4, T + 3, "[[New]] edited"],
    ]);
  });
});
