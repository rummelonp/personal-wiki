import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  attachmentRefsOf,
  buildClient,
  linksFrom,
  type PageJson,
  searchFts,
  snapshotDb,
  snapshotDerived,
  tagsOf,
} from "../test/pages";
import { bodySha256 } from "./body-hash";
import { REBUILD_MAX_LIMIT } from "./store";

const IMAGE_A = "AAAAAAAAAAAAAAAAAAAAAA.png";
const IMAGE_B = "BBBBBBBBBBBBBBBBBBBBBB.jpg";

/** 削除されていないページの page_excerpts.body_sha256。行が無ければ null */
async function storedHashes() {
  const { results } = await env.DB.prepare(
    `SELECT p.id, e.body_sha256 AS stored FROM pages AS p
     LEFT JOIN page_excerpts AS e ON e.page_id = p.id
     WHERE p.deleted_at IS NULL ORDER BY p.id`,
  ).all<{ id: string; stored: string | null }>();
  return results;
}

/** 削除されていないページの本文を、保存とは別に bodySha256 でハッシュした値 */
async function expectedHashes() {
  const { results } = await env.DB.prepare(
    "SELECT id, body FROM pages WHERE deleted_at IS NULL ORDER BY id",
  ).all<{ id: string; body: string }>();
  return Promise.all(results.map(async ({ id, body }) => ({ id, stored: await bodySha256(body) })));
}

describe("links と tags", () => {
  it("作成で本文から入り、更新で差分だけ書き換わる", async () => {
    const { create, update } = await buildClient();
    const page = await create("p", "[[Alpha]] [[Beta|別名]] #One #two\n---\n[[alpha]]");
    expect(await linksFrom(page.id)).toEqual([
      { key: "alpha", target: null },
      { key: "beta", target: null },
    ]);
    expect(await tagsOf(page.id)).toEqual([
      { key: "one", tag: "One" },
      { key: "two", tag: "two" },
    ]);

    const res = await update(page, "p", "[[Beta]] [[Gamma]] #ONE #three");
    expect(res.status).toBe(200);
    expect(await linksFrom(page.id)).toEqual([
      { key: "beta", target: null },
      { key: "gamma", target: null },
    ]);
    // 同じ tag_key の表記が変わったら表記も書き換える（作り直しと同じ結果にするため）
    expect(await tagsOf(page.id)).toEqual([
      { key: "one", tag: "ONE" },
      { key: "three", tag: "three" },
    ]);
  });
});

describe("attachment_refs", () => {
  it("本文の添付の embed から入り、更新で差分だけ書き換わる", async () => {
    const { create, update } = await buildClient();
    const page = await create(
      "p",
      [
        `![[${IMAGE_A}]] ![[${IMAGE_A}|300]] [[${IMAGE_B}]]`,
        "```",
        `![[${IMAGE_B}]]`,
        "```",
        `\`![[${IMAGE_B}]]\``,
      ].join("\n"),
    );
    // embed でないリンクとコードの中の embed は数えない
    expect(await attachmentRefsOf(page.id)).toEqual([IMAGE_A]);

    const res = await update(page, "p", `![[${IMAGE_B}]]`);
    expect(res.status).toBe(200);
    expect(await attachmentRefsOf(page.id)).toEqual([IMAGE_B]);
  });

  it("この wiki の添付の名前の形に合わないものは入らない", async () => {
    const { create } = await buildClient();
    const names = [
      "sub/AAAAAAAAAAAAAAAAAAAAAA.png",
      "AAAAAAAAAAAAAAAAAAAAAA.PNG",
      "AAAAAAAAAAAAAAAAAAAAAA.svg",
      "photo.png",
      // web の貼り付けが、アップロードが終わるまで本文に置くプレースホルダー
      "uploading-123-0.png",
      "uploading.1760000000000-0.png",
      "uploading.17600000000-0.png",
    ];
    const page = await create("p", names.map((name) => `![[${name}]]`).join("\n"));
    expect(await attachmentRefsOf(page.id)).toEqual([]);
  });

  it("削除で消え、前の版の本文を保存し直すと戻る", async () => {
    const { create, update, request } = await buildClient();
    const page = await create("p", `![[${IMAGE_A}]]`);
    expect((await update(page, "p", "参照を外した")).status).toBe(200);
    expect(await attachmentRefsOf(page.id)).toEqual([]);
    // revision の復元は前の版の title と本文で保存し直すこと（専用のルートはまだ無い）
    const restored = await update({ id: page.id, version: 2 }, "p", `![[${IMAGE_A}]]`);
    expect(restored.status).toBe(200);
    expect(await attachmentRefsOf(page.id)).toEqual([IMAGE_A]);

    const res = await request(`/api/pages/${page.id}`, {
      method: "DELETE",
      headers: { "If-Match": '"3"' },
    });
    expect(res.status).toBe(204);
    expect(await attachmentRefsOf(page.id)).toEqual([]);
  });
});

