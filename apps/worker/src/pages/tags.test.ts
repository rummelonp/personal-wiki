import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { buildClient } from "../test/pages";

type Client = Awaited<ReturnType<typeof buildClient>>;

interface Listed {
  title: string;
  excerpt?: string;
  tags: string[];
}

async function recent(client: Client, query = ""): Promise<Listed[]> {
  const res = await client.request(`/api/pages/recent${query}`);
  expect(res.status).toBe(200);
  return (await res.json<{ pages: Listed[] }>()).pages;
}

const byTag = (client: Client, tag: string) => recent(client, `?tag=${encodeURIComponent(tag)}`);

const titles = (pages: { title: string }[]) => pages.map((page) => page.title).sort();

async function tagCounts(client: Client) {
  const res = await client.request("/api/tags");
  expect(res.status).toBe(200);
  return (await res.json<{ tags: { tag: string; count: number }[] }>()).tags;
}

describe("excerpt と tags", () => {
  it("recent は本文の先頭の抜粋と、タグの表記を tag_key の順に返す", async () => {
    const client = await buildClient();
    await client.create(
      "ノート",
      "---\ntags: [Zeta]\n---\n# 見出し\n\n**強調**と[[リンク|別名]]を含む本文。 #Beta #alpha",
    );
    const [page] = await recent(client);
    expect(page?.excerpt).toBe("見出し 強調と別名を含む本文。");
    expect(page?.tags).toEqual(["alpha", "Beta", "Zeta"]);
  });

  it("抜粋から行末のタグを除き、文の途中のタグと、タグだけの本文の扱いを分ける", async () => {
    const client = await buildClient();
    await client.create("末尾", "最初の段落。\n\n#メモ #使い方\n\n次の段落。 #日記");
    await client.create("途中", "今日は #メモ を書いた");
    await client.create("タグだけ", "#a #b");
    const pages = new Map((await recent(client)).map((p) => [p.title, p]));
    expect(pages.get("末尾")?.excerpt).toBe("最初の段落。 次の段落。");
    expect(pages.get("末尾")?.tags).toEqual(["メモ", "使い方", "日記"]);
    expect(pages.get("途中")?.excerpt).toBe("今日は #メモ を書いた");
    expect(pages.get("タグだけ")).not.toHaveProperty("excerpt");
    expect(pages.get("タグだけ")?.tags).toEqual(["a", "b"]);
  });

  it("抜粋から除いたタグの語でも検索でき、検索の抜粋は一致位置の周辺なのでタグが残る", async () => {
    const client = await buildClient();
    await client.create("メモ", "本文 #cloudflare");
    const res = await client.request("/api/search?q=cloudflare");
    const [hit] = (await res.json<{ results: (Listed & { excerpt: string })[] }>()).results;
    expect(hit?.title).toBe("メモ");
    expect(hit?.excerpt).toBe("本文 #cloudflare");
    expect((await recent(client))[0]?.excerpt).toBe("本文");
  });

  it("抜粋は 120 文字で切って省略記号を付け、全角の表記を畳まない", async () => {
    const client = await buildClient();
    await client.create("長い", `Ａ${"あ".repeat(200)}`);
    await client.create("短い", "（短い本文）");
    await client.create("絵文字", "😀".repeat(130));
    const excerpts = new Map((await recent(client)).map((p) => [p.title, p.excerpt]));
    expect(excerpts.get("長い")).toBe(`Ａ${"あ".repeat(119)}…`);
    expect(excerpts.get("短い")).toBe("（短い本文）");
    expect(excerpts.get("絵文字")).toBe(`${"😀".repeat(120)}…`);
  });

  it("更新で抜粋とタグが入れ替わり、削除で消える", async () => {
    const client = await buildClient();
    const page = await client.create("p", "最初の本文 #old");
    await client.update(page, "p", "次の本文 #new");
    expect(await recent(client)).toEqual([
      {
        id: page.id,
        title: "p",
        visibility: "draft",
        updatedAt: expect.any(Number),
        excerpt: "次の本文",
        tags: ["new"],
      },
    ]);
    await client.request(`/api/pages/${page.id}`, {
      method: "DELETE",
      headers: { "If-Match": '"2"' },
    });
    const { results } = await env.DB.prepare("SELECT * FROM page_excerpts").all();
    expect(results).toEqual([]);
  });

  it("抜粋の行が無い古いページは excerpt を省き、rebuild で埋まる", async () => {
    const client = await buildClient();
    await client.create("old", "古い本文 #t");
    await env.DB.prepare("DELETE FROM page_excerpts").run();
    expect(await recent(client)).toEqual([
      expect.not.objectContaining({ excerpt: expect.anything() }),
    ]);
    await client.request("/api/admin/derived/rebuild", { method: "POST", json: { after: null } });
    expect((await recent(client))[0]?.excerpt).toBe("古い本文");
  });

  it("search の各件にもタグを付け、抜粋は一致位置の周辺のまま（FTS と LIKE の両方）", async () => {
    const client = await buildClient();
    await client.create("料理", `${"前置き。".repeat(30)}隠し味はチョコ。 #料理 #Food`);
    for (const q of ["隠し味", "チョ"]) {
      const res = await client.request(`/api/search?q=${encodeURIComponent(q)}`);
      const [hit] = (await res.json<{ results: (Listed & { excerpt: string })[] }>()).results;
      expect(hit?.tags, q).toEqual(["Food", "料理"]);
      expect(hit?.excerpt, q).toContain(q);
      expect(hit?.excerpt.startsWith("…"), q).toBe(true);
    }
  });
});

