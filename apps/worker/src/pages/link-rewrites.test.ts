import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { buildClient, linksFrom, type PageJson, T0 } from "../test/pages";
import {
  LINK_REWRITE_MAX_ATTEMPTS,
  type LinkRewriteStepResult,
  stepLinkRewrites,
} from "./link-rewrites";
import { findPageById, updatePage } from "./store";

type Client = Awaited<ReturnType<typeof buildClient>>;

interface UpdateJson extends PageJson {
  linkRewrites?: { queued: number; skipped?: string };
}

async function jobs() {
  const { results } = await env.DB.prepare(
    `SELECT source_page_id AS source, target_page_id AS target, old_title_key AS oldKey, actor
     FROM link_rewrites ORDER BY source, target, oldKey`,
  ).all<{ source: string; target: string; oldKey: string; actor: string }>();
  return results;
}

async function read(client: Client, page: { id: string }) {
  const res = await client.request(`/api/pages/${page.id}`);
  expect(res.status).toBe(200);
  return res.json<PageJson>();
}

async function rename(client: Client, page: PageJson, title: string, body = page.body) {
  const res = await client.update(page, title, body);
  expect(res.status).toBe(200);
  return res.json<UpdateJson>();
}

async function step(client: Client, json: Record<string, unknown> = {}) {
  const res = await client.request("/api/link-rewrites/step", { method: "POST", json });
  expect(res.status).toBe(200);
  return res.json<LinkRewriteStepResult>();
}

/** remaining が 0 になるまで step を呼び、各回の応答を返す。 */
async function drain(client: Client, json: Record<string, unknown> = {}) {
  const steps: LinkRewriteStepResult[] = [];
  for (let i = 0; i < 20; i++) {
    const result = await step(client, json);
    steps.push(result);
    if (result.remaining === 0) return steps;
  }
  throw new Error("remaining が 0 にならない");
}

async function actorsOf(pageId: string) {
  const { results } = await env.DB.prepare(
    "SELECT version, actor FROM revisions WHERE page_id = ?1 ORDER BY version",
  )
    .bind(pageId)
    .all<{ version: number; actor: string }>();
  return results;
}

describe("rename で書き換えを積む", () => {
  it("旧 title を指すリンク元ごとに 1 行積み、応答で件数を返す", async () => {
    const client = await buildClient();
    const target = await client.create("Target");
    const a = await client.create("A", "[[Target]]");
    const b = await client.create("B", "[[target|ラベル]] [[ＴＡＲＧＥＴ#見出し]]");
    await client.create("C", "[[Other]]");

    const renamed = await rename(client, target, "New");
    expect(renamed.linkRewrites).toEqual({ queued: 2 });
    expect(await jobs()).toEqual(
      [a.id, b.id]
        .map((source) => ({ source, target: target.id, oldKey: "target", actor: "token:agent" }))
        .sort((x, y) => (x.source < y.source ? -1 : 1)),
    );
  });

  it("title を変えない保存と、リンク元の無い rename では linkRewrites を返さない", async () => {
    const client = await buildClient();
    const target = await client.create("Target");
    const v2 = await rename(client, target, "Target", "本文");
    expect(v2).not.toHaveProperty("linkRewrites");
    // 大文字小文字だけの変更は title_key が変わらないので積まない
    await client.create("A", "[[Target]]");
    const v3 = await rename(client, v2, "TARGET");
    expect(v3).not.toHaveProperty("linkRewrites");
    const v4 = await rename(client, await client.create("Lonely"), "Alone");
    expect(v4).not.toHaveProperty("linkRewrites");
    expect(await jobs()).toEqual([]);
  });

  it("新しい title が既にあると batch ごと戻り、積んだ分も残らない", async () => {
    const client = await buildClient();
    const target = await client.create("Target");
    await client.create("Taken");
    await client.create("A", "[[Target]]");
    const res = await client.update(target, "taken", "");
    expect(res.status).toBe(409);
    expect(await jobs()).toEqual([]);
    expect((await read(client, target)).version).toBe(1);
  });

  it("リンクに書けない title への rename は積まずに skipped を返す", async () => {
    const client = await buildClient();
    const target = await client.create("Target");
    const a = await client.create("A", "[[Target]]");
    const renamed = await rename(client, target, "A|B");
    expect(renamed.linkRewrites).toEqual({ queued: 0, skipped: "unsafe_title" });
    expect(await jobs()).toEqual([]);
    // title を変えない保存では skipped を返さない
    const again = await rename(client, renamed, "A|B", "本文");
    expect(again).not.toHaveProperty("linkRewrites");
    expect((await read(client, a)).body).toBe("[[Target]]");
  });
});