describe("pages_fts", () => {
  it("本文の plain text と title が入り、更新で古い内容が消える", async () => {
    const { create, update } = await buildClient();
    const page = await create("全文検索の試し", "**最初の本文** です [[リンク先]]");
    expect(await searchFts("最初の本文")).toEqual([page.id]);
    expect(await searchFts("全文検索")).toEqual([page.id]);
    // Markdown の記号は plain text にしてから入れる
    expect(await searchFts("**最初")).toEqual([]);

    await update(page, "別の題", "二つ目の本文");
    expect(await searchFts("最初の本文")).toEqual([]);
    expect(await searchFts("全文検索")).toEqual([]);
    expect(await searchFts("二つ目")).toEqual([page.id]);
    expect(await searchFts("別の題")).toEqual([page.id]);
  });

  it("title と本文を NFKC にして入れ、全角英数と半角カナでも当たる", async () => {
    const { create } = await buildClient();
    const page = await create("ＡＢＣＤ題", "ｶﾀｶﾅの本文");
    expect(await searchFts("abcd")).toEqual([page.id]);
    expect(await searchFts("カタカナ")).toEqual([page.id]);
  });

  it("削除で消える", async () => {
    const { create, request } = await buildClient();
    const page = await create("消える", "消える本文");
    await request(`/api/pages/${page.id}`, { method: "DELETE", headers: { "If-Match": '"1"' } });
    expect(await searchFts("消える本文")).toEqual([]);
    expect(await linksFrom(page.id)).toEqual([]);
    expect(await tagsOf(page.id)).toEqual([]);
  });
});

describe("links.target_page_id の解決", () => {
  it("作成、title の変更、削除のたびに、そのページを指す links を付け直す", async () => {
    const { create, update, request } = await buildClient();
    const a = await create("A", "[[B]] [[A]]");
    expect(await linksFrom(a.id)).toEqual([
      { key: "a", target: a.id },
      { key: "b", target: null },
    ]);

    const b = await create("B");
    expect(await linksFrom(a.id)).toContainEqual({ key: "b", target: b.id });

    await update(b, "C", "");
    expect(await linksFrom(a.id)).toContainEqual({ key: "b", target: null });

    const b2 = await create("ｂ");
    expect(await linksFrom(a.id)).toContainEqual({ key: "b", target: b2.id });

    await request(`/api/pages/${b2.id}`, { method: "DELETE", headers: { "If-Match": '"1"' } });
    expect(await linksFrom(a.id)).toContainEqual({ key: "b", target: null });
  });

  it("title を変えたページ自身へのリンクは新しい title で解決する", async () => {
    const { create, update } = await buildClient();
    const page = await create("Old", "[[Old]] [[New]]");
    expect(await linksFrom(page.id)).toEqual([
      { key: "new", target: null },
      { key: "old", target: page.id },
    ]);
    await update(page, "New", "[[Old]] [[New]]");
    expect(await linksFrom(page.id)).toEqual([
      { key: "new", target: page.id },
      { key: "old", target: null },
    ]);
  });
});

async function rebuildAll(request: Awaited<ReturnType<typeof buildClient>>["request"]) {
  let after: string | null = null;
  let calls = 0;
  for (;;) {
    const res = await request("/api/admin/derived/rebuild", { method: "POST", json: { after } });
    expect(res.status).toBe(200);
    const body = await res.json<{ next: string | null; failed: string[] }>();
    expect(body.failed).toEqual([]);
    calls += 1;
    if (body.next === null) return calls;
    after = body.next;
  }
}

