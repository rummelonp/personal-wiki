import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildClient, linksFrom, type PageJson, snapshotDb, tagsOf } from "../test/pages";

type Client = Awaited<ReturnType<typeof buildClient>>;

async function titlesOf(res: Response): Promise<string[]> {
  expect(res.status).toBe(200);
  return (await res.json<{ pages: { title: string }[] }>()).pages.map((p) => p.title).sort();
}

const byTitle = (client: Client, title: string) =>
  client.request(`/api/pages/by-title?title=${encodeURIComponent(title)}`);

describe("title_key は `_` と空白を同じ文字として扱う", () => {
  it("`a_b` があると `a b` は作れず、`a b` があると `a_b` も作れない", async () => {
    const client = await buildClient();
    await client.create("a_b");
    await client.create("C D");
    const before = await snapshotDb();
    for (const title of ["a b", "A  B", "c_d"]) {
      const res = await client.request("/api/pages", { method: "POST", json: { title, body: "" } });
      expect(res.status, title).toBe(409);
      expect(await res.json(), title).toMatchObject({ error: "title_conflict" });
    }
    expect(await snapshotDb()).toEqual(before);
  });

  it("`_` の数と端の `_` は区別する", async () => {
    const client = await buildClient();
    await client.create("a b");
    await client.create("__init__");
    for (const title of ["a__b", "init", "_init_"]) {
      expect((await client.create(title)).title).toBe(title);
    }
  });

  it("REST の title での取得と解決は、`_` と空白のどちらで引いても同じページを返す", async () => {
    const client = await buildClient();
    const spaced = await client.create("My Note");
    const snake = await client.create("snake_case");
    for (const [title, page] of [
      ["My_Note", spaced],
      ["my note", spaced],
      ["snake case", snake],
      ["SNAKE_CASE", snake],
    ] as const) {
      const res = await byTitle(client, title);
      expect(res.status, title).toBe(200);
      expect((await res.json<PageJson>()).id, title).toBe(page.id);
    }
    const resolved = await client.request(
      `/api/pages/resolve?title=${encodeURIComponent("My_Note")}&title=${encodeURIComponent("snake case")}`,
    );
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({
      results: [
        { title: "My_Note", page: { id: spaced.id, title: "My Note" } },
        { title: "snake case", page: { id: snake.id, title: "snake_case" } },
      ],
    });
  });

  it("`[[a_b]]` は `a b` のページへのリンクとして解決し、backlink に出る", async () => {
    const client = await buildClient();
    const target = await client.create("a b");
    const source = await client.create("source", "[[a_b]] と [[A B]] と [[a  b]]");
    expect(await linksFrom(source.id)).toEqual([{ key: "a b", target: target.id }]);
    expect(await titlesOf(await client.request(`/api/pages/${target.id}/backlinks`))).toEqual([
      "source",
    ]);
    for (const title of ["a_b", "a b"]) {
      const res = await client.request(
        `/api/pages/by-title/backlinks?title=${encodeURIComponent(title)}`,
      );
      expect(await titlesOf(res), title).toEqual(["source"]);
    }
  });

  it("まだ無い `a b` へのリンクは、後から `a_b` を作るとそのページに付く", async () => {
    const client = await buildClient();
    const source = await client.create("source", "[[a b]]");
    expect(await linksFrom(source.id)).toEqual([{ key: "a b", target: null }]);
    const target = await client.create("a_b");
    expect(await linksFrom(source.id)).toEqual([{ key: "a b", target: target.id }]);
  });

  it("空白を `_` にするだけの rename は title_key が変わらず、リンクの書き換えを積まない", async () => {
    const client = await buildClient();
    const target = await client.create("a b");
    await client.create("source", "[[a b]]");
    const res = await client.update(target, "a_b", "");
    expect(res.status).toBe(200);
    const { results } = await env.DB.prepare("SELECT count(*) AS n FROM link_rewrites").all();
    expect(results).toEqual([{ n: 0 }]);
    expect(await titlesOf(await client.request(`/api/pages/${target.id}/backlinks`))).toEqual([
      "source",
    ]);
  });

  it("タグの key は `_` を空白にしない", async () => {
    const client = await buildClient();
    const page = await client.create("tagged", "#snake_case");
    expect(await tagsOf(page.id)).toEqual([{ key: "snake_case", tag: "snake_case" }]);
    expect(await titlesOf(await client.request("/api/pages/recent?tag=snake_case"))).toEqual([
      "tagged",
    ]);
    expect(await titlesOf(await client.request("/api/pages/recent?tag=snake%20case"))).toEqual([]);
  });
});
