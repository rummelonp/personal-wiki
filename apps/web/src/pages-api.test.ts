import { describe, expect, it } from "vitest";
import {
  createPage,
  deletePage,
  getPage,
  listBacklinks,
  listRecent,
  listTags,
  searchPages,
  setVisibility,
  updatePage,
} from "./pages-api";

const ID = "AAAAAAAAAAAAAAAAAAAAAA";
const PAGE = {
  id: ID,
  title: "題",
  body: "本文",
  visibility: "draft",
  version: 3,
  createdAt: 1,
  updatedAt: 2,
};

type Call = { path: string; init: RequestInit };

function recorder(respond: () => Response) {
  const calls: Call[] = [];
  const fetchFn = async (path: string, init: RequestInit = {}) => {
    calls.push({ path, init });
    return respond();
  };
  return { calls, fetchFn };
}

const headersOf = (call: Call | undefined) => (call?.init.headers ?? {}) as Record<string, string>;

describe("変更系の要求", () => {
  it("PUT は If-Match に版を付け、JSON の Content-Type で送る", async () => {
    const { calls, fetchFn } = recorder(() => Response.json(PAGE));
    const res = await updatePage(ID, 3, { title: "題", body: "新" }, {}, fetchFn);
    expect(res.ok).toBe(true);
    expect(calls[0]?.path).toBe(`/api/pages/${ID}`);
    expect(calls[0]?.init).toMatchObject({
      method: "PUT",
      credentials: "same-origin",
      body: JSON.stringify({ title: "題", body: "新" }),
    });
    expect(headersOf(calls[0])).toEqual({ "Content-Type": "application/json", "If-Match": '"3"' });
    expect(calls[0]?.init.keepalive).toBe(false);
  });

  it("keepalive は本文が 60 KB 以下のときだけ付ける", async () => {
    const { calls, fetchFn } = recorder(() => Response.json(PAGE));
    await updatePage(ID, 3, { title: "t", body: "a" }, { keepalive: true }, fetchFn);
    await updatePage(ID, 3, { title: "t", body: "a".repeat(61_000) }, { keepalive: true }, fetchFn);
    expect(calls[0]?.init.keepalive).toBe(true);
    expect(calls[1]?.init.keepalive).toBe(false);
  });

  it("visibility は If-Match 付きの JSON で送る", async () => {
    const { calls, fetchFn } = recorder(() => Response.json({ ...PAGE, visibility: "public" }));
    const res = await setVisibility(ID, 3, "public", fetchFn);
    expect(res.ok && res.value.visibility).toBe("public");
    expect(calls[0]?.path).toBe(`/api/pages/${ID}/visibility`);
    expect(calls[0]?.init.body).toBe('{"visibility":"public"}');
    expect(headersOf(calls[0])).toMatchObject({ "If-Match": '"3"' });
  });

  it("DELETE も JSON の Content-Type と本文 {} と If-Match を付ける", async () => {
    const { calls, fetchFn } = recorder(() => new Response(null, { status: 204 }));
    expect((await deletePage(ID, 3, fetchFn)).ok).toBe(true);
    expect(calls[0]?.init).toMatchObject({ method: "DELETE", body: "{}" });
    expect(headersOf(calls[0])).toEqual({ "Content-Type": "application/json", "If-Match": '"3"' });
  });

  it("作成は draft の本文を空で送る", async () => {
    const { calls, fetchFn } = recorder(() => Response.json(PAGE, { status: 201 }));
    expect((await createPage({ title: "題", body: "" }, fetchFn)).ok).toBe(true);
    expect(calls[0]?.init).toMatchObject({ method: "POST" });
  });
});