describe("GET /api/pages/recent?tag=", () => {
  it("表記の大文字小文字、全角半角、先頭の # を畳んで絞り込む", async () => {
    const client = await buildClient();
    await client.create("a", "#Project");
    await client.create("b", "#other");
    for (const tag of [
      "project",
      "PROJECT",
      "Ｐroject",
      "#project",
      " #project",
      "＃project",
      " Project ",
    ]) {
      expect(titles(await byTag(client, tag)), tag).toEqual(["a"]);
    }
    expect(await byTag(client, "none")).toEqual([]);
    // 剥がす `#` は 1 つだけ。残りは key の一部になり、どのタグにも一致しない
    expect(await byTag(client, "##project")).toEqual([]);
  });

  it("長さの上限は畳んだ後の key で判定し、ちょうど 200 字は通る", async () => {
    const client = await buildClient();
    await client.create("long", `#${"a".repeat(200)}`);
    expect(titles(await byTag(client, "a".repeat(200)))).toEqual(["long"]);
    expect((await client.request(`/api/pages/recent?tag=${"a".repeat(201)}`)).status).toBe(400);
    // `㌀` は NFKC で 4 文字になるので、51 字で 204 字の key になる
    expect(
      (await client.request(`/api/pages/recent?tag=${encodeURIComponent("㌀".repeat(51))}`)).status,
    ).toBe(400);
    expect(
      (await client.request(`/api/pages/recent?tag=${encodeURIComponent("㌀".repeat(50))}`)).status,
    ).toBe(200);
  });

  it("親のタグで子のタグのページも拾い、前置きが同じだけの別のタグは拾わない", async () => {
    const client = await buildClient();
    await client.create("parent", "#work");
    await client.create("child", "#work/Project");
    await client.create("grandchild", "#work/project/a");
    await client.create("both", "#work/a #work/b");
    await client.create("hyphen", "#work-log");
    await client.create("digit", "#work0 と #workx");
    await client.create("other", "#home/work");
    expect(titles(await byTag(client, "work"))).toEqual(["both", "child", "grandchild", "parent"]);
    expect(titles(await byTag(client, "Work/Project"))).toEqual(["child", "grandchild"]);
    expect(titles(await byTag(client, "work/project/a"))).toEqual(["grandchild"]);
    expect(titles(await byTag(client, "work/proj"))).toEqual([]);
  });

  it("cursor と併用でき、複数のタグを持つページは 1 件にまとまる", async () => {
    const client = await buildClient();
    for (let i = 0; i < 3; i++) {
      client.clock.now += 1000;
      await client.create(`p${i}`, "#t/a #t/b");
    }
    const first = await (await client.request("/api/pages/recent?tag=t&limit=2")).json<{
      pages: Listed[];
      nextCursor: string;
    }>();
    expect(first.pages.map((page) => page.title)).toEqual(["p2", "p1"]);
    const second = await (
      await client.request(`/api/pages/recent?tag=t&limit=2&cursor=${first.nextCursor}`)
    ).json<{ pages: Listed[]; nextCursor: string | null }>();
    expect(second.pages.map((page) => page.title)).toEqual(["p0"]);
    expect(second.nextCursor).toBeNull();
  });

  it("空や長すぎる tag は 400", async () => {
    const client = await buildClient();
    for (const tag of ["", "%20", "%23", "a".repeat(201)]) {
      const res = await client.request(`/api/pages/recent?tag=${tag}`);
      expect(res.status, tag).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_field", field: "tag" });
    }
  });
});

describe("GET /api/tags", () => {
  it("件数の降順、同数は表記を畳んだ順で、ネストの親の件数に子のページを含む", async () => {
    const client = await buildClient();
    await client.create("1", "#beta #work");
    await client.create("2", "#Beta #work/a");
    await client.create("3", "#alpha #work/a #work/b");
    await client.create("4", "#Apple");
    expect(await tagCounts(client)).toEqual([
      { tag: "work", count: 3 },
      { tag: "Beta", count: 2 },
      { tag: "work/a", count: 2 },
      { tag: "alpha", count: 1 },
      { tag: "Apple", count: 1 },
      { tag: "work/b", count: 1 },
    ]);
    // 一覧の件数は、同じ表記で絞り込んだときの件数と一致する
    for (const { tag, count } of await tagCounts(client)) {
      expect((await byTag(client, tag)).length, tag).toBe(count);
    }
  });

  it("削除したページのタグは数えず、タグが無ければ空", async () => {
    const client = await buildClient();
    expect(await tagCounts(client)).toEqual([]);
    const page = await client.create("x", "#gone");
    await client.request(`/api/pages/${page.id}`, {
      method: "DELETE",
      headers: { "If-Match": '"1"' },
    });
    expect(await tagCounts(client)).toEqual([]);
  });

  it("匿名には、tags の行が残ったまま削除済みになった public のページのタグを出さない", async () => {
    const client = await buildClient();
    const kept = await client.create("kept", "#alive");
    const gone = await client.create("gone", "#alive #ghost");
    // 削除の経路は tags の行も消すので、行を残した状態は SQL で直接作る
    await env.DB.batch([
      env.DB.prepare("UPDATE pages SET visibility = 'public' WHERE id IN (?1, ?2)").bind(
        kept.id,
        gone.id,
      ),
      env.DB.prepare("UPDATE pages SET deleted_at = ?2, deleted_by = 'owner' WHERE id = ?1").bind(
        gone.id,
        client.clock.now,
      ),
    ]);
    const res = await createApp().request("/api/tags", {}, env);
    expect(await res.json()).toEqual({ tags: [{ tag: "alive", count: 1 }] });
  });

  it("token が無ければ匿名として 200、read の token で 200", async () => {
    const reader = await buildClient({ scopes: "read", name: "reader" });
    expect((await createApp().request("/api/tags", {}, env)).status).toBe(200);
    expect((await reader.request("/api/tags")).status).toBe(200);
  });
});
