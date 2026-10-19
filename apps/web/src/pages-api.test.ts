import { describe, expect, it } from "vitest";
import {
  createPage,
  deletePage,
  getPage,
  getRevision,
  listBacklinks,
  listBacklinksByTitle,
  listPageTitles,
  listRecent,
  listRevisions,
  listTags,
  RESOLVE_MAX_TITLES,
  RESOLVE_MAX_URL_LENGTH,
  resolvePages,
  searchPages,
  setVisibility,
  splitResolveBatches,
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

describe("変更系のリクエスト", () => {
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

  it("PUT のレスポンスのリンクの書き換えの数を、形を確かめて返す", async () => {
    const queued = await updatePage(ID, 3, { title: "新", body: "" }, {}, async () =>
      Response.json({ ...PAGE, linkRewrites: { queued: 2 } }),
    );
    expect(queued).toEqual({ ok: true, value: { ...PAGE, linkRewrites: { queued: 2 } } });
    const skipped = await updatePage(ID, 3, { title: "新#", body: "" }, {}, async () =>
      Response.json({ ...PAGE, linkRewrites: { queued: 0, skipped: "unsafe_title" } }),
    );
    expect(skipped.ok && skipped.value.linkRewrites).toEqual({
      queued: 0,
      skipped: "unsafe_title",
    });
    const malformed = await updatePage(ID, 3, { title: "新", body: "" }, {}, async () =>
      Response.json({ ...PAGE, linkRewrites: { queued: "2" } }),
    );
    expect(malformed).toEqual({ ok: true, value: PAGE });
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
    expect(await createPage({ title: "a", body: "" }, title.fetchFn)).toEqual({
      ok: false,
      reason: "title_conflict",
      message: "同じタイトルのページがすでにあります。",
    });
  });

  it("title_conflict の既存のページは、形を確かめて添える", async () => {
    const existing = { id: ID, title: "Ａ", visibility: "public" };
    const found = failing(409, { error: "title_conflict", existing, message: "常体の文" });
    expect(await updatePage(ID, 3, { title: "a", body: "" }, {}, found.fetchFn)).toMatchObject({
      reason: "title_conflict",
      existing,
    });
    const odd = failing(409, { error: "title_conflict", existing: { id: ID } });
    const res = await updatePage(ID, 3, { title: "a", body: "" }, {}, odd.fetchFn);
    expect(res).toMatchObject({ reason: "title_conflict" });
    expect(res).not.toHaveProperty("existing");
  });

  it("通信の失敗と形の違うレスポンスは error にする", async () => {
    const offline = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await getPage(ID, offline)).toMatchObject({ ok: false, reason: "error" });
    const odd = failing(200, { id: ID });
    expect(await getPage(ID, odd.fetchFn)).toMatchObject({ ok: false, reason: "error" });
  });

  it("5xx と通信の失敗は、画面向けの文で次の手を伝える", async () => {
    const server = failing(500, { error: "internal" });
    expect(await getPage(ID, server.fetchFn)).toMatchObject({
      ok: false,
      message: "wiki の側で問題が起きました（HTTP 500）。時間をおいて、もう一度試してください。",
    });
    const offline = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await getPage(ID, offline)).toMatchObject({
      message: "接続できません。通信を確かめて、もう一度試してください。",
    });
  });

  it("長さの超過は入力のエラーにし、レスポンスの今の値と上限で画面の文を作る", async () => {
    const title = failing(400, {
      error: "title_too_long",
      field: "title",
      max: 1024,
      actual: 1530,
      unit: "utf8_bytes",
      message: "title が長すぎる",
    });
    expect(await updatePage(ID, 1, { title: "a", body: "" }, {}, title.fetchFn)).toEqual({
      ok: false,
      reason: "invalid_input",
      problem: { reason: "title_too_long", bytes: 1530, max: 1024 },
      message: "タイトルが上限を506バイト超えています。短くしてください。",
    });
    const body = failing(413, {
      error: "body_too_large",
      field: "body",
      max: 65536,
      actual: 65612,
    });
    expect(await createPage({ title: "a", body: "" }, body.fetchFn)).toMatchObject({
      reason: "invalid_input",
      problem: { reason: "body_too_large", bytes: 65612, max: 65536 },
      message: expect.stringContaining("本文が上限を76バイト超えています。"),
    });
  });

  it("今の値の無い超過のレスポンスは、送った内容と domain の上限で補う", async () => {
    const title = failing(400, { error: "title_too_long" });
    const long = "あ".repeat(400);
    expect(await updatePage(ID, 1, { title: long, body: "" }, {}, title.fetchFn)).toMatchObject({
      reason: "invalid_input",
      problem: { reason: "title_too_long", bytes: 1200, max: 1024 },
    });
    // Content-Length で断った 413。送った本文が上限以下なら、長さの文を作らない
    const sized = failing(413, { error: "body_too_large", max: 65536 });
    expect(await updatePage(ID, 1, { title: "a", body: "短い" }, {}, sized.fetchFn)).toEqual({
      ok: false,
      reason: "invalid_input",
      problem: null,
      message: "本文が大きすぎて保存できません。本文を短くするか、ページを分けてください。",
    });
  });

  it("制御文字のエラーは、送った内容から位置を求め直し、再読み込みではなく消すよう伝える", async () => {
    const titled = failing(400, {
      error: "invalid_field",
      field: "title",
      reason: "control_char",
      line: 1,
      column: 3,
      codePoint: "U+0001",
    });
    const title = await updatePage(ID, 1, { title: "ab\u0001", body: "" }, {}, titled.fetchFn);
    expect(title).toMatchObject({
      reason: "invalid_input",
      problem: { reason: "control_char", field: "title", at: { index: 2, column: 3 } },
      message: expect.stringContaining("タイトルの3文字目"),
    });
    const nul = failing(400, { error: "invalid_field", field: "body", reason: "control_char" });
    const body = await createPage({ title: "a", body: "1\n2\u0000" }, nul.fetchFn);
    expect(body).toMatchObject({
      reason: "invalid_input",
      problem: { reason: "control_char", field: "body", at: { index: 3, line: 2 } },
      message: expect.stringContaining("本文の2行目"),
    });
    for (const res of [title, body]) expect(JSON.stringify(res)).not.toContain("再読み込み");
  });

  it("送った内容に制御文字の位置を求められなければ、位置の無い文で消すよう伝える", async () => {
    const titled = failing(400, { error: "invalid_field", field: "title", reason: "control_char" });
    expect(await updatePage(ID, 1, { title: "ab", body: "" }, {}, titled.fetchFn)).toEqual({
      ok: false,
      reason: "invalid_input",
      problem: null,
      message: "タイトルに見えない文字が入っていて保存できません。その文字を消してください。",
    });
    const nul = failing(400, { error: "invalid_field", field: "body", reason: "control_char" });
    expect(await createPage({ title: "a", body: "本文" }, nul.fetchFn)).toEqual({
      ok: false,
      reason: "invalid_input",
      problem: null,
      message: "本文に見えない文字（NUL）が入っていて保存できません。その文字を消してください。",
    });
  });

  it("入力のエラーは書き込みのレスポンスでだけ読む", async () => {
    const { fetchFn } = failing(400, { error: "title_too_long", message: "常体" });
    expect(await getPage(ID, fetchFn)).toMatchObject({ reason: "error" });
  });

  it("タグの指定のエラーは、再読み込みを勧めず上限を伝える", async () => {
    const long = failing(400, {
      error: "invalid_field",
      field: "tag",
      reason: "too_long",
      max: 200,
    });
    expect(await listRecent(null, { tag: "x" }, long.fetchFn)).toEqual({
      ok: false,
      reason: "error",
      message: "タグが長すぎます（200文字まで）。タグを選び直してください。",
    });
    const empty = failing(400, { error: "invalid_field", field: "tag", reason: "empty" });
    const res = await listRecent(null, { tag: "#" }, empty.fetchFn);
    expect(res).toMatchObject({ reason: "error", message: expect.stringContaining("タグが空") });
    expect(JSON.stringify(res)).not.toContain("再読み込み");
  });

  it("429 は障害ではなく混雑による制限と読める文で、少し待つよう伝える", async () => {
    const { fetchFn } = failing(429, {});
    expect(await getPage(ID, fetchFn)).toMatchObject({
      ok: false,
      message: "一時的にアクセスが制限されています。少し待ってから、もう一度試してください。",
    });
  });

  it("5xx は番号を添えて、時間をおくよう伝える", async () => {
    const { fetchFn } = failing(503, {});
    expect(await getPage(ID, fetchFn)).toMatchObject({
      ok: false,
      message: "wiki の側で問題が起きました（HTTP 503）。時間をおいて、もう一度試してください。",
    });
  });

  it("その他の 4xx は、待っても変わらないので再読み込みを勧める", async () => {
    const { fetchFn } = failing(403, {});
    expect(await getPage(ID, fetchFn)).toMatchObject({
      ok: false,
      message:
        "操作を受け付けられませんでした（HTTP 403）。ページを再読み込みしてから、もう一度試してください。",
    });
  });

  it("リクエストの形のエラーは、サーバーの message より固定の文にする", async () => {
    const { fetchFn } = failing(400, {
      error: "invalid_field",
      field: "limit",
      message: "limit が正しくない",
    });
    expect(await getPage(ID, fetchFn)).toMatchObject({
      ok: false,
      message:
        "操作を受け付けられませんでした。ページを再読み込みしてから、もう一度試してください。",
    });
  });

  it("未知の code は、サーバーの message を出さず status の文にする", async () => {
    const { fetchFn } = failing(400, { error: "something_new", message: "新しい誤り" });
    expect(await getPage(ID, fetchFn)).toMatchObject({
      ok: false,
      message:
        "操作を受け付けられませんでした（HTTP 400）。ページを再読み込みしてから、もう一度試してください。",
    });
  });

  it("検索語のエラーは、サーバーの常体の message ではなく、直す点を示す固定の文にする", async () => {
    const tooLong = failing(400, {
      error: "invalid_field",
      field: "q",
      reason: "too_long",
      message: "検索語が長すぎる（上限 200 文字）",
    });
    expect(await searchPages("a", tooLong.fetchFn)).toEqual({
      ok: false,
      reason: "invalid_query",
      message: "検索語が長すぎます。200文字以内にしてください。",
    });
    const unknown = failing(400, { error: "invalid_field", field: "q" });
    expect(await searchPages("a", unknown.fetchFn)).toMatchObject({
      reason: "invalid_query",
      message: "別の検索語を試してください。",
    });
    const short = failing(400, { error: "query_too_short", field: "q", min: 3 });
    expect(await searchPages("a", short.fetchFn)).toMatchObject({
      reason: "invalid_query",
      message: "検索語が短すぎます。3文字以上にしてください。",
    });
    const noMin = failing(400, { error: "query_too_short", field: "q" });
    expect(await searchPages("a", noMin.fetchFn)).toMatchObject({
      reason: "invalid_query",
      message: "検索語が短すぎます。語を足してください。",
    });
  });

  it("検索の 5xx は、語のエラーにせず取得の失敗にする", async () => {
    const { fetchFn } = failing(500, { error: "internal" });
    expect(await searchPages("abc", fetchFn)).toMatchObject({ ok: false, reason: "error" });
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

  it("並びは既定（更新日時）と違うときだけ sort をクエリに載せる", async () => {
    const { calls, fetchFn } = recorder(() => Response.json({ pages: [], nextCursor: null }));
    await listRecent(null, { sort: "updated" }, fetchFn);
    await listRecent(null, { sort: "created" }, fetchFn);
    await listRecent("tYQ", { tag: "x", sort: "title" }, fetchFn);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/pages/recent",
      "/api/pages/recent?sort=created",
      "/api/pages/recent?sort=title&cursor=tYQ&tag=x",
    ]);
  });

  it("件数を指定するときは limit をクエリに載せる", async () => {
    const { calls, fetchFn } = recorder(() => Response.json({ pages: [], nextCursor: null }));
    await listRecent(`1.${ID}`, { limit: 100 }, fetchFn);
    expect(calls[0]?.path).toBe(
      `/api/pages/recent?cursor=${encodeURIComponent(`1.${ID}`)}&limit=100`,
    );
  });

  it("title の一覧は上限の件数で引き、cursor をクエリに載せる", async () => {
    const page = { id: ID, title: "題", visibility: "draft", updatedAt: 1 };
    const { calls, fetchFn } = recorder(() => Response.json({ pages: [page], nextCursor: null }));
    expect(await listPageTitles(null, fetchFn)).toEqual({
      ok: true,
      value: { pages: [page], nextCursor: null },
    });
    await listPageTitles(`1.${ID}`, fetchFn);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/pages/titles?limit=500",
      `/api/pages/titles?limit=500&cursor=${encodeURIComponent(`1.${ID}`)}`,
    ]);
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
    expect(
      await listRecent(null, {}, respond([{ ...entry, tags: [], createdAt: 1 }])),
    ).toMatchObject({ ok: true });
    expect(
      await listRecent(null, {}, respond([{ ...entry, tags: [], createdAt: "1" }])),
    ).toMatchObject({ ok: false });
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

  it("title の被リンクは title と cursor をクエリで送る", async () => {
    const { calls, fetchFn } = recorder(() =>
      Response.json({
        pages: [{ id: ID, title: "題", visibility: "public", updatedAt: 1 }],
        nextCursor: "1.x",
      }),
    );
    expect(await listBacklinksByTitle("a/b #c", null, fetchFn)).toEqual({
      ok: true,
      value: {
        pages: [{ id: ID, title: "題", visibility: "public", updatedAt: 1 }],
        nextCursor: "1.x",
      },
    });
    expect(await listBacklinksByTitle("Ruby", "1.x", fetchFn)).toMatchObject({ ok: true });
    expect(calls.map((call) => call.path)).toEqual([
      "/api/pages/by-title/backlinks?title=a%2Fb%20%23c",
      "/api/pages/by-title/backlinks?title=Ruby&cursor=1.x",
    ]);
  });

  it("タグの一覧を読む", async () => {
    const { calls, fetchFn } = recorder(() => Response.json({ tags: [{ tag: "a", count: 2 }] }));
    expect(await listTags({}, fetchFn)).toEqual({ ok: true, value: [{ tag: "a", count: 2 }] });
    await listTags({ visibility: "" }, fetchFn);
    await listTags({ visibility: "draft" }, fetchFn);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/tags",
      "/api/tags",
      "/api/tags?visibility=draft",
    ]);
    const missing = recorder(() => new Response("{}", { status: 404 }));
    expect(await listTags({}, missing.fetchFn)).toMatchObject({ ok: false, reason: "not_found" });
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

describe("resolvePages", () => {
  const found = { id: ID, title: "Note", visibility: "draft" };

  it("title を encode して repeated query で渡し、同じ順で page か null を返す", async () => {
    const { calls, fetchFn } = recorder(() =>
      Response.json({
        results: [
          { title: "a&b #1", page: found },
          { title: "無い", page: null },
        ],
      }),
    );
    const res = await resolvePages(["a&b #1", "無い"], fetchFn);
    expect(res).toEqual({ ok: true, value: [found, null] });
    expect(calls[0]?.path).toBe(
      `/api/pages/resolve?title=${encodeURIComponent("a&b #1")}&title=${encodeURIComponent("無い")}`,
    );
    expect(calls[0]?.init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  });

  it("404、5xx、通信の失敗、形の違いは、存在しない（null）ではなく失敗にする", async () => {
    // Worker を前の版に戻すと resolve が /api/pages/:id に落ちて 404 になる
    for (const status of [404, 500, 503]) {
      const { fetchFn } = recorder(() => new Response("{}", { status }));
      expect((await resolvePages(["a"], fetchFn)).ok).toBe(false);
    }
    const offline = async () => {
      throw new TypeError("offline");
    };
    expect(await resolvePages(["a"], offline)).toMatchObject({ ok: false, reason: "error" });
    for (const body of [
      {},
      { results: [] },
      { results: [{ title: "a", page: { id: 1 } }] },
      {
        results: [
          { title: "a", page: found },
          { title: "b", page: null },
        ],
      },
    ]) {
      const { fetchFn } = recorder(() => Response.json(body));
      expect((await resolvePages(["a"], fetchFn)).ok).toBe(false);
    }
  });
});

describe("splitResolveBatches", () => {
  const urlLength = (titles: string[]) =>
    `/api/pages/resolve?${titles.map((t) => `title=${encodeURIComponent(t)}`).join("&")}`.length;

  it("Worker の上限の件数で分け、添字の順を保つ", () => {
    const titles = Array.from({ length: RESOLVE_MAX_TITLES * 2 + 1 }, (_, i) => `t${i}`);
    const batches = splitResolveBatches(titles);
    expect(batches.map((b) => b.length)).toEqual([RESOLVE_MAX_TITLES, RESOLVE_MAX_TITLES, 1]);
    expect(batches.flat()).toEqual(titles.map((_, i) => i));
  });

  it("encode 後の URL が上限を超えないように分ける", () => {
    // 日本語は 1 文字が 9 文字に encode される
    const titles = Array.from({ length: 20 }, (_, i) => `${"あ".repeat(80 + i)}${i}`);
    const batches = splitResolveBatches(titles);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(RESOLVE_MAX_TITLES);
      expect(urlLength(batch.map((i) => titles[i] as string))).toBeLessThanOrEqual(
        RESOLVE_MAX_URL_LENGTH,
      );
    }
    expect(batches.flat()).toEqual(titles.map((_, i) => i));
  });

  it("1 件だけで上限を超える title は問い合わせない", () => {
    const titles = ["a", "あ".repeat(1_000), "b"];
    expect(splitResolveBatches(titles)).toEqual([[0, 2]]);
  });

  it("title が無ければ空", () => {
    expect(splitResolveBatches([])).toEqual([]);
  });
});

describe("版の履歴", () => {
  const summary = {
    version: 4,
    title: "題",
    createdAt: 1,
    author: { kind: "oauth", clientId: "c", name: null },
  };

  it("一覧は cursor をクエリで送り、4 つの作成者の形を通す", async () => {
    const authors = [
      { kind: "owner" },
      { kind: "token", tokenId: 3, name: "agent" },
      { kind: "token", tokenId: null, name: "old" },
      { kind: "oauth", clientId: "c", name: "Claude" },
      { kind: "oauth", clientId: "c", name: null },
      { kind: "other", actor: "system" },
    ];
    const revisions = authors.map((author, i) => ({ ...summary, version: 10 - i, author }));
    const { calls, fetchFn } = recorder(() => Response.json({ revisions, nextCursor: "5" }));
    expect(await listRevisions(ID, null, {}, fetchFn)).toEqual({
      ok: true,
      value: { revisions, nextCursor: "5" },
    });
    await listRevisions(ID, "5", {}, fetchFn);
    await listRevisions(ID, "5", { limit: 1 }, fetchFn);
    expect(calls.map((call) => call.path)).toEqual([
      `/api/pages/${ID}/revisions`,
      `/api/pages/${ID}/revisions?cursor=5`,
      `/api/pages/${ID}/revisions?cursor=5&limit=1`,
    ]);
  });

  it("形の合わないレスポンスは読めない失敗にする", async () => {
    for (const author of [{ kind: "token", name: 1 }, { kind: "oauth" }, { kind: "x" }, null]) {
      const { fetchFn } = recorder(() =>
        Response.json({ revisions: [{ ...summary, author }], nextCursor: null }),
      );
      expect(await listRevisions(ID, null, {}, fetchFn), JSON.stringify(author)).toMatchObject({
        ok: false,
        reason: "error",
      });
    }
    const { fetchFn } = recorder(() => Response.json({ ...summary }));
    expect(await getRevision(ID, 4, fetchFn)).toMatchObject({ ok: false, reason: "error" });
  });

  it("1 つの版は本文ごと返し、版が無ければ revision_not_found、ページが無ければ not_found", async () => {
    const { calls, fetchFn } = recorder(() => Response.json({ pageId: ID, ...summary, body: "b" }));
    expect(await getRevision(ID, 4, fetchFn)).toMatchObject({ ok: true, value: { body: "b" } });
    expect(calls[0]?.path).toBe(`/api/pages/${ID}/revisions/4`);
    const missing = recorder(() => Response.json({ error: "revision_not_found" }, { status: 404 }));
    expect(await getRevision(ID, 4, missing.fetchFn)).toEqual({
      ok: false,
      reason: "revision_not_found",
    });
    for (const gone of [
      () => Response.json({ error: "not_found" }, { status: 404 }),
      () => new Response("404 Not Found", { status: 404 }),
    ]) {
      const res = await getRevision(ID, 4, recorder(gone).fetchFn);
      expect(res).toEqual({ ok: false, reason: "not_found" });
    }
  });
});