describe("POST /api/link-rewrites/step", () => {
  it("1 回に 1 ページずつ書き換え、revision の actor は rename した呼び出し元になる", async () => {
    const client = await buildClient();
    const target = await client.create("Target");
    const a = await client.create("A", "前 [[Target]] 後\n\n```\n[[Target]]\n```");
    const b = await client.create("B", "[[target|ラベル]] [[Target#見出し]] [[Target^id]]");
    await rename(client, target, "New Title");

    // 失効したトークンの rename でも、書き換えは続けて rename した actor で記録する
    await env.DB.prepare("UPDATE api_tokens SET revoked_at = 1 WHERE name = 'agent'").run();
    const other = await buildClient({ name: "runner" });
    other.clock.now = T0 + 5000;
    const steps = await drain(other);
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.remaining)).toEqual([1, 0]);
    expect(steps.every((s) => !s.conflict && s.failed.length === 0)).toBe(true);
    expect(steps.map((s) => s.processed?.sourcePageId).sort()).toEqual([a.id, b.id].sort());
    expect(steps.find((s) => s.processed?.sourcePageId === b.id)?.processed).toEqual({
      sourcePageId: b.id,
      title: "B",
      visibility: "draft",
      version: 2,
      rewritten: 3,
    });

    const aNow = await read(other, a);
    expect(aNow).toMatchObject({
      body: "前 [[New Title]] 後\n\n```\n[[Target]]\n```",
      version: 2,
      updatedAt: T0 + 5000,
    });
    expect((await read(other, b)).body).toBe(
      "[[New Title|ラベル]] [[New Title#見出し]] [[New Title^id]]",
    );
    expect(await actorsOf(a.id)).toEqual([
      { version: 1, actor: "token:agent" },
      { version: 2, actor: "token:agent" },
    ]);
    expect(await linksFrom(a.id)).toEqual([{ key: "new title", target: target.id }]);
    expect(await jobs()).toEqual([]);
    expect(other.metrics.map(({ op, actor, pageId }) => ({ op, actor, pageId }))).toEqual(
      expect.arrayContaining([
        { op: "link_rewrite", actor: "token:agent", pageId: a.id },
        { op: "link_rewrite", actor: "token:agent", pageId: b.id },
      ]),
    );
    expect(other.metrics).toHaveLength(2);
    expect(await step(other)).toEqual({
      processed: null,
      conflict: false,
      failed: [],
      remaining: 0,
      rowsWritten: 0,
    });
  });

  it("続けて改名すると、最後の title に 1 回で書き換える", async () => {
    const client = await buildClient();
    const target = await client.create("A");
    const s = await client.create("S", "[[A]]");
    const toB = await rename(client, target, "B");
    // 改名の間に [[B]] と書いたページも、次の改名で積まれる
    const t = await client.create("T", "[[B]]");
    await rename(client, toB, "C");
    expect((await jobs()).map((j) => [j.source, j.oldKey]).sort()).toEqual(
      [
        [s.id, "a"],
        [t.id, "b"],
      ].sort(),
    );
    await drain(client);
    expect((await read(client, s)).body).toBe("[[C]]");
    expect((await read(client, t)).body).toBe("[[C]]");
    expect((await read(client, s)).version).toBe(2);
  });

  it("元の title に戻したら、書き込まずに積んだ分を捨てる", async () => {
    const client = await buildClient();
    const target = await client.create("A");
    const s = await client.create("S", "[[A]]");
    const toB = await rename(client, target, "B");
    await rename(client, toB, "A");
    const [result] = await drain(client);
    expect(result).toMatchObject({ processed: null, failed: [], remaining: 0 });
    expect(await read(client, s)).toMatchObject({ body: "[[A]]", version: 1 });
    expect(await jobs()).toEqual([]);
  });

  it("旧 title で別のページを作っても、積んだ時点の対象ページの title に書き換える", async () => {
    const client = await buildClient();
    const target = await client.create("Foo");
    const s = await client.create("S", "[[Foo]]");
    await rename(client, target, "Bar");
    const newcomer = await client.create("Foo");
    expect(await linksFrom(s.id)).toEqual([{ key: "foo", target: newcomer.id }]);
    await drain(client);
    expect((await read(client, s)).body).toBe("[[Bar]]");
    expect(await linksFrom(s.id)).toEqual([{ key: "bar", target: target.id }]);
  });

  it("リンク元か対象が削除されていたら、書き込まずに捨てる", async () => {
    const client = await buildClient();
    const target = await client.create("Target");
    const s1 = await client.create("S1", "[[Target]]");
    const s2 = await client.create("S2", "[[Target]]");
    const renamed = await rename(client, target, "New");
    await client.request(`/api/pages/${s1.id}`, {
      method: "DELETE",
      headers: { "If-Match": '"1"' },
    });
    const steps = await drain(client);
    expect(steps.some((r) => r.processed?.sourcePageId === s1.id)).toBe(false);
    expect((await read(client, s2)).body).toBe("[[New]]");

    const s3 = await client.create("S3", "[[New]]");
    await rename(client, await read(client, renamed), "Newer");
    await client.request(`/api/pages/${target.id}`, {
      method: "DELETE",
      headers: { "If-Match": `"${(await read(client, target)).version}"` },
    });
    // S2 も書き換えで [[New]] になっているので、S2 と S3 の 2 件が積まれている
    const rest = await drain(client);
    expect(rest.map((r) => [r.processed, r.failed])).toEqual([
      [null, []],
      [null, []],
    ]);
    expect(await read(client, s3)).toMatchObject({ body: "[[New]]", version: 1 });
    expect(await read(client, s2)).toMatchObject({ body: "[[New]]", version: 2 });
  });

  it("対象の今の title がリンクに書けなければ捨てる", async () => {
    const client = await buildClient();
    const target = await client.create("A");
    const s = await client.create("S", "[[A]]");
    const toB = await rename(client, target, "B");
    await rename(client, toB, "B#x");
    await drain(client);
    expect(await read(client, s)).toMatchObject({ body: "[[A]]", version: 1 });
    expect(await jobs()).toEqual([]);
  });

  it("自分へのリンクも書き換え、そのページの版が進む", async () => {
    const client = await buildClient();
    const page = await client.create("Old", "[[Old]] [[Other]]");
    const renamed = await rename(client, page, "New");
    expect(renamed.linkRewrites).toEqual({ queued: 1 });
    const [result] = await drain(client);
    expect(result?.processed).toMatchObject({ sourcePageId: page.id, rewritten: 1 });
    expect(await read(client, page)).toMatchObject({
      title: "New",
      body: "[[New]] [[Other]]",
      version: 3,
    });
  });

  it("rename と同時に本文からリンクを消していれば、書き込まずに捨てる", async () => {
    const client = await buildClient();
    const page = await client.create("Old", "[[Old]]");
    const renamed = await rename(client, page, "New", "リンクなし");
    expect(renamed.linkRewrites).toEqual({ queued: 1 });
    await drain(client);
    expect(await read(client, page)).toMatchObject({ body: "リンクなし", version: 2 });
  });

  it("書き換えで他のリンクが崩れるなら書かずに failed にし、積んだ分を捨てる", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await buildClient();
    const target = await client.create("Old");
    const s = await client.create("S", "a ` b [[Old]] c");
    await rename(client, target, "Ne`w");
    const [result] = await drain(client);
    expect(result).toMatchObject({ processed: null, failed: [s.id], remaining: 0 });
    expect(await read(client, s)).toMatchObject({ body: "a ` b [[Old]] c", version: 1 });
    expect(await jobs()).toEqual([]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("link_rewrites.failed"));
    expect(client.metrics.at(-1)).toMatchObject({ op: "link_rewrite", failed: [s.id] });
  });

  it("targetPageId を渡すと、その対象のリンク元だけを進める", async () => {
    const client = await buildClient();
    const x = await client.create("X");
    const y = await client.create("Y");
    const sx = await client.create("SX", "[[X]]");
    const sy = await client.create("SY", "[[Y]]");
    await rename(client, x, "X2");
    await rename(client, y, "Y2");
    const steps = await drain(client, { targetPageId: x.id });
    expect(steps.map((r) => r.processed?.sourcePageId)).toEqual([sx.id]);
    expect((await read(client, sy)).body).toBe("[[Y]]");
    expect((await step(client)).processed?.sourcePageId).toBe(sy.id);
  });

  it("targetPageId の形式が違えば 400", async () => {
    const client = await buildClient();
    const res = await client.request("/api/link-rewrites/step", {
      method: "POST",
      json: { targetPageId: "x" },
    });
    expect(res.status).toBe(400);
  });

  it("1 つのリンク元に複数の対象が積まれていれば、1 回の revision でまとめて書き換える", async () => {
    const client = await buildClient();
    const x = await client.create("X");
    const y = await client.create("Y");
    const s = await client.create("S", "[[X]] [[Y]] [[Z]]");
    await rename(client, x, "X2");
    const other = await buildClient({ name: "other" });
    other.clock.now = T0 + 1000;
    await rename(other, y, "Y2");
    const steps = await drain(client);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.processed).toMatchObject({ sourcePageId: s.id, rewritten: 2, version: 2 });
    expect((await read(client, s)).body).toBe("[[X2]] [[Y2]] [[Z]]");
    // 後に積んだ rename の呼び出し元を actor にする
    expect((await actorsOf(s.id)).at(-1)).toEqual({ version: 2, actor: "token:other" });
  });

  it("同じ旧 key に 2 つの対象が積まれていれば、先に積んだ方の title に書き換える", async () => {
    const client = await buildClient();
    const first = await client.create("A");
    const s = await client.create("S", "[[A]]");
    await rename(client, first, "B");
    client.clock.now = T0 + 1000;
    // 旧 title で作ったページを改名すると、S の [[A]] がもう一度積まれる
    const second = await client.create("A");
    await rename(client, second, "C");
    expect((await jobs()).map((j) => [j.target, j.oldKey]).sort()).toEqual(
      [
        [first.id, "a"],
        [second.id, "a"],
      ].sort(),
    );
    await drain(client);
    expect((await read(client, s)).body).toBe("[[B]]");
    expect(await jobs()).toEqual([]);
  });

  it("元に戻してからもう一度改名すると、積み直して最後の title に書き換える", async () => {
    const client = await buildClient();
    const target = await client.create("A");
    const s = await client.create("S", "[[A]]");
    const toB = await rename(client, target, "B");
    client.clock.now = T0 + 1000;
    const backToA = await rename(client, toB, "A");
    expect(backToA).not.toHaveProperty("linkRewrites");
    client.clock.now = T0 + 2000;
    const toC = await rename(client, backToA, "C");
    // 残っていた行を積み直すので、件数に数える
    expect(toC.linkRewrites).toEqual({ queued: 1 });
    expect(await createdAtOf(s.id)).toEqual([T0 + 2000]);
    await drain(client);
    expect(await read(client, s)).toMatchObject({ body: "[[C]]", version: 2 });
  });

  it("読んだあとにリンク元が保存されたら、積んだ分を残して conflict を返す", async () => {
    const client = await buildClient();
    const target = await client.create("Old");
    const s = await client.create("S", "[[Old]]");
    await rename(client, target, "New");
    const racing = beforeBatch(async () => {
      await env.DB.prepare("UPDATE pages SET version = version + 1 WHERE id = ?1").bind(s.id).run();
    });
    const { result } = await stepLinkRewrites(racing, { targetPageId: null, now: T0 });
    expect(result).toMatchObject({ processed: null, conflict: true, remaining: 1 });
    expect(await jobs()).toHaveLength(1);
    // batch まで進んだ試行は、試行回数に数えない
    expect(await attemptsOf(s.id)).toEqual([0]);
    expect(await read(client, s)).toMatchObject({ body: "[[Old]]", version: 2 });

    await drain(client);
    expect(await read(client, s)).toMatchObject({ body: "[[New]]", version: 3 });
  });

  it("読んだあとに対象が改名されたら、古い title を書かずに conflict を返す", async () => {
    const client = await buildClient();
    const target = await client.create("A");
    const s = await client.create("S", "[[A]]");
    await rename(client, target, "B");
    // step が B を読んだあと、書く前に C へ改名する。S の [[A]] はもう対象を指していないので、
    // この rename では積み直されない
    const racing = beforeBatch(async () => {
      expect(await renameDirectly(target.id, "C", T0 + 1000)).toEqual({ queued: 0 });
    });
    const { result } = await stepLinkRewrites(racing, { targetPageId: null, now: T0 + 2000 });
    expect(result).toMatchObject({ processed: null, conflict: true, remaining: 1 });
    expect(await read(client, s)).toMatchObject({ body: "[[A]]", version: 1 });

    await drain(client);
    expect((await read(client, s)).body).toBe("[[C]]");
    expect(await jobs()).toEqual([]);
  });

  it("元に戻した分を捨てる前に対象が改名されたら、捨てずに残す", async () => {
    const client = await buildClient();
    const target = await client.create("A");
    const s = await client.create("S", "[[A]]");
    const toB = await rename(client, target, "B");
    await rename(client, toB, "A");
    const racing = beforeBatch(async () => {
      // 元に戻したので S の [[A]] は対象を指しており、改名で同じ行が積み直される
      expect(await renameDirectly(target.id, "C", T0 + 1000)).toEqual({ queued: 1 });
    });
    const { result } = await stepLinkRewrites(racing, { targetPageId: null, now: T0 + 2000 });
    expect(result).toMatchObject({ processed: null, conflict: true, remaining: 1 });
    expect(await jobs()).toMatchObject([{ source: s.id, oldKey: "a", actor: "token:other" }]);
    expect(await createdAtOf(s.id)).toEqual([T0 + 1000]);

    await drain(client);
    expect((await read(client, s)).body).toBe("[[C]]");
  });

  it("書き換えるものが無いと読んだあとにリンク元が保存されたら、捨てずに残す", async () => {
    const client = await buildClient();
    const target = await client.create("Old");
    const s = await client.create("S", "[[Old]]");
    await rename(client, target, "New");
    const v2 = await rename(client, s, "S", "リンクなし");
    const racing = beforeBatch(async () => {
      const res = await client.update(v2, "S", "[[Old]] を書き戻した");
      expect(res.status).toBe(200);
    });
    const { result } = await stepLinkRewrites(racing, { targetPageId: null, now: T0 });
    expect(result).toMatchObject({ processed: null, conflict: true, remaining: 1 });

    await drain(client);
    expect((await read(client, s)).body).toBe("[[New]] を書き戻した");
  });

  it("派生データの表が古くても、本文を解析し直して書き換える", async () => {
    const client = await buildClient();
    const target = await client.create("Old");
    const s = await client.create("S", "[[Old]] #tag");
    await rename(client, target, "New");
    await env.DB.prepare("DELETE FROM tags WHERE page_id = ?1").bind(s.id).run();
    const [result] = await drain(client);
    expect(result).toMatchObject({ failed: [], processed: { sourcePageId: s.id } });
    expect((await read(client, s)).body).toBe("[[New]] #tag");
  });

  it("処理が上限の回数まで終わらなかったリンク元は、解析せずに failed にして捨てる", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await buildClient();
    const target = await client.create("Old");
    const s = await client.create("S", "[[Old]]");
    await rename(client, target, "New");
    // batch の失敗は試行回数に数え、積んだ分は残る
    const failing = beforeBatch(async () => {
      throw new Error("injected");
    });
    for (let i = 0; i < LINK_REWRITE_MAX_ATTEMPTS; i++) {
      await expect(stepLinkRewrites(failing, { targetPageId: null, now: T0 })).rejects.toThrow(
        "injected",
      );
    }
    expect(await attemptsOf(s.id)).toEqual([LINK_REWRITE_MAX_ATTEMPTS]);
    const [result] = await drain(client);
    expect(result).toMatchObject({ processed: null, failed: [s.id], remaining: 0 });
    expect(await read(client, s)).toMatchObject({ body: "[[Old]]", version: 1 });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("attempts_exceeded"));
  });

  it("上限を超えて捨てる間に積み直された分は残す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await buildClient();
    const target = await client.create("A");
    const s = await client.create("S", "[[A]]");
    const toB = await rename(client, target, "B");
    await rename(client, toB, "A");
    await env.DB.prepare("UPDATE link_rewrites SET attempts = ?1")
      .bind(LINK_REWRITE_MAX_ATTEMPTS)
      .run();
    // 上限を超えた分は読んだ状態を確かめずに捨てるので、積み直した行は created_at の違いで残る
    const racing = beforeBatch(async () => {
      expect(await renameDirectly(target.id, "C", T0 + 1000)).toEqual({ queued: 1 });
    });
    const { result } = await stepLinkRewrites(racing, { targetPageId: null, now: T0 + 2000 });
    expect(result).toMatchObject({ failed: [s.id], remaining: 1 });
    expect(await attemptsOf(s.id)).toEqual([0]);

    await drain(client);
    expect((await read(client, s)).body).toBe("[[C]]");
  });
});

