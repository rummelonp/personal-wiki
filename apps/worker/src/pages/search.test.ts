import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { buildClient, type PageJson, T0 } from "../test/pages";
import { searchPages } from "./search";

interface Hit {
  id: string;
  title: string;
  visibility: string;
  updatedAt: number;
  excerpt: string;
}

async function search(
  client: Awaited<ReturnType<typeof buildClient>>,
  q: string,
  extra = "",
): Promise<Hit[]> {
  const res = await client.request(`/api/search?q=${encodeURIComponent(q)}${extra}`);
  expect(res.status).toBe(200);
  return (await res.json<{ results: Hit[] }>()).results;
}

/** Authorization を付けずに呼ぶ。 */
const withoutToken = (path: string) => createApp().request(path, {}, env);

const titles = (hits: { title: string }[]) => hits.map((hit) => hit.title);

describe("GET /api/search", () => {
  it("3 文字以上は FTS で引き、id、title、visibility、updatedAt、抜粋を返す", async () => {
    const client = await buildClient();
    const page = await client.create("料理メモ", "# 見出し\n\nカレーの隠し味はチョコレートです。");
    await client.create("別のページ", "関係ない本文");
    const hits = await search(client, "隠し味");
    expect(hits).toEqual([
      {
        id: page.id,
        title: "料理メモ",
        visibility: "draft",
        updatedAt: T0,
        excerpt: expect.stringContaining("隠し味"),
        tags: [],
      },
    ]);
    // 抜粋は plainText から取るので、Markdown の記号を含まない
    expect(hits[0]?.excerpt).not.toContain("#");
  });

  it("全角英数と半角カナは NFKC で畳んで引く", async () => {
    const client = await buildClient();
    await client.create("note", "ＡＢＣ１２３ と ｶﾀｶﾅ");
    await client.create("全角のタイトル", "x");
    expect(titles(await search(client, "abc123"))).toEqual(["note"]);
    expect(titles(await search(client, "ＡＢＣ１２３"))).toEqual(["note"]);
    expect(titles(await search(client, "カタカナ"))).toEqual(["note"]);
    expect(titles(await search(client, "ｶﾀｶﾅ"))).toEqual(["note"]);
    expect(titles(await search(client, "ｾﾞﾝｶｸ"))).toEqual([]);
    expect(titles(await search(client, "ｱｲｳ"))).toEqual([]);
  });

  it("NFKC で 2 文字と 3 文字をまたぐ語は、畳んだ後の文字数で経路を選ぶ", async () => {
    const client = await buildClient();
    // ｶﾞｷ は 3 コードポイント（ｶ ﾞ ｷ）だが NFKC で ガキ の 2 文字になり LIKE へ回る。
    // ㍿ は 1 文字だが NFKC で 株式会社 の 4 文字になり FTS に回る
    await client.create("kana", "ガキの使い");
    await client.create("corp", "株式会社の設立");
    expect(titles(await search(client, "ｶﾞｷ"))).toEqual(["kana"]);
    expect(titles(await search(client, "㍿"))).toEqual(["corp"]);
  });

  it("バックスラッシュを含む本文を、バックスラッシュで引ける", async () => {
    const client = await buildClient();
    await client.create("path", "C:\\dir\\file を開く");
    await client.create("other", "dir と file");
    expect(titles(await search(client, "\\"))).toEqual(["path"]);
    expect(titles(await search(client, "r\\"))).toEqual(["path"]);
    expect(titles(await search(client, "C:\\dir"))).toEqual(["path"]);
  });

  it("title にだけ一致しても返し、抜粋は本文の先頭になる", async () => {
    const client = await buildClient();
    await client.create("ユニークな題名", "本文は別の話です");
    const hits = await search(client, "ユニーク");
    expect(titles(hits)).toEqual(["ユニークな題名"]);
    expect(hits[0]?.excerpt).toContain("本文は別の話です");
  });

  it("FTS の構文文字を含む語は、そのままの文字列として探す", async () => {
    const client = await buildClient();
    await client.create("quote", 'say "hello world" now');
    await client.create("star", "wild*card と OR と NEAR(a b)");
    await client.create("other", "hello there world");
    expect(titles(await search(client, '"hello world"'))).toEqual(["quote"]);
    expect(titles(await search(client, 'hello" OR "world'))).toEqual([]);
    expect(titles(await search(client, 'say "hello world" now'))).toEqual(["quote"]);
    expect(titles(await search(client, "wild*card"))).toEqual(["star"]);
    // OR や NEAR を演算子にすると他のページにも一致する。文字列として探せば star だけ
    expect(titles(await search(client, "hello OR wild"))).toEqual([]);
    expect(titles(await search(client, "と OR と"))).toEqual(["star"]);
    expect(titles(await search(client, "NEAR(a b)"))).toEqual(["star"]);
    expect(titles(await search(client, "title:star"))).toEqual([]);
    expect(titles(await search(client, "NEAR("))).toEqual(["star"]);
    expect(titles(await search(client, "(((("))).toEqual([]);
  });

  it("title に一致するページがあっても、列指定や引用符を含む語を FTS の構文にしない", async () => {
    const client = await buildClient();
    await client.create("{title}:x", "本文");
    await client.create('a"b 題', "本文");
    await client.create('"""', "本文");
    await client.create("x", "title:x の話");
    expect(titles(await search(client, "{title}:x"))).toEqual(["{title}:x"]);
    expect(titles(await search(client, 'a"b'))).toEqual(['a"b 題']);
    expect(titles(await search(client, '"""'))).toEqual(['"""']);
    expect(titles(await search(client, "title:x"))).toEqual(["x"]);
  });

  it("1〜2 文字は LIKE で引き、% と _ をワイルドカードにしない", async () => {
    const client = await buildClient();
    await client.create("percent", "達成率は100%です");
    client.clock.now += 1000;
    await client.create("under", "snake_case の名前");
    client.clock.now += 1000;
    await client.create("plain", "100 point と snakeXcase");
    expect(titles(await search(client, "%"))).toEqual(["percent"]);
    expect(titles(await search(client, "_"))).toEqual(["under"]);
    expect(titles(await search(client, "0%"))).toEqual(["percent"]);
    expect(titles(await search(client, "e_"))).toEqual(["under"]);
    expect(titles(await search(client, "\\"))).toEqual([]);
    expect(titles(await search(client, "達"))).toEqual(["percent"]);
    // ASCII の大文字小文字は区別しない。ASCII 以外の大文字小文字は MATCH だけが畳む
    expect(titles(await search(client, "SN"))).toEqual(["plain", "under"]);
  });

  it("LIKE の抜粋は一致位置の周りを切り出し、切れた側に省略記号を付ける", async () => {
    const client = await buildClient();
    const long = `${"あ".repeat(100)}宝${"い".repeat(100)}`;
    await client.create("long", long);
    await client.create("short", "宝");
    const hits = await search(client, "宝");
    const byTitle = Object.fromEntries(hits.map((hit) => [hit.title, hit.excerpt]));
    expect(byTitle.short).toBe("宝");
    expect(byTitle.long).toMatch(/^….*宝.*…$/);
    expect(byTitle.long?.length).toBeLessThan(80);
  });

  it("title にだけ一致する短い語も LIKE で返す", async () => {
    const client = await buildClient();
    await client.create("猫", "本文");
    expect(await search(client, "猫")).toEqual([
      expect.objectContaining({ title: "猫", excerpt: "本文" }),
    ]);
  });

  it("前後の空白を除き、空や空白だけは 400", async () => {
    const client = await buildClient();
    await client.create("abc", "x");
    expect(titles(await search(client, "  abc \n"))).toEqual(["abc"]);
    for (const q of ["", "   ", "　"]) {
      const res = await client.request(`/api/search?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: "invalid_field",
        field: "q",
        reason: "empty",
      });
    }
    for (const q of ["abc\u0000", "\u0000", "\u0000x", "a\tb", "a\nb\u007f"]) {
      const res = await client.request(`/api/search?q=${encodeURIComponent(q)}`);
      expect(res.status, JSON.stringify(q)).toBe(400);
      expect(await res.json()).toMatchObject({
        error: "invalid_field",
        field: "q",
        reason: "control_char",
      });
    }
    const missing = await client.request("/api/search");
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "missing_field", field: "q" });
    const tooLong = await client.request(`/api/search?q=${"a".repeat(201)}`);
    expect(tooLong.status).toBe(400);
  });

  it("関連度の順に返し、title の一致を本文の一致より上に置く", async () => {
    const client = await buildClient();
    await client.create("本文だけ", "ここに検索語があります");
    await client.create("検索語の題名", "ここは別の話");
    expect(titles(await search(client, "検索語"))).toEqual(["検索語の題名", "本文だけ"]);
  });

  it("title に語を含むページを、本文が長くても、本文に語だけを含む短いページより上に置く", async () => {
    const client = await buildClient();
    // bm25 は本文が短いほど一致を強く見るので、短い本文の方が単純な重み付けでは上に来る
    await client.create("Static Assets", "#cloudflare");
    await client.create(
      "Cloudflare Workers のメモ",
      `Workers の設定を書く。${"あいうえお。".repeat(200)} cloudflare の管理画面から開く。`,
    );
    expect(titles(await search(client, "cloudflare"))).toEqual([
      "Cloudflare Workers のメモ",
      "Static Assets",
    ]);
  });

  it("title に語を含むページの中は、関連度、更新の新しい順に並べる", async () => {
    const client = await buildClient();
    await client.create("検索語 A", "別の話");
    client.clock.now += 1000;
    await client.create("検索語 B", "別の話");
    await client.create("本文だけ", "検索語 検索語 検索語");
    expect(titles(await search(client, "検索語"))).toEqual(["検索語 B", "検索語 A", "本文だけ"]);
  });

  it("2 文字以下の語も、title に含むページを本文だけのページより上に置く", async () => {
    const client = await buildClient();
    await client.create("本文だけ", "ねこの話");
    client.clock.now += 1000;
    await client.create("ねこ日記", "別の話");
    client.clock.now += 1000;
    await client.create("最新の本文", "ねこ");
    expect(titles(await search(client, "ねこ"))).toEqual(["ねこ日記", "最新の本文", "本文だけ"]);
  });

  it("関連度が同じなら更新の新しい順に返す", async () => {
    const client = await buildClient();
    // bm25 は title の長さの差でも変わるので、同じ長さの title にして同点にする
    await client.create("ページA", "同じ文 キーワード");
    client.clock.now += 1000;
    await client.create("ページB", "同じ文 キーワード");
    expect(titles(await search(client, "キーワード"))).toEqual(["ページB", "ページA"]);
    expect(titles(await search(client, "ー"))).toEqual(["ページB", "ページA"]);
  });

  it("limit で件数を絞り、範囲外や整数でない値は 400", async () => {
    const client = await buildClient();
    for (let i = 0; i < 3; i++) await client.create(`page${i}`, "共通の本文");
    expect(await search(client, "共通の", "&limit=2")).toHaveLength(2);
    expect(await search(client, "共通の")).toHaveLength(3);
    for (const limit of ["0", "-1", "1.5", "abc", "51", ""]) {
      const res = await client.request(`/api/search?q=abc&limit=${limit}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_field", field: "limit" });
    }
    expect((await client.request("/api/search?q=abc&limit=50")).status).toBe(200);
  });

  it("limit で切った後も、上位のページを関連度の順に、それぞれの本文から取った抜粋で返す", async () => {
    const client = await buildClient();
    await client.create("本文だけ A", "最初の話 共通語 の続き");
    client.clock.now += 1000;
    await client.create("共通語 の題名", "題名に一致するページ");
    client.clock.now += 1000;
    await client.create("本文だけ B", "別の話 共通語 の続き");
    const hits = await search(client, "共通語", "&limit=2");
    expect(titles(hits)).toEqual(["共通語 の題名", "本文だけ B"]);
    expect(hits[0]?.excerpt).toBe("題名に一致するページ");
    expect(hits[1]?.excerpt).toContain("別の話 共通語 の続き");
  });

  it("削除済みのページは FTS でも LIKE でも返さず、更新後は新しい内容で引く", async () => {
    const client = await buildClient();
    const gone = await client.create("消える", "消えるキーワード");
    const kept = await client.create("残る", "古い語");
    await client.request(`/api/pages/${gone.id}`, {
      method: "DELETE",
      headers: { "If-Match": '"1"' },
    });
    expect(await search(client, "消えるキーワード")).toEqual([]);
    expect(await search(client, "消")).toEqual([]);
    expect((await client.update(kept, "残る", "新しい語")).status).toBe(200);
    expect(await search(client, "古い語")).toEqual([]);
    expect(titles(await search(client, "新しい語"))).toEqual(["残る"]);
    expect(titles(await search(client, "新"))).toEqual(["残る"]);
  });

  it("draft も区別なく返す", async () => {
    const client = await buildClient();
    const page = await client.create("下書き", "秘密の下書き");
    expect(page.visibility).toBe("draft");
    expect(titles(await search(client, "秘密の"))).toEqual(["下書き"]);
  });

  it("token が無ければ匿名として 200、read の token で 200", async () => {
    const reader = await buildClient({ scopes: "read", name: "reader" });
    expect((await withoutToken("/api/search?q=abc")).status).toBe(200);
    expect((await reader.request("/api/search?q=abc")).status).toBe(200);
  });
});

async function recent(
  client: Awaited<ReturnType<typeof buildClient>>,
  query = "",
): Promise<{ pages: Omit<Hit, "excerpt">[]; nextCursor: string | null }> {
  const res = await client.request(`/api/pages/recent${query}`);
  expect(res.status).toBe(200);
  return res.json();
}

describe("searchPages の LIKE（2 文字以下）", () => {
  // REST は匿名の短い語を 400 で拒むので、public に絞る LIKE の経路は直接呼んで確かめる
  it("public に絞ると draft を返さない", async () => {
    const client = await buildClient();
    const draft = await client.create("下書きのページ", "下書の本文");
    const open = await client.create("公開のページ", "これも下書の本文");
    await env.DB.prepare("UPDATE pages SET visibility = 'public' WHERE id = ?1")
      .bind(open.id)
      .run();
    expect((await searchPages(env.DB, "下書", 20, "public")).map((hit) => hit.id)).toEqual([
      open.id,
    ]);
    expect((await searchPages(env.DB, "下書", 20, "all")).map((hit) => hit.id).sort()).toEqual(
      [draft.id, open.id].sort(),
    );
  });
});

describe("GET /api/pages/recent", () => {
  it("更新日時の降順で、削除済みを除いて返す", async () => {
    const client = await buildClient();
    const a = await client.create("a");
    client.clock.now += 1000;
    const b = await client.create("b");
    client.clock.now += 1000;
    const c = await client.create("c");
    client.clock.now += 1000;
    await client.update(a, "a", "更新");
    await client.request(`/api/pages/${b.id}`, {
      method: "DELETE",
      headers: { "If-Match": '"1"' },
    });
    const body = await recent(client);
    expect(body.pages).toEqual([
      {
        id: a.id,
        title: "a",
        visibility: "draft",
        updatedAt: T0 + 3000,
        excerpt: "更新",
        tags: [],
      },
      // 本文が空のページは excerpt を返さない
      { id: c.id, title: "c", visibility: "draft", updatedAt: T0 + 2000, tags: [] },
    ]);
    expect(body.nextCursor).toBeNull();
  });

  it("cursor でページングし、同じ更新日時のページも取りこぼさない", async () => {
    const client = await buildClient();
    const created: PageJson[] = [];
    for (let i = 0; i < 5; i++) {
      // 3 件を同じ updated_at にして、id による順序づけを通す
      if (i % 2 === 0) client.clock.now += 1000;
      created.push(await client.create(`p${i}`));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let rounds = 0;
    do {
      const body = await recent(client, `?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`);
      expect(body.pages.length).toBeLessThanOrEqual(2);
      seen.push(...body.pages.map((page) => page.id));
      cursor = body.nextCursor;
      rounds++;
    } while (cursor !== null);
    expect(rounds).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
    const all = await recent(client);
    expect(all.pages.map((page) => page.id)).toEqual(seen);
    const times = all.pages.map((page) => page.updatedAt);
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });

  it("limit ちょうどで終わるときは nextCursor が null", async () => {
    const client = await buildClient();
    await client.create("a");
    await client.create("b");
    expect((await recent(client, "?limit=2")).nextCursor).toBeNull();
    expect((await recent(client, "?limit=1")).nextCursor).not.toBeNull();
  });

  it("limit と cursor の不正な値は 400", async () => {
    const client = await buildClient();
    for (const query of [
      "?limit=0",
      "?limit=101",
      "?limit=x",
      "?cursor=abc",
      "?cursor=1.short",
      "?cursor=",
    ]) {
      const res = await client.request(`/api/pages/recent${query}`);
      expect(res.status, query).toBe(400);
    }
    expect((await client.request("/api/pages/recent?limit=100")).status).toBe(200);
  });

  it("/api/pages/:id と重ならず、token が無ければ匿名として 200、read の token で 200", async () => {
    const reader = await buildClient({ scopes: "read", name: "reader" });
    expect((await withoutToken("/api/pages/recent")).status).toBe(200);
    expect((await reader.request("/api/pages/recent")).status).toBe(200);
    // :id の経路は従来どおり、形式の違う id を 404 にする
    expect((await reader.request("/api/pages/recen")).status).toBe(404);
    const writer = await buildClient();
    expect((await writer.request("/api/pages/recent", { method: "PUT" })).status).toBe(404);
    expect((await writer.request("/api/pages/recent", { method: "DELETE" })).status).toBe(404);
  });
});

describe("GET /api/pages/titles", () => {
  const titlesOf = async (client: Awaited<ReturnType<typeof buildClient>>, query = "") => {
    const res = await client.request(`/api/pages/titles${query}`);
    expect(res.status).toBe(200);
    return res.json<{ pages: Record<string, unknown>[]; nextCursor: string | null }>();
  };

  it("更新日時の降順で、削除済みを除き、id、title、visibility、updatedAt だけを返す", async () => {
    const client = await buildClient();
    const a = await client.create("a", "本文 #tag");
    client.clock.now += 1000;
    const b = await client.create("b");
    client.clock.now += 1000;
    const c = await client.create("c");
    client.clock.now += 1000;
    await client.update(a, "a", "更新");
    await client.request(`/api/pages/${b.id}`, {
      method: "DELETE",
      headers: { "If-Match": '"1"' },
    });
    expect(await titlesOf(client)).toEqual({
      pages: [
        { id: a.id, title: "a", visibility: "draft", updatedAt: T0 + 3000 },
        { id: c.id, title: "c", visibility: "draft", updatedAt: T0 + 2000 },
      ],
      nextCursor: null,
    });
  });

  it("recent と同じ順、同じ cursor でページングし、同じ更新日時のページも取りこぼさない", async () => {
    const client = await buildClient();
    for (let i = 0; i < 5; i++) {
      if (i % 2 === 0) client.clock.now += 1000;
      await client.create(`p${i}`);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let rounds = 0;
    do {
      const body = await titlesOf(client, `?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`);
      seen.push(...body.pages.map((page) => page.id as string));
      cursor = body.nextCursor;
      rounds++;
    } while (cursor !== null);
    expect(rounds).toBe(3);
    expect(seen).toEqual((await recent(client)).pages.map((page) => page.id));
    expect(new Set(seen).size).toBe(5);
    // 同じ位置からは recent の cursor でも続けられる
    const first = await titlesOf(client, "?limit=2");
    const viaRecent = await recent(client, `?limit=2&cursor=${first.nextCursor}`);
    const viaTitles = await titlesOf(client, `?limit=2&cursor=${first.nextCursor}`);
    expect(viaTitles.pages.map((page) => page.id)).toEqual(viaRecent.pages.map((page) => page.id));
  });

  it("limit ちょうどで終わるときは nextCursor が null", async () => {
    const client = await buildClient();
    await client.create("a");
    await client.create("b");
    expect((await titlesOf(client, "?limit=2")).nextCursor).toBeNull();
    expect((await titlesOf(client, "?limit=1")).nextCursor).not.toBeNull();
  });

  it("limit の上限は 500 で、超える値と不正な cursor は 400", async () => {
    const client = await buildClient();
    for (const query of ["?limit=0", "?limit=501", "?limit=x", "?cursor=abc", "?cursor="]) {
      const res = await client.request(`/api/pages/titles${query}`);
      expect(res.status, query).toBe(400);
    }
    const tooMany = await client.request("/api/pages/titles?limit=501");
    expect(await tooMany.json()).toEqual({ error: "invalid_field", field: "limit", max: 500 });
    expect((await client.request("/api/pages/titles?limit=500")).status).toBe(200);
  });

  it("limit を超える件数があれば、上限の件数で切って nextCursor を返す", async () => {
    const client = await buildClient();
    const now = client.clock.now;
    // 500 件を超える数を API で作ると遅いので、同じ形の行を SQL で直接入れる
    const rows = Array.from({ length: 501 }, (_, i) => i);
    await env.DB.prepare(
      `INSERT INTO pages (id, title, title_key, body, visibility, version, created_at, updated_at)
       SELECT printf('%022d', value), 'bulk ' || value, 'bulk ' || value, '', 'draft', 1, ?2, ?2 + value
       FROM json_each(?1)`,
    )
      .bind(JSON.stringify(rows), now)
      .run();
    const body = await titlesOf(client, "?limit=500");
    expect(body.pages).toHaveLength(500);
    expect(body.nextCursor).not.toBeNull();
    const rest = await titlesOf(client, `?limit=500&cursor=${body.nextCursor}`);
    expect(rest.pages).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
  });

  it("token が無ければ匿名として、read の token でも一覧を返し、書き込みは受けない", async () => {
    const reader = await buildClient({ scopes: "read", name: "reader" });
    const anonymous = await withoutToken("/api/pages/titles");
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toHaveProperty("pages");
    const read = await reader.request("/api/pages/titles");
    expect(read.status).toBe(200);
    expect(await read.json()).toHaveProperty("pages");
    const writer = await buildClient();
    expect((await writer.request("/api/pages/titles", { method: "PUT" })).status).toBe(404);
    expect((await writer.request("/api/pages/titles", { method: "DELETE" })).status).toBe(404);
  });
});

async function backlinks(client: Awaited<ReturnType<typeof buildClient>>, id: string, query = "") {
  return client.request(`/api/pages/${id}/backlinks${query}`);
}

async function backlinkTitles(client: Awaited<ReturnType<typeof buildClient>>, id: string) {
  const res = await backlinks(client, id);
  expect(res.status).toBe(200);
  return titles((await res.json<{ pages: Hit[] }>()).pages);
}

describe("GET /api/pages/:id/backlinks", () => {
  it("リンクしているページを更新の新しい順に返し、自分自身と無関係のページは含めない", async () => {
    const client = await buildClient();
    const target = await client.create("Target", "[[Target]] 自分へのリンク");
    const first = await client.create("first", "[[Target]]");
    client.clock.now += 1000;
    const second = await client.create("second", "前置き [[target]] 後ろ");
    await client.create("unrelated", "[[Other]]");
    const res = await backlinks(client, target.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pages: [
        { id: second.id, title: "second", visibility: "draft", updatedAt: T0 + 1000 },
        { id: first.id, title: "first", visibility: "draft", updatedAt: T0 },
      ],
      nextCursor: null,
    });
  });

  it("リンク先を後から作ると、先にあったリンクも backlink になる", async () => {
    const client = await buildClient();
    await client.create("source", "[[Later]]");
    const later = await client.create("Later");
    expect(await backlinkTitles(client, later.id)).toEqual(["source"]);
  });

  it("リンク元の本文からリンクを消すか、リンク元を削除すると外れる", async () => {
    const client = await buildClient();
    const target = await client.create("Target");
    const edited = await client.create("edited", "[[Target]]");
    client.clock.now += 1000;
    const removed = await client.create("removed", "[[Target]]");
    expect(await backlinkTitles(client, target.id)).toEqual(["removed", "edited"]);
    await client.update(edited, "edited", "リンクを消した");
    expect(await backlinkTitles(client, target.id)).toEqual(["removed"]);
    await client.request(`/api/pages/${removed.id}`, {
      method: "DELETE",
      headers: { "If-Match": '"1"' },
    });
    expect(await backlinkTitles(client, target.id)).toEqual([]);
  });

  it("リンク先を改題すると外れ、別のページがその title になると付け替わる", async () => {
    const client = await buildClient();
    const old = await client.create("Old", "旧");
    await client.create("source", "[[Old]]");
    expect(await backlinkTitles(client, old.id)).toEqual(["source"]);
    expect((await client.update(old, "New", "旧")).status).toBe(200);
    expect(await backlinkTitles(client, old.id)).toEqual([]);
    const next = await client.create("Next");
    expect(await backlinkTitles(client, next.id)).toEqual([]);
    const latest = await client.request(`/api/pages/${next.id}`);
    expect((await client.update(await latest.json<PageJson>(), "Old", "")).status).toBe(200);
    expect(await backlinkTitles(client, next.id)).toEqual(["source"]);
  });

  it("リンク先を削除すると 404 になり、同じ title で作り直したページには新しく付く", async () => {
    const client = await buildClient();
    const target = await client.create("Target");
    await client.create("source", "[[Target]]");
    await client.request(`/api/pages/${target.id}`, {
      method: "DELETE",
      headers: { "If-Match": '"1"' },
    });
    expect((await backlinks(client, target.id)).status).toBe(404);
    const again = await client.create("Target");
    expect(await backlinkTitles(client, again.id)).toEqual(["source"]);
  });

  it("cursor でページングする", async () => {
    const client = await buildClient();
    const target = await client.create("Target");
    for (let i = 0; i < 3; i++) {
      client.clock.now += 1000;
      await client.create(`s${i}`, "[[Target]]");
    }
    const first = await (await backlinks(client, target.id, "?limit=2")).json<{
      pages: Hit[];
      nextCursor: string;
    }>();
    expect(titles(first.pages)).toEqual(["s2", "s1"]);
    const second = await (
      await backlinks(client, target.id, `?limit=2&cursor=${first.nextCursor}`)
    ).json<{ pages: Hit[]; nextCursor: string | null }>();
    expect(titles(second.pages)).toEqual(["s0"]);
    expect(second.nextCursor).toBeNull();
    expect((await backlinks(client, target.id, "?cursor=bad")).status).toBe(400);
    expect((await backlinks(client, target.id, "?limit=101")).status).toBe(400);
  });

  it("無いページと形式の違う id は 404、token が無ければ匿名として 200", async () => {
    const client = await buildClient();
    for (const id of ["AAAAAAAAAAAAAAAAAAAAAA", "short", "recent"]) {
      expect((await backlinks(client, id)).status).toBe(404);
    }
    const page = await client.create("x");
    expect((await withoutToken(`/api/pages/${page.id}/backlinks`)).status).toBe(200);
    const reader = await buildClient({ scopes: "read", name: "reader" });
    expect((await backlinks(reader, page.id)).status).toBe(200);
  });
});

async function backlinksByTitle(
  client: Awaited<ReturnType<typeof buildClient>>,
  title: string,
  query = "",
) {
  return client.request(`/api/pages/by-title/backlinks?title=${encodeURIComponent(title)}${query}`);
}

async function backlinkTitlesByTitle(
  client: Awaited<ReturnType<typeof buildClient>>,
  title: string,
) {
  const res = await backlinksByTitle(client, title);
  expect(res.status).toBe(200);
  return titles((await res.json<{ pages: Hit[] }>()).pages);
}

describe("GET /api/pages/by-title/backlinks", () => {
  it("まだ無い title へのリンク元を、更新の新しい順に返す", async () => {
    const client = await buildClient();
    const first = await client.create("first", "[[Ruby]]");
    client.clock.now += 1000;
    const second = await client.create("second", "前置き [[Ruby]] 後ろ");
    await client.create("unrelated", "[[Python]]");
    const res = await backlinksByTitle(client, "Ruby");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pages: [
        { id: second.id, title: "second", visibility: "draft", updatedAt: T0 + 1000 },
        { id: first.id, title: "first", visibility: "draft", updatedAt: T0 },
      ],
      nextCursor: null,
    });
  });

  it("title は title_key の規則（大文字小文字、全角半角、前後と連続の空白）で引く", async () => {
    const client = await buildClient();
    await client.create("lower", "[[ruby  on rails]]");
    client.clock.now += 1000;
    await client.create("wide", "[[ＲＵＢＹ ON RAILS]]");
    for (const title of ["Ruby on Rails", " RUBY  ON  RAILS ", "ｒｕｂｙ on rails"]) {
      expect(await backlinkTitlesByTitle(client, title), title).toEqual(["wide", "lower"]);
    }
  });

  it("リンク先のページがあれば、そのページ自身は含めない", async () => {
    const client = await buildClient();
    await client.create("Target", "[[Target]] 自分へのリンク");
    await client.create("source", "[[target]]");
    expect(await backlinkTitlesByTitle(client, "TARGET")).toEqual(["source"]);
  });

  it("リンク元を削除すると外れる", async () => {
    const client = await buildClient();
    const source = await client.create("source", "[[Ruby]]");
    await client.request(`/api/pages/${source.id}`, {
      method: "DELETE",
      headers: { "If-Match": '"1"' },
    });
    expect(await backlinkTitlesByTitle(client, "Ruby")).toEqual([]);
  });

  it("cursor でページングし、title が無いか空なら 400", async () => {
    const client = await buildClient();
    for (let i = 0; i < 3; i++) {
      client.clock.now += 1000;
      await client.create(`s${i}`, "[[Ruby]]");
    }
    const first = await (await backlinksByTitle(client, "Ruby", "&limit=2")).json<{
      pages: Hit[];
      nextCursor: string;
    }>();
    expect(titles(first.pages)).toEqual(["s2", "s1"]);
    const second = await (
      await backlinksByTitle(client, "Ruby", `&limit=2&cursor=${first.nextCursor}`)
    ).json<{ pages: Hit[]; nextCursor: string | null }>();
    expect(titles(second.pages)).toEqual(["s0"]);
    expect(second.nextCursor).toBeNull();
    expect((await backlinksByTitle(client, "Ruby", "&cursor=bad")).status).toBe(400);
    expect((await backlinksByTitle(client, "Ruby", "&limit=101")).status).toBe(400);
    const missing = await client.request("/api/pages/by-title/backlinks");
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "missing_field", field: "title" });
    const blank = await backlinksByTitle(client, "  ");
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ error: "invalid_field", field: "title" });
  });

  it("token が無ければ匿名として 200、read の token でも引ける", async () => {
    const client = await buildClient();
    await client.create("x", "[[Ruby]]");
    const anonymous = await withoutToken(
      `/api/pages/by-title/backlinks?title=${encodeURIComponent("Ruby")}`,
    );
    expect(anonymous.status).toBe(200);
    const reader = await buildClient({ scopes: "read", name: "reader" });
    expect(await backlinkTitlesByTitle(reader, "Ruby")).toEqual(["x"]);
  });
});