describe("page_excerpts.body_sha256", () => {
  it("本文を書くどの経路でも、保存した本文のハッシュを同じ batch で書く", async () => {
    const { create, update, request } = await buildClient();
    const expectInSync = async () => expect(await storedHashes()).toEqual(await expectedHashes());

    const target = await create("Target", "リンク先");
    const source = await create("Source", "[[Target]] から");
    await create("Empty");
    await expectInSync();
    // 空の本文にもハッシュがある（抜粋と違い、空文字列のハッシュは値として返す）
    expect((await storedHashes()).every((row) => row.stored !== null)).toBe(true);

    expect((await update(source, "Source", "[[Target]] から 更新")).status).toBe(200);
    await expectInSync();

    const appended = await request(`/api/pages/${source.id}/append`, {
      method: "POST",
      json: { text: "追記" },
    });
    expect(appended.status).toBe(200);
    await expectInSync();

    const restored = await request(`/api/pages/${source.id}/revisions/1/restore`, {
      method: "POST",
      headers: { "If-Match": '"3"' },
    });
    expect(restored.status).toBe(200);
    await expectInSync();

    // title を変えると、リンク元の本文の `[[Target]]` を書き換える step が本文を書く
    expect((await update(target, "Renamed", "リンク先")).status).toBe(200);
    const step = await request("/api/link-rewrites/step", { method: "POST", json: {} });
    expect(await step.json()).toMatchObject({ processed: { sourcePageId: source.id } });
    const rewritten = await env.DB.prepare("SELECT body FROM pages WHERE id = ?1")
      .bind(source.id)
      .first<{ body: string }>();
    expect(rewritten?.body).toContain("[[Renamed]]");
    await expectInSync();
  });

  it("rebuild は無いハッシュと食い違うハッシュを、保存で書く値に戻す", async () => {
    const { create, request } = await buildClient();
    const a = await create("A", "本文 a");
    const b = await create("B", "本文 b");
    const expected = await storedHashes();
    expect(expected).toEqual(await expectedHashes());

    await env.DB.batch([
      env.DB.prepare("UPDATE page_excerpts SET body_sha256 = NULL WHERE page_id = ?1").bind(a.id),
      env.DB.prepare("UPDATE page_excerpts SET body_sha256 = 'stale' WHERE page_id = ?1").bind(
        b.id,
      ),
    ]);
    await rebuildAll(request);
    expect(await storedHashes()).toEqual(expected);
  });
});