/** batch を送る直前に hook を呼ぶ D1。hook の中の書き込みは env.DB に直接送る */
function beforeBatch(hook: () => Promise<void>): D1Database {
  return new Proxy(env.DB, {
    get(db, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await hook();
          return db.batch(statements);
        };
      }
      const value = Reflect.get(db, prop, db);
      return typeof value === "function" ? value.bind(db) : value;
    },
  });
}

/** 別の呼び出し元の保存として、本文を変えずに title だけを変える */
async function renameDirectly(id: string, title: string, now: number) {
  const current = await findPageById(env.DB, id);
  if (current === null) throw new Error("page not found");
  const result = await updatePage(env.DB, {
    id,
    expectedVersion: current.version,
    title,
    body: current.body,
    actor: "token:other",
    now,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.linkRewrites;
}

async function attemptsOf(sourcePageId: string) {
  const { results } = await env.DB.prepare(
    "SELECT attempts FROM link_rewrites WHERE source_page_id = ?1",
  )
    .bind(sourcePageId)
    .all<{ attempts: number }>();
  return results.map((r) => r.attempts);
}

async function createdAtOf(sourcePageId: string) {
  const { results } = await env.DB.prepare(
    "SELECT created_at FROM link_rewrites WHERE source_page_id = ?1",
  )
    .bind(sourcePageId)
    .all<{ created_at: number }>();
  return results.map((r) => r.created_at);
}