describe("失敗の分類", () => {
  const failing = (status: number, body: unknown) =>
    recorder(() => Response.json(body, { status }));

  it("401 は unauthorized", async () => {
    const { fetchFn } = failing(401, { error: "unauthorized" });
    expect(await getPage(ID, fetchFn)).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("404 は not_found", async () => {
    const { fetchFn } = failing(404, { error: "not_found" });
    expect(await getPage(ID, fetchFn)).toEqual({ ok: false, reason: "not_found" });
  });

  it("409 は version_conflict と title_conflict を区別する", async () => {
    const version = failing(409, { error: "version_conflict", currentVersion: 5 });
    expect(await updatePage(ID, 3, { title: "a", body: "" }, {}, version.fetchFn)).toEqual({
      ok: false,
      reason: "version_conflict",
      currentVersion: 5,
    });
    const title = failing(409, { error: "title_conflict" });
    expect(await createPage({ title: "a", body: "" }, title.fetchFn)).toMatchObject({
      ok: false,
      reason: "title_conflict",
    });
  });

  it("通信の失敗と形の違う応答は error にする", async () => {
    const offline = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await getPage(ID, offline)).toMatchObject({ ok: false, reason: "error" });
    const odd = failing(200, { id: ID });
    expect(await getPage(ID, odd.fetchFn)).toMatchObject({ ok: false, reason: "error" });
  });

  it("サーバーの message を表示用に使う", async () => {
    const { fetchFn } = failing(400, { error: "invalid_field", field: "q", message: "検索語が空" });
    expect(await searchPages("a", fetchFn)).toMatchObject({ ok: false, message: "検索語が空" });
  });
});

describe("一覧と検索", () => {
  it("最近の更新は cursor をクエリに載せる", async () => {
    const { calls, fetchFn } = recorder(() => Response.json({ pages: [], nextCursor: null }));
    await listRecent(null, {}, fetchFn);
    await listRecent(`1.${ID}`, {}, fetchFn);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/pages/recent",
      `/api/pages/recent?cursor=${encodeURIComponent(`1.${ID}`)}`,
    ]);
  });

  it("タグで絞るときは tag をクエリに載せる", async () => {
    const { calls, fetchFn } = recorder(() => Response.json({ pages: [], nextCursor: null }));
    await listRecent(null, { tag: "日記 a" }, fetchFn);
    expect(calls[0]?.path).toBe("/api/pages/recent?tag=%E6%97%A5%E8%A8%98+a");
  });

  it("件数を指定するときは limit をクエリに載せる", async () => {
    const { calls, fetchFn } = recorder(() => Response.json({ pages: [], nextCursor: null }));
    await listRecent(`1.${ID}`, { limit: 100 }, fetchFn);
    expect(calls[0]?.path).toBe(
      `/api/pages/recent?cursor=${encodeURIComponent(`1.${ID}`)}&limit=100`,
    );
  });

  it("最近の更新は tags が必須で、excerpt は省略できる", async () => {
    const entry = { id: ID, title: "題", visibility: "draft", updatedAt: 1 };
    const respond = (pages: unknown[]) =>
      recorder(() => Response.json({ pages, nextCursor: null })).fetchFn;
    expect(await listRecent(null, {}, respond([{ ...entry, tags: ["a"] }]))).toMatchObject({
      ok: true,
    });
    expect(
      await listRecent(null, {}, respond([{ ...entry, tags: [], excerpt: "先頭" }])),
    ).toMatchObject({ ok: true });
    expect(await listRecent(null, {}, respond([entry]))).toMatchObject({
      ok: false,
      reason: "error",
    });
    expect(await listRecent(null, {}, respond([{ ...entry, tags: [1] }]))).toMatchObject({
      ok: false,
    });
    expect(await listRecent(null, {}, respond([{ ...entry, tags: [], excerpt: 1 }]))).toMatchObject(
      { ok: false },
    );
  });

  it("被リンクは tags なしの要約のままで通る", async () => {
    const { fetchFn } = recorder(() =>
      Response.json({
        pages: [{ id: ID, title: "題", visibility: "draft", updatedAt: 1 }],
        nextCursor: null,
      }),
    );
    expect(await listBacklinks(ID, null, fetchFn)).toMatchObject({ ok: true });
  });

  it("タグの一覧を読む", async () => {
    const { calls, fetchFn } = recorder(() => Response.json({ tags: [{ tag: "a", count: 2 }] }));
    expect(await listTags(fetchFn)).toEqual({ ok: true, value: [{ tag: "a", count: 2 }] });
    expect(calls[0]?.path).toBe("/api/tags");
    const missing = recorder(() => new Response("{}", { status: 404 }));
    expect(await listTags(missing.fetchFn)).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("検索結果は excerpt と tags が必須", async () => {
    const hit = { id: ID, title: "題", visibility: "draft", updatedAt: 1 };
    const respond = (results: unknown[]) => recorder(() => Response.json({ results })).fetchFn;
    expect(await searchPages("a", respond([{ ...hit, excerpt: "…a…", tags: [] }]))).toMatchObject({
      ok: true,
    });
    expect(await searchPages("a", respond([{ ...hit, tags: [] }]))).toMatchObject({ ok: false });
    expect(await searchPages("a", respond([{ ...hit, excerpt: "…a…" }]))).toMatchObject({
      ok: false,
    });
  });

  it("検索語はエンコードして渡す", async () => {
    const { calls, fetchFn } = recorder(() => Response.json({ results: [] }));
    await searchPages("a&b 検索", fetchFn);
    expect(calls[0]?.path).toBe(`/api/search?q=${encodeURIComponent("a&b 検索")}&limit=50`);
  });
});