describe("POST /api/admin/derived/rebuild", () => {
  it("壊した派生データを、保存で書いたときと同じ行に戻す", async () => {
    const { create, update, request } = await buildClient();
    const a = await create("A", `[[B]] [[C]] #x #Y 本文その一 ![[${IMAGE_A}]] ![[${IMAGE_B}]]`);
    const b = await create("B", "[[A]] #y 本文その二");
    await create("C", "#z 本文その三");
    await update(b, "B", "[[A]] [[D]] #Y #w 本文その二の改");
    const gone = await create("Gone", `[[A]] #g 消える ![[${IMAGE_A}]]`);
    await request(`/api/pages/${gone.id}`, { method: "DELETE", headers: { "If-Match": '"1"' } });
    const expected = await snapshotDb();

    await env.DB.batch([
      env.DB.prepare("DELETE FROM pages_fts"),
      env.DB.prepare("DELETE FROM page_excerpts WHERE page_id = ?1").bind(a.id),
      env.DB.prepare("UPDATE page_excerpts SET excerpt = 'wrong' WHERE page_id = ?1").bind(b.id),
      env.DB.prepare("DELETE FROM tags WHERE page_id = ?1").bind(a.id),
      env.DB.prepare("UPDATE tags SET tag = 'wrong' WHERE page_id = ?1").bind(b.id),
      env.DB.prepare("UPDATE links SET target_page_id = NULL"),
      env.DB.prepare(
        "INSERT INTO links (source_page_id, target_title_key, target_page_id) VALUES (?1, 'stale', NULL)",
      ).bind(a.id),
      // 削除済みのページに残った派生データも消える
      env.DB.prepare("INSERT INTO tags (page_id, tag_key, tag) VALUES (?1, 'g', 'g')").bind(
        gone.id,
      ),
      env.DB.prepare("INSERT INTO page_excerpts (page_id, excerpt) VALUES (?1, 'g')").bind(gone.id),
      env.DB.prepare("DELETE FROM attachment_refs WHERE page_id = ?1 AND name = ?2").bind(
        a.id,
        IMAGE_A,
      ),
      env.DB.prepare("INSERT INTO attachment_refs (page_id, name) VALUES (?1, ?2)").bind(
        b.id,
        IMAGE_B,
      ),
      env.DB.prepare("INSERT INTO attachment_refs (page_id, name) VALUES (?1, ?2)").bind(
        gone.id,
        IMAGE_A,
      ),
    ]);
    expect(await snapshotDerived()).not.toEqual({
      links: expected.links,
      tags: expected.tags,
      attachmentRefs: expected.attachmentRefs,
      excerpts: expected.excerpts,
      fts: expected.fts,
    });

    const calls = await rebuildAll(request);
    // 4 ページを 1 件ずつ。最後の呼び出しは 0 件で next が null になる
    expect(calls).toBe(5);
    expect(await snapshotDb()).toEqual(expected);
  });

  it("limit は 1 から上限まで", async () => {
    const { request } = await buildClient();
    for (const limit of [0, REBUILD_MAX_LIMIT + 1, 1.5]) {
      const res = await request("/api/admin/derived/rebuild", {
        method: "POST",
        json: { limit },
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("rows_written の記録", () => {
  // 20KB 程度の本文、links 20、tags 10。値は miniflare のもので、本番の課金値と一致する保証はない。
  // miniflare は pages_fts への 1 文を 1 行と数え、FTS5 の影のテーブルへの書き込みを含めない
  function largeBody(seed: string, linkPrefix: string, tagPrefix: string) {
    const links = Array.from({ length: 20 }, (_, i) => `[[${linkPrefix}${i}]]`).join(" ");
    const tags = Array.from({ length: 10 }, (_, i) => `#${tagPrefix}${i}`).join(" ");
    const filler = Array.from(
      { length: 400 },
      (_, i) => `${seed} の段落 ${i} です。日本語の文章を並べる。`,
    ).join("\n");
    return `${links}\n${tags}\n${filler}`;
  }

  it("作成、本文だけの更新、全入れ替えの書き込み行数を計測値として出す", async () => {
    const { request, metrics, actor } = await buildClient();
    const body = largeBody("最初", "L", "t");
    const created = await request("/api/pages", {
      method: "POST",
      json: { title: "big", body },
    });
    const page = await created.json<PageJson>();
    const bodyOnly = await request(`/api/pages/${page.id}`, {
      method: "PUT",
      headers: { "If-Match": '"1"' },
      json: { title: "big", body: `${body}\n末尾に一行足す` },
    });
    expect(bodyOnly.status).toBe(200);
    const replaced = await request(`/api/pages/${page.id}`, {
      method: "PUT",
      headers: { "If-Match": '"2"' },
      json: { title: "big2", body: largeBody("二回目", "M", "u") },
    });
    expect(replaced.status).toBe(200);

    expect(metrics.map((m) => m.op)).toEqual(["create", "update", "update"]);
    for (const m of metrics) expect(m).toMatchObject({ actor, pageId: page.id });
    for (const m of metrics) expect(m.rowsWritten).toBeGreaterThan(0);
    const [create, update, replace] = metrics.map((m) => m.rowsWritten);
    console.log(`rows_written: create=${create} body-only=${update} replace-all=${replace}`);
    // 差分更新が効いていれば、本文だけの更新は全入れ替えより明確に少ない
    expect(update).toBeLessThan(replace as number);
  });

  it("本文が変わらない保存では page_excerpts を書き換えない", async () => {
    const { create, update } = await buildClient();
    // 抜粋は先頭の 120 字なので、それより後ろだけを変える更新では抜粋が変わらず、ハッシュだけが変わる
    const head = "あ".repeat(130);
    const page = await create("p", `${head}\n最初の末尾`);
    // UPDATE の回数を数える。行が変わらない upsert は WHERE で更新を飛ばすので、trigger は動かない
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE excerpt_updates (page_id TEXT NOT NULL)"),
      env.DB.prepare(
        `CREATE TRIGGER excerpt_updated AFTER UPDATE ON page_excerpts
         BEGIN INSERT INTO excerpt_updates VALUES (new.page_id); END`,
      ),
    ]);
    const count = async () =>
      (await env.DB.prepare("SELECT count(*) AS n FROM excerpt_updates").first<{ n: number }>())?.n;

    const titleOnly = await update(page, "q", `${head}\n最初の末尾`);
    expect(titleOnly.status).toBe(200);
    expect(await count()).toBe(0);

    const tailOnly = await update({ id: page.id, version: 2 }, "q", `${head}\n次の末尾`);
    expect(tailOnly.status).toBe(200);
    expect(await count()).toBe(1);
    expect(await storedHashes()).toEqual([
      { id: page.id, stored: await bodySha256(`${head}\n次の末尾`) },
    ]);
  });
});
