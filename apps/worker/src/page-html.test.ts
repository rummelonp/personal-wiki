import { env } from "cloudflare:workers";
import { DEFAULT_SITE_NAME } from "@personal-wiki/domain";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { SESSION_COOKIE_NAME } from "./auth/session";
import {
  findPageForPath,
  PAGE_LINK_LIST_LIMIT,
  ROOT_PAGE_LIST_LIMIT,
  rewritePageHtml,
} from "./page-html";
import { ownerCookie, ownerEnv } from "./test/owner";
import { type PageJson, T0 } from "./test/pages";
import { insertToken } from "./test/tokens";

/*
 * ページの URL の HTML に差し込むメタ情報と、公開範囲で変わるヘッダー。匿名が draft の title を開いた
 * レスポンスは、存在しない title のレスポンスと区別できてはならない。
 */

const ORIGIN = "http://localhost";
const HTML_ACCEPT = "text/html,application/xhtml+xml,*/*;q=0.8";
const INDEX_HTML =
  '<!doctype html><html lang="ja"><head><meta charset="UTF-8" /><title>wiki</title></head>' +
  '<body><div id="root"></div></body></html>';

// Static Assets と同じく、ETag が合う条件付きのリクエストには 304 を返す。
const assets = {
  fetch: async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input instanceof Request ? input.url : input));
    if (pathname !== "/") return new Response("not found", { status: 404 });
    if (input instanceof Request && input.headers.get("If-None-Match") === '"index"') {
      return new Response(null, { status: 304, headers: { ETag: '"index"' } });
    }
    return new Response(INDEX_HTML, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ETag: '"index"',
        "Content-Length": String(new TextEncoder().encode(INDEX_HTML).length),
      },
    });
  },
} as unknown as Fetcher;

async function setup() {
  const clock = { now: T0 };
  const app = createApp({ now: () => clock.now, recordWrite: () => {} });
  const cookie = await ownerCookie(T0);
  const call = (path: string, init: RequestInit = {}) =>
    app.request(path, init, { ...ownerEnv(), ASSETS: assets });
  const navigate = (path: string, headers: Record<string, string> = {}) =>
    call(path, { headers: { Accept: HTML_ACCEPT, ...headers } });
  const asOwner = (path: string, method: string, json?: unknown, headers = {}) => {
    clock.now += 1000;
    return call(path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        ...headers,
      },
      body: json === undefined ? null : JSON.stringify(json),
    });
  };

  async function setVisibility(id: string, visibility: "public" | "draft") {
    const res = await asOwner(`/api/pages/${id}/visibility`, "PUT", { visibility });
    if (res.status !== 200) throw new Error(`visibility failed: ${res.status}`);
    return res.json<PageJson>();
  }
  async function create(title: string, body: string, visibility: "public" | "draft" = "draft") {
    const res = await asOwner("/api/pages", "POST", { title, body });
    if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
    const page = await res.json<PageJson>();
    return visibility === "draft" ? page : setVisibility(page.id, visibility);
  }

  return { cookie, call, navigate, asOwner, create, setVisibility };
}

/** public の Open Note と draft の Hidden Plan。抜粋は本文の先頭がそのまま入る。 */
async function seed() {
  const ctx = await setup();
  const open = await ctx.create("Open Note", "公開の kangaroo の話", "public");
  const draft = await ctx.create("Hidden Plan", "下書きの zebrafish の話");
  return { ...ctx, open, draft };
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/** 差し込んだ head のメタ情報を、HTML の属性値を decode して返す。 */
function metaOf(html: string) {
  const attr = (pattern: RegExp) => {
    const raw = pattern.exec(html)?.[1];
    return raw === undefined ? null : decodeEntities(raw);
  };
  return {
    title: attr(/<title>([^<]*)<\/title>/),
    ogTitle: attr(/<meta property="og:title" content="([^"]*)">/),
    ogDescription: attr(/<meta property="og:description" content="([^"]*)">/),
    ogUrl: attr(/<meta property="og:url" content="([^"]*)">/),
    ogType: attr(/<meta property="og:type" content="([^"]*)">/),
    canonical: attr(/<link rel="canonical" href="([^"]*)">/),
    twitterCard: attr(/<meta name="twitter:card" content="([^"]*)">/),
    robots: attr(/<meta name="robots" content="([^"]*)">/),
  };
}

/**
 * `<ul>` の中の `<li><a>` を、href は絶対 URL のまま、title は文字参照を解いて返す。
 * 正規表現に当たらない li が混ざっていれば、件数がずれて落ちる。
 */
function listItemsOf(items: string) {
  const links = [...items.matchAll(/<li><a href="([^"]*)">([^<]*)<\/a><\/li>/g)].map((item) => ({
    href: decodeEntities(item[1] ?? ""),
    title: decodeEntities(item[2] ?? ""),
  }));
  expect(links.length).toBe(items.split("<li>").length - 1);
  return links;
}

/**
 * `#root` に差し込んだ title、本文、リンク先の一覧を decode して返す。何も差し込んでいなければ null。
 * 本文は、HTML の parser と同じく <pre> の直後の改行を 1 つ除いて読む。links は `<ul>` が無ければ null。
 */
function pageRootOf(html: string) {
  const root = /<div id="root">([\s\S]*)<\/div><\/body>/.exec(html)?.[1];
  if (root === undefined) throw new Error("no #root");
  if (root === "") return null;
  const match =
    /^<article class="page-text"><h1>([^<]*)<\/h1><pre>([^<]*)<\/pre>(?:<ul>(.*)<\/ul>)?<\/article>$/.exec(
      root,
    );
  if (match === null) throw new Error(`unexpected #root: ${root}`);
  const pre = decodeEntities(match[2] ?? "");
  return {
    title: decodeEntities(match[1] ?? ""),
    body: pre.startsWith("\n") ? pre.slice(1) : pre,
    links: match[3] === undefined ? null : listItemsOf(match[3]),
  };
}

/** `#root` に差し込んだ title と本文。何も差し込んでいなければ null。 */
function pageTextOf(html: string) {
  const root = pageRootOf(html);
  return root === null ? null : { title: root.title, body: root.body };
}

const INITIAL_PAGE_PATTERN =
  /<head>[\s\S]*<script type="application\/json" id="initial-page">([\s\S]*?)<\/script>[\s\S]*<\/head>/;

/** head の初回の表示用の JSON の中身（script の生のテキスト）。無ければ null。 */
function initialPageTextOf(html: string): string | null {
  return INITIAL_PAGE_PATTERN.exec(html)?.[1] ?? null;
}

/** head の初回の表示用の JSON を、ブラウザの textContent と同じく文字参照を解かずに読む。 */
function initialPageOf(html: string): unknown {
  const text = initialPageTextOf(html);
  return text === null ? null : JSON.parse(text);
}

async function snapshot(res: Response) {
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
}

describe("public のページの HTML", () => {
  it("匿名の /<title> は 200 で OGP を差し込み、noindex を付けない", async () => {
    const { navigate } = await seed();
    const res = await navigate(`/${encodeURIComponent("Open Note")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toBeNull();
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(res.headers.get("Vary")).toContain("Cookie");
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Content-Length")).toBeNull();
    expect(metaOf(await res.text())).toEqual({
      title: "Open Note - wiki",
      ogTitle: "Open Note",
      ogDescription: "公開の kangaroo の話",
      ogUrl: `${ORIGIN}/Open_Note`,
      ogType: "article",
      canonical: `${ORIGIN}/Open_Note`,
      twitterCard: "summary",
      robots: null,
    });
  });

  it("匿名にも owner にも、#root に title と本文の Markdown をテキストのまま差し込む", async () => {
    const { navigate, create, cookie } = await seed();
    const body = "# 見出し\n\n[[Open Note]] へのリンクと **強調**\n\n- 項目";
    const page = await create("Rich Note", body, "public");
    for (const headers of [{}, { Cookie: cookie }]) {
      for (const path of [`/p/${page.id}`, "/Rich_Note"]) {
        const html = await (await navigate(path, headers)).text();
        expect(pageTextOf(html), path).toEqual({ title: "Rich Note", body });
      }
    }
  });

  it("匿名にも owner にも、head に /api/pages/:id と同じ JSON を入れる", async () => {
    const { navigate, call, create, cookie } = await seed();
    const page = await create("Json Note", "# 見出し\n\n本文の emu の話", "public");
    const json = await (await call(`/api/pages/${page.id}`)).json<PageJson>();
    expect(json.version).toBe(page.version);
    for (const headers of [{}, { Cookie: cookie }]) {
      for (const path of [`/p/${page.id}`, "/Json_Note", "/json%20note"]) {
        const html = await (await navigate(path, headers)).text();
        expect(initialPageOf(html), path).toEqual(json);
      }
    }
  });

  it("保存の後は、head の JSON の本文と version が同じ版にそろう", async () => {
    const { navigate, asOwner, open } = await seed();
    const res = await asOwner(
      `/api/pages/${open.id}`,
      "PUT",
      { title: open.title, body: "書き換えた wombat の話" },
      { "If-Match": `"${open.version}"` },
    );
    expect(res.status).toBe(200);
    const saved = await res.json<PageJson>();
    expect(saved.version).toBe(open.version + 1);
    const html = await (await navigate(`/p/${open.id}`)).text();
    expect(initialPageOf(html)).toEqual(saved);
  });

  it("本文の先頭の改行と、空の本文もそのまま差し込む", async () => {
    const { navigate, create } = await seed();
    for (const body of ["\n\n先頭が空行の本文", ""]) {
      const page = await create(`Edge ${body.length}`, body, "public");
      const html = await (await navigate(`/p/${page.id}`)).text();
      expect(pageTextOf(html)?.body, JSON.stringify(body)).toBe(body);
    }
  });

  it("title は大文字小文字を区別せずに引き、正規の URL は保存された title から作る", async () => {
    const { navigate } = await seed();
    const res = await navigate("/open%20NOTE");
    expect(res.status).toBe(200);
    expect(metaOf(await res.text()).ogUrl).toBe(`${ORIGIN}/Open_Note`);
  });

  it("`_` は空白と同じ文字として引き、正規の URL は空白を `_` にする", async () => {
    const { navigate, create } = await seed();
    for (const path of ["/Open_Note", "/open_note", "/Open%5FNote"]) {
      const res = await navigate(path);
      expect(res.status, path).toBe(200);
      expect(metaOf(await res.text()).canonical, path).toBe(`${ORIGIN}/Open_Note`);
    }
    // `_` を含む title も、URL の `_` を空白に戻さずに引く
    await create("snake_case", "本文", "public");
    for (const path of ["/snake_case", "/snake%20case"]) {
      const res = await navigate(path);
      expect(res.status, path).toBe(200);
      expect(metaOf(await res.text()).ogTitle, path).toBe("snake_case");
    }
  });

  it("`_` にすると title_key が変わる title は、空白のままの URL が正しいページに着き、`_` の URL は別のページを引く", async () => {
    const { navigate, create } = await seed();
    // "a ¨" の title_key は "a \u0308" で、"a_¨" は "a  \u0308" になり、別のページとして並べられる
    await create("a ¨", "本文 1", "public");
    await create("a_¨", "本文 2", "public");
    const spaced = `/${encodeURIComponent("a ¨")}`;
    const snake = `/${encodeURIComponent("a_¨")}`;
    for (const [path, title] of [
      [spaced, "a ¨"],
      [snake, "a_¨"],
    ] as const) {
      const res = await navigate(path);
      expect(res.status, path).toBe(200);
      const meta = metaOf(await res.text());
      expect(meta.ogTitle, path).toBe(title);
      expect(meta.canonical, path).toBe(`${ORIGIN}${path}`);
    }
  });

  it("/p/<id> で開いても正規の URL は /<title> にする", async () => {
    const { navigate, open } = await seed();
    for (const path of [`/p/${open.id}`, `/p/${open.id}/`]) {
      const res = await navigate(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("X-Robots-Tag"), path).toBeNull();
      const meta = metaOf(await res.text());
      expect(meta.ogUrl, path).toBe(`${ORIGIN}/Open_Note`);
      expect(meta.canonical, path).toBe(`${ORIGIN}/Open_Note`);
    }
  });

  it("title に / を含むページは %2F の URL で引ける", async () => {
    const { navigate, create } = await seed();
    await create("a/b", "", "public");
    const res = await navigate("/a%2Fb");
    expect(res.status).toBe(200);
    expect(metaOf(await res.text()).ogUrl).toBe(`${ORIGIN}/a%2Fb`);
  });

  it("予約語と重なる title の public は /p/<id> を正規の URL にする", async () => {
    const { navigate, create } = await seed();
    const page = await create("API", "", "public");
    const res = await navigate(`/p/${page.id}`);
    expect(res.status).toBe(200);
    expect(metaOf(await res.text()).ogUrl).toBe(`${ORIGIN}/p/${page.id}`);
    // `/API` は大文字小文字を畳むと予約語の api になるので、title として引かない
    expect((await navigate("/API")).status).toBe(404);
  });

  it("Static Assets が先にレスポンスを返す index と index.html の title は /p/<id> を正規の URL にする", async () => {
    const { navigate, create } = await seed();
    for (const title of ["index", "Index.html"]) {
      const page = await create(title, "", "public");
      const res = await navigate(`/p/${page.id}`);
      expect(metaOf(await res.text()).ogUrl, title).toBe(`${ORIGIN}/p/${page.id}`);
    }
  });

  it("/p/<id>/ と同じく、/<title>/ も末尾の / を外して同じページを開く", async () => {
    const { navigate, create } = await seed();
    const res = await navigate("/Open%20Note/");
    expect(res.status).toBe(200);
    expect(metaOf(await res.text()).canonical).toBe(`${ORIGIN}/Open_Note`);
    // title の末尾の / は %2F で書くので、/ を外した title とは別のページになる
    const slash = await create("Slash/", "", "public");
    const encoded = await navigate("/Slash%2F");
    expect(metaOf(await encoded.text()).canonical).toBe(`${ORIGIN}/Slash%2F`);
    expect((await navigate("/Slash/")).status).toBe(404);
    expect(slash.title).toBe("Slash/");
  });
});

describe("owner と token の HTML", () => {
  it("public のページは private, no-store で、noindex を付けない", async () => {
    const { navigate, cookie } = await seed();
    const token = await insertToken({ name: "reader", scopes: "read" });
    for (const headers of [{ Cookie: cookie }, { Authorization: `Bearer ${token}` }]) {
      const res = await navigate(`/${encodeURIComponent("Open Note")}`, headers);
      const label = Object.keys(headers)[0];
      expect(res.status, label).toBe(200);
      expect(res.headers.get("Cache-Control"), label).toBe("private, no-store");
      expect(res.headers.get("X-Robots-Tag"), label).toBeNull();
      expect(metaOf(await res.text()).ogUrl, label).toBe(`${ORIGIN}/Open_Note`);
    }
  });
});

describe("draft のページの HTML", () => {
  it("匿名の /p/<draft の id> は 200 で、noindex と no-store を付け、OGP も差し込む", async () => {
    const { navigate, draft } = await seed();
    const res = await navigate(`/p/${draft.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(metaOf(await res.text())).toEqual({
      title: "Hidden Plan - wiki",
      ogTitle: "Hidden Plan",
      ogDescription: "下書きの zebrafish の話",
      ogUrl: `${ORIGIN}/p/${draft.id}`,
      ogType: "article",
      canonical: `${ORIGIN}/p/${draft.id}`,
      twitterCard: "summary",
      robots: "noindex",
    });
  });

  it("owner と read の token は /<draft の title> で 200 と draft のヘッダーを受け取る", async () => {
    const { navigate, cookie, draft } = await seed();
    const token = await insertToken({ name: "reader", scopes: "read" });
    for (const headers of [{ Cookie: cookie }, { Authorization: `Bearer ${token}` }]) {
      const res = await navigate(`/${encodeURIComponent("Hidden Plan")}`, headers);
      const label = Object.keys(headers)[0];
      expect(res.status, label).toBe(200);
      expect(res.headers.get("Cache-Control"), label).toBe("private, no-store");
      expect(res.headers.get("X-Robots-Tag"), label).toBe("noindex");
      const meta = metaOf(await res.text());
      expect(meta.ogTitle, label).toBe("Hidden Plan");
      expect(meta.ogUrl, label).toBe(`${ORIGIN}/p/${draft.id}`);
      expect(meta.robots, label).toBe("noindex");
    }
  });

  it("draft の本文は匿名にも owner と token にも差し込まない", async () => {
    const { navigate, cookie, create } = await seed();
    const token = await insertToken({ name: "reader", scopes: "read" });
    const draft = await create("Long Draft", `${"前置き。".repeat(100)}末尾の okapi の話`);
    for (const [path, headers] of [
      [`/p/${draft.id}`, {}],
      [`/p/${draft.id}`, { Cookie: cookie }],
      [`/${encodeURIComponent("Long Draft")}`, { Cookie: cookie }],
      [`/${encodeURIComponent("Long Draft")}`, { Authorization: `Bearer ${token}` }],
    ] as const) {
      const html = await (await navigate(path, headers)).text();
      expect(pageTextOf(html), path).toBeNull();
      expect(initialPageTextOf(html), path).toBeNull();
      expect(html, path).not.toContain("okapi");
    }
  });

  it("public から draft に戻すと、id で開いても本文を差し込まない", async () => {
    const { navigate, setVisibility, open } = await seed();
    expect(pageTextOf(await (await navigate(`/p/${open.id}`)).text())).not.toBeNull();
    await setVisibility(open.id, "draft");
    const html = await (await navigate(`/p/${open.id}`)).text();
    expect(pageTextOf(html)).toBeNull();
    expect(initialPageTextOf(html)).toBeNull();
  });

  it("draft の本文は D1 から読まず、本文を持つ draft を渡されても差し込まない", async () => {
    const { draft } = await seed();
    const meta = await findPageForPath(env.DB, `/p/${draft.id}`, { kind: "owner" });
    expect(meta?.visibility).toBe("draft");
    expect(meta?.body).toBeNull();

    const index = new Response(INDEX_HTML, { headers: { "Content-Type": "text/html" } });
    const html = await rewritePageHtml(
      index,
      {
        id: draft.id,
        title: "Hidden Plan",
        visibility: "draft",
        excerpt: null,
        body: "zebrafish",
        version: 1,
        createdAt: T0,
        updatedAt: T0,
      },
      ORIGIN,
      [{ id: draft.id, title: "Linked Secret" }],
    ).text();
    expect(pageTextOf(html)).toBeNull();
    expect(html).not.toContain("Linked Secret");
    expect(initialPageTextOf(html)).toBeNull();
    expect(html).not.toContain("zebrafish");
  });
});

describe("匿名から見た draft の title", () => {
  it("存在しない title と、ステータス、ヘッダー、本文のどれも同じ 404", async () => {
    const { navigate, draft } = await seed();
    const responses = await Promise.all(
      [
        `/${encodeURIComponent("Hidden Plan")}`,
        `/${encodeURIComponent("hidden plan")}`,
        `/${encodeURIComponent("Missing Page")}`,
      ].map(async (path) => ({ path, ...(await snapshot(await navigate(path))) })),
    );
    const [first, ...others] = responses;
    const { path: _path, ...expected } = first as (typeof responses)[number];
    expect(expected.status).toBe(404);
    expect(expected.body).toBe(INDEX_HTML);
    expect(expected.headers["x-robots-tag"]).toBe("noindex");
    expect(expected.headers["referrer-policy"]).toBe("same-origin");
    expect(expected.headers["cache-control"]).toBe("no-cache");
    expect(expected.headers.etag).toBeUndefined();
    for (const { path, ...response } of others) expect(response, path).toEqual(expected);

    const serialized = JSON.stringify(responses);
    for (const word of [draft.id, "zebrafish", "下書き"]) {
      expect(serialized, word).not.toContain(word);
    }
  });

  it("検証できない cookie の匿名にも 401 ではなく同じ 404 を返し、public は読める", async () => {
    const { navigate } = await seed();
    const stale = { Cookie: `${SESSION_COOKIE_NAME}=garbage` };
    const missing = await snapshot(await navigate(`/${encodeURIComponent("Missing Page")}`, stale));
    const hidden = await snapshot(await navigate(`/${encodeURIComponent("Hidden Plan")}`, stale));
    expect(hidden.status).toBe(404);
    expect(hidden).toEqual(missing);
    expect(hidden.headers["set-cookie"]).toBeUndefined();
    expect((await navigate(`/${encodeURIComponent("Open Note")}`, stale)).status).toBe(200);
  });

  it("public から draft に戻すと、title では同じ 404 になる", async () => {
    const { navigate, setVisibility, open } = await seed();
    expect((await navigate(`/${encodeURIComponent("Open Note")}`)).status).toBe(200);
    await setVisibility(open.id, "draft");
    const hidden = await snapshot(await navigate(`/${encodeURIComponent("Open Note")}`));
    const missing = await snapshot(await navigate(`/${encodeURIComponent("Missing Page")}`));
    expect(hidden).toEqual(missing);
  });
});

describe("見つからないパス", () => {
  it("存在しない／削除済み／形式の違う id と、ページの URL の形でないパスは noindex の 404", async () => {
    const { navigate, asOwner, create } = await seed();
    const gone = await create("Gone", "消した話", "public");
    const deleted = await asOwner(`/api/pages/${gone.id}`, "DELETE", undefined, {
      "If-Match": `"${gone.version}"`,
    });
    expect(deleted.status).toBe(204);
    const expected = await snapshot(await navigate(`/${encodeURIComponent("Missing Page")}`));
    for (const path of [
      "/p/AAAAAAAAAAAAAAAAAAAAAA",
      `/p/${gone.id}`,
      "/p/short",
      "/p",
      `/p/${gone.id}/extra`,
      "/P/AAAAAAAAAAAAAAAAAAAAAA",
      "/Gone",
      "/%E0%A4%A",
      "/a%2F..",
      "/Missing%20Page/",
      "/index",
    ]) {
      expect(await snapshot(await navigate(path)), path).toEqual(expected);
    }
  });

  it("HEAD もページ、見つからないパス、トップで GET と同じステータスとヘッダーを返す", async () => {
    const { call } = await seed();
    for (const [path, status, robots] of [
      ["/Open%20Note", 200, null],
      ["/Missing%20Page", 404, "noindex"],
      ["/", 200, null],
    ] as const) {
      const res = await call(path, { method: "HEAD", headers: { Accept: HTML_ACCEPT } });
      expect(res.status, path).toBe(status);
      expect(res.headers.get("Content-Type"), path).toBe("text/html; charset=utf-8");
      expect(res.headers.get("X-Robots-Tag"), path).toBe(robots);
    }
  });
});

describe("Accept による分岐", () => {
  // Accept の無いリクエスト、*/* だけのリクエスト（空白は無視）
  const anyAccepts = [undefined, "*/*", " */* "];
  const withAccept = (accept: string | undefined): RequestInit =>
    accept === undefined ? {} : { headers: { Accept: accept } };

  it("Accept が無いか */* だけなら、読めるページに限って書き換えた HTML を返す", async () => {
    const { call, cookie, draft } = await seed();
    for (const accept of anyAccepts) {
      const label = String(accept);
      const open = await call("/Open%20Note", withAccept(accept));
      expect(open.status, label).toBe(200);
      expect(open.headers.get("X-Robots-Tag"), label).toBeNull();
      const openHtml = await open.text();
      expect(metaOf(openHtml).ogTitle, label).toBe("Open Note");
      expect(pageTextOf(openHtml)?.body, label).toBe("公開の kangaroo の話");

      const byId = await call(`/p/${draft.id}`, withAccept(accept));
      expect(byId.status, label).toBe(200);
      expect(byId.headers.get("X-Robots-Tag"), label).toBe("noindex");
      const byIdHtml = await byId.text();
      expect(metaOf(byIdHtml).ogTitle, label).toBe("Hidden Plan");
      expect(pageTextOf(byIdHtml), label).toBeNull();

      const init = withAccept(accept);
      const asOwner = await call("/Hidden%20Plan", {
        headers: { ...(init.headers as Record<string, string>), Cookie: cookie },
      });
      expect(asOwner.status, label).toBe(200);
      expect(metaOf(await asOwner.text()).ogTitle, label).toBe("Hidden Plan");
    }
  });

  it("Accept が無いか */* だけでも、匿名の draft の title と存在しない title は同じ JSON の 404", async () => {
    const { call, draft } = await seed();
    for (const accept of anyAccepts) {
      const responses = await Promise.all(
        ["/Hidden%20Plan", "/hidden%20plan", "/Missing%20Page", "/p/AAAAAAAAAAAAAAAAAAAAAA"].map(
          async (path) => ({ path, ...(await snapshot(await call(path, withAccept(accept)))) }),
        ),
      );
      const [first, ...others] = responses;
      const { path: _path, ...expected } = first as (typeof responses)[number];
      expect(expected.status, String(accept)).toBe(404);
      expect(JSON.parse(expected.body), String(accept)).toEqual({ error: "not_found" });
      for (const { path, ...response } of others) {
        expect(response, `${accept} ${path}`).toEqual(expected);
      }
      const serialized = JSON.stringify(responses);
      for (const word of [draft.id, "zebrafish"]) expect(serialized, word).not.toContain(word);
    }
  });

  it("JSON や画像など他の型を明示したリクエストは、ページがあっても JSON の 404", async () => {
    const { call, open } = await seed();
    for (const path of ["/Open%20Note", `/p/${open.id}`]) {
      for (const accept of [
        "application/json",
        "image/avif,image/webp,*/*",
        "*/*;q=0.8",
        "application/json, */*",
      ]) {
        const res = await call(path, withAccept(accept));
        expect(res.status, `${accept} ${path}`).toBe(404);
        expect(await res.json()).toEqual({ error: "not_found" });
      }
    }
  });
});

describe("D1 や ASSETS の失敗", () => {
  const failingDb = {
    prepare: () => ({
      bind: () => ({
        first: async () => {
          throw new Error("D1 is unavailable");
        },
        all: async () => {
          throw new Error("D1 is unavailable");
        },
      }),
    }),
  } as unknown as D1Database;

  it("D1 の検索が失敗したら、書き換えない index.html を 503、noindex、no-store で返す", async () => {
    const app = createApp();
    for (const path of ["/Open%20Note", "/p/AAAAAAAAAAAAAAAAAAAAAA", "/"]) {
      const res = await app.request(
        path,
        { headers: { Accept: HTML_ACCEPT } },
        { ...ownerEnv(), ASSETS: assets, DB: failingDb },
      );
      expect(res.status, path).toBe(503);
      expect(await res.text(), path).toBe(INDEX_HTML);
      expect(res.headers.get("X-Robots-Tag"), path).toBe("noindex");
      expect(res.headers.get("Cache-Control"), path).toBe("no-store");
      expect(res.headers.get("ETag"), path).toBeNull();
    }
  });

  it("ASSETS の取得も失敗したときは 500 で、D1 の失敗を未処理の拒否として残さない", async () => {
    const brokenAssets = {
      fetch: async (input: RequestInfo | URL) => {
        const { pathname } = new URL(String(input instanceof Request ? input.url : input));
        if (pathname !== "/") return new Response("not found", { status: 404 });
        throw new Error("assets are unavailable");
      },
    } as unknown as Fetcher;
    const res = await createApp().request(
      "/Open%20Note",
      { headers: { Accept: HTML_ACCEPT } },
      { ...ownerEnv(), ASSETS: brokenAssets, DB: failingDb },
    );
    expect(res.status).toBe(500);
  });
});

describe("値のエスケープ", () => {
  it('title と抜粋の <、"、& が要素や属性を壊さず、文字参照に見える表記もそのまま読める', async () => {
    const { navigate, create } = await seed();
    const title = 'A <b> "c" & d &amp; e';
    const page = await create(title, '1 < 2 & "x" &lt;y&gt;', "public");
    const res = await navigate(`/p/${page.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // 属性値の中の < は要素にならないので、要素として現れうる title の中身だけを確かめる
    expect(html).toContain("<title>A &lt;b&gt; ");
    const meta = metaOf(html);
    expect(meta.title).toBe(`${title} - wiki`);
    expect(meta.ogTitle).toBe(title);
    expect(meta.ogDescription).toBe('1 < 2 & "x" &lt;y&gt;');
    expect(meta.ogUrl).toBe(`${ORIGIN}/${encodeURIComponent(title.replaceAll(" ", "_"))}`);
  });

  it("本文の </pre> やタグ、文字参照に見える表記は要素にならず、そのまま読める", async () => {
    const { navigate, create } = await seed();
    const body = '</pre></article><script>alert(1)</script>\n1 < 2 & "x" &lt;y&gt;\n<!-- c -->';
    const page = await create("Tricky </h1>", body, "public");
    const html = await (await navigate(`/p/${page.id}`)).text();
    expect(html).not.toContain("<script>");
    expect(pageTextOf(html)).toEqual({ title: "Tricky </h1>", body });
  });

  it("head の JSON は </script> や <!--、文字参照に見える表記、改行の種類を含んでも script を抜けず、元の値に戻る", async () => {
    const { navigate, create } = await seed();
    const title = "Script </script><!-- &amp;";
    const body =
      '</script><script>alert(1)</script>\r\n<!-- c --> 1 < 2 & "x" &lt;y&gt;\r' +
      "\u2028行\u2029段落 </SCRIPT ";
    const page = await create(title, body, "public");
    const html = await (await navigate(`/p/${page.id}`)).text();
    const text = initialPageTextOf(html);
    expect(text).not.toBeNull();
    expect(text).not.toMatch(/[<>&\u2028\u2029]/);
    expect(initialPageOf(html)).toMatchObject({ id: page.id, title, body });
    // 本文の中の </script> が script を閉じていれば、閉じた後の <script> がそのまま HTML に出る
    expect(html).not.toContain("<script>");
    expect(html).toContain("</head><body>");
  });

  it("抜粋の改行や制御文字も属性値の中に収まる", async () => {
    const { navigate, create } = await seed();
    const page = await create("Multiline", "仮の本文", "public");
    const excerpt = "一行目\n二行目\r\n\t三行目\u0007終わり";
    await env.DB.prepare("UPDATE page_excerpts SET excerpt = ?2 WHERE page_id = ?1")
      .bind(page.id, excerpt)
      .run();
    const html = await (await navigate(`/p/${page.id}`)).text();
    const meta = metaOf(html);
    expect(meta.ogDescription).toBe(excerpt);
    expect(meta.ogTitle).toBe("Multiline");
    expect(html).toContain("</head><body>");
  });

  it("抜粋が空か無いページは og:description を出さない", async () => {
    const { navigate, create } = await seed();
    const empty = await create("Empty", "", "public");
    const unbuilt = await create("Unbuilt", "まだ抜粋の無い話", "public");
    await env.DB.prepare("DELETE FROM page_excerpts WHERE page_id = ?1").bind(unbuilt.id).run();
    for (const page of [empty, unbuilt]) {
      const html = await (await navigate(`/p/${page.id}`)).text();
      expect(metaOf(html).ogDescription, page.title).toBeNull();
      expect(html, page.title).not.toContain("og:description");
      expect(metaOf(html).ogTitle, page.title).toBe(page.title);
    }
  });
});

/**
 * トップの `#root` に差し込んだサイト名とリンクを decode して返す。何も差し込んでいなければ null。
 * href は絶対 URL のまま、title は文字参照を解いて返す。
 */
function rootListOf(html: string) {
  const root = /<div id="root">([\s\S]*)<\/div><\/body>/.exec(html)?.[1];
  if (root === undefined) throw new Error("no #root");
  if (root === "") return null;
  const match = /^<article class="page-text"><h1>([^<]*)<\/h1>(?:<ul>(.*)<\/ul>)?<\/article>$/.exec(
    root,
  );
  if (match === null) throw new Error(`unexpected #root: ${root}`);
  return { siteName: decodeEntities(match[1] ?? ""), links: listItemsOf(match[2] ?? "") };
}

describe("トップの HTML", () => {
  it("public で削除されていないページだけを、匿名にも owner と token にも更新日時の新しい順に並べる", async () => {
    const { navigate, asOwner, create, setVisibility, cookie, open, draft } = await seed();
    const second = await create("Second", "", "public");
    const gone = await create("Gone", "", "public");
    const deleted = await asOwner(`/api/pages/${gone.id}`, "DELETE", undefined, {
      "If-Match": `"${gone.version}"`,
    });
    expect(deleted.status).toBe(204);
    const reverted = await create("Reverted", "", "public");
    await setVisibility(reverted.id, "draft");
    const updated = await asOwner(
      `/api/pages/${open.id}`,
      "PUT",
      { title: open.title, body: "x" },
      { "If-Match": `"${open.version}"` },
    );
    expect(updated.status).toBe(200);

    const token = await insertToken({ name: "reader", scopes: "read" });
    for (const headers of [{}, { Cookie: cookie }, { Authorization: `Bearer ${token}` }]) {
      const label = Object.keys(headers)[0] ?? "anonymous";
      const res = await navigate("/", headers);
      expect(res.status, label).toBe(200);
      const html = await res.text();
      expect(rootListOf(html), label).toEqual({
        siteName: DEFAULT_SITE_NAME,
        links: [
          { href: `${ORIGIN}/Open_Note`, title: "Open Note" },
          { href: `${ORIGIN}/Second`, title: second.title },
        ],
      });
      for (const word of [draft.id, "Hidden Plan", gone.id, "Gone", reverted.id, "Reverted"]) {
        expect(html, `${label} ${word}`).not.toContain(word);
      }
    }
  });

  it(`多くて ${ROOT_PAGE_LIST_LIMIT} 件で、古いページから外す`, async () => {
    const { navigate, create } = await setup();
    const titles: string[] = [];
    for (let i = 0; i <= ROOT_PAGE_LIST_LIMIT; i++) {
      titles.push((await create(`Page ${i}`, "", "public")).title);
    }
    const list = rootListOf(await (await navigate("/")).text());
    expect(list?.links.map((link) => link.title)).toEqual(titles.slice(1).reverse());
  });

  it('title の <、"、& と文字参照に見える表記は要素や属性を壊さず、そのまま読める', async () => {
    const { navigate, create } = await setup();
    const title = 'A <b> "c" & d &amp; e </a></li>';
    await create(title, "", "public");
    const html = await (await navigate("/")).text();
    expect(html).not.toContain("<b>");
    expect(rootListOf(html)?.links).toEqual([
      { href: `${ORIGIN}/${encodeURIComponent(title.replaceAll(" ", "_"))}`, title },
    ]);
  });

  it("予約語と重なる title は /p/<id> へ、/ を含む title は %2F の URL へリンクする", async () => {
    const { navigate, create } = await setup();
    const index = await create("index", "", "public");
    const api = await create("API", "", "public");
    await create("Slash/", "", "public");
    expect(rootListOf(await (await navigate("/")).text())?.links).toEqual([
      { href: `${ORIGIN}/Slash%2F`, title: "Slash/" },
      { href: `${ORIGIN}/p/${api.id}`, title: "API" },
      { href: `${ORIGIN}/p/${index.id}`, title: "index" },
    ]);
  });

  it("public のページが無ければサイト名だけを差し込む", async () => {
    const { navigate, create } = await setup();
    await create("Hidden Plan", "下書き");
    const html = await (await navigate("/")).text();
    expect(rootListOf(html)).toEqual({ siteName: DEFAULT_SITE_NAME, links: [] });
    expect(html).not.toContain("<ul>");
  });

  it("匿名には no-cache で ETag を付けず、noindex を付けない。owner には private, no-store", async () => {
    const { navigate, cookie } = await seed();
    const anonymous = await navigate("/");
    expect(anonymous.headers.get("Cache-Control")).toBe("no-cache");
    expect(anonymous.headers.get("ETag")).toBeNull();
    expect(anonymous.headers.get("Content-Length")).toBeNull();
    expect(anonymous.headers.get("X-Robots-Tag")).toBeNull();
    expect(anonymous.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    const owner = await navigate("/", { Cookie: cookie });
    expect(owner.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("index.html の ETag で条件付きに開いても、304 にせず一覧を入れて返す", async () => {
    const { navigate } = await seed();
    const res = await navigate("/", { "If-None-Match": '"index"' });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeNull();
    expect(rootListOf(await res.text())?.links).toHaveLength(1);
  });

  it("Accept が無いか JSON でも一覧を差し込み、クエリ付きのトップには差し込まない", async () => {
    const { call, navigate } = await seed();
    for (const init of [{}, { headers: { Accept: "application/json" } }]) {
      const res = await call("/", init);
      expect(res.status).toBe(200);
      expect(rootListOf(await res.text())?.links).toHaveLength(1);
    }
    for (const path of ["/?tag=x", "/?q=Open"]) {
      const res = await navigate(path);
      expect(res.status, path).toBe(200);
      expect(rootListOf(await res.text()), path).toBeNull();
      expect(res.headers.get("X-Robots-Tag"), path).toBe("noindex");
    }
  });

  it("一覧は本文を読まず、pages_alive_updated をたどって並べ替えない", async () => {
    await seed();
    const statements: string[] = [];
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const res = await createApp().request(
      "/",
      { headers: { Accept: HTML_ACCEPT } },
      { ...ownerEnv(), ASSETS: assets, DB: db },
    );
    expect(rootListOf(await res.text())?.links).toHaveLength(1);
    expect(statements).toHaveLength(1);
    const sql = statements[0] ?? "";
    expect(sql).not.toMatch(/body|excerpt/);
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(ROOT_PAGE_LIST_LIMIT)
      .all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join("\n");
    expect(plan).toContain("pages_alive_updated");
    expect(plan).not.toContain("TEMP B-TREE");
  });
});

describe("ページのリンク先の一覧", () => {
  async function remove(asOwner: Awaited<ReturnType<typeof setup>>["asOwner"], page: PageJson) {
    const res = await asOwner(`/api/pages/${page.id}`, "DELETE", undefined, {
      "If-Match": `"${page.version}"`,
    });
    expect(res.status).toBe(204);
  }

  it("public で削除されていないリンク先だけを、匿名にも owner と token にも title_key の順に並べる", async () => {
    const { navigate, asOwner, create, setVisibility, cookie, open, draft } = await seed();
    const gamma = await create("Gamma", "", "public");
    const beta = await create("beta", "", "public");
    const gone = await create("Gone", "", "public");
    await remove(asOwner, gone);
    const reverted = await create("Reverted", "", "public");
    await setVisibility(reverted.id, "draft");
    const hub = await create(
      "Hub",
      [
        "[[Gamma]] [[GAMMA|別名]] [[beta]] [[Open Note]] [[open_note#見出し]]",
        "[[Hidden Plan]] [[Gone]] [[Reverted]] [[Nowhere]] [[hub]] [[Hub]]",
      ].join("\n"),
      "public",
    );

    const token = await insertToken({ name: "reader", scopes: "read" });
    for (const headers of [{}, { Cookie: cookie }, { Authorization: `Bearer ${token}` }]) {
      const label = Object.keys(headers)[0] ?? "anonymous";
      for (const path of ["/Hub", `/p/${hub.id}`]) {
        const res = await navigate(path, headers);
        expect(res.status, `${label} ${path}`).toBe(200);
        const html = await res.text();
        expect(pageRootOf(html)?.links, `${label} ${path}`).toEqual([
          { href: `${ORIGIN}/beta`, title: beta.title },
          { href: `${ORIGIN}/Gamma`, title: gamma.title },
          { href: `${ORIGIN}/Open_Note`, title: open.title },
        ]);
        for (const id of [draft.id, gone.id, reverted.id]) {
          expect(html, `${label} ${path} ${id}`).not.toContain(id);
        }
      }
    }
  });

  it("target_page_id が別の title_key の行に残っていても、同じページを 2 度出さない", async () => {
    const { navigate, create, open } = await seed();
    const hub = await create("Hub", "[[Open Note]] [[Old Name]]", "public");
    await env.DB.prepare(
      "UPDATE links SET target_page_id = ?2 WHERE source_page_id = ?1 AND target_title_key = 'old name'",
    )
      .bind(hub.id, open.id)
      .run();
    expect(pageRootOf(await (await navigate("/Hub")).text())?.links).toEqual([
      { href: `${ORIGIN}/Open_Note`, title: open.title },
    ]);
  });

  it("target_page_id が削除済みのページに残っていても、そのページを出さない", async () => {
    const { navigate, asOwner, create, open } = await seed();
    const gone = await create("Gone", "", "public");
    const hub = await create("Hub", "[[Open Note]] [[Gone]]", "public");
    await remove(asOwner, gone);
    await env.DB.prepare(
      "UPDATE links SET target_page_id = ?2 WHERE source_page_id = ?1 AND target_title_key = 'gone'",
    )
      .bind(hub.id, gone.id)
      .run();
    expect(pageRootOf(await (await navigate("/Hub")).text())?.links).toEqual([
      { href: `${ORIGIN}/Open_Note`, title: open.title },
    ]);
  });

  it("予約語と重なる title は /p/<id> へ、/ を含む title は %2F の URL へリンクする", async () => {
    const { navigate, create } = await setup();
    const index = await create("index", "", "public");
    const api = await create("API", "", "public");
    await create("Slash/", "", "public");
    await create("Hub", "[[index]] [[API]] [[Slash/]]", "public");
    expect(pageRootOf(await (await navigate("/Hub")).text())?.links).toEqual([
      { href: `${ORIGIN}/p/${api.id}`, title: "API" },
      { href: `${ORIGIN}/p/${index.id}`, title: "index" },
      { href: `${ORIGIN}/Slash%2F`, title: "Slash/" },
    ]);
  });

  it('title の <、"、& と文字参照に見える表記は要素や属性を壊さず、そのまま読める', async () => {
    const { navigate, create } = await setup();
    const title = 'A <b> "c" & d &amp; e </a></li>';
    await create(title, "", "public");
    await create("Hub", `[[${title}]]`, "public");
    const html = await (await navigate("/Hub")).text();
    // og:description の属性値には本文の < がそのまま入るので、要素として現れうる #root の中だけを確かめる
    expect(html.slice(html.indexOf('<div id="root">'))).not.toContain("<b>");
    expect(pageRootOf(html)?.links).toEqual([
      { href: `${ORIGIN}/${encodeURIComponent(title.replaceAll(" ", "_"))}`, title },
    ]);
  });

  it("public のリンク先が無ければ <ul> を出さない", async () => {
    const { navigate, create } = await seed();
    await create("Lonely", "[[Hidden Plan]] [[Nowhere]] [[Lonely]]", "public");
    const html = await (await navigate("/Lonely")).text();
    expect(pageRootOf(html)).toMatchObject({ title: "Lonely", links: null });
    expect(html).not.toContain("<ul>");
  });

  it("draft のページには、owner が開いても public のリンク先の一覧を入れない", async () => {
    const { navigate, create, cookie } = await seed();
    const page = await create("Draft Hub", "[[Open Note]]");
    for (const [path, headers] of [
      [`/p/${page.id}`, {}],
      [`/p/${page.id}`, { Cookie: cookie }],
      ["/Draft_Hub", { Cookie: cookie }],
    ] as const) {
      const res = await navigate(path, headers);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(pageRootOf(html), path).toBeNull();
      expect(html, path).not.toContain("Open_Note");
    }
  });

  it(`多くて ${PAGE_LINK_LIST_LIMIT} 件で、title_key の順の後ろから外す`, async () => {
    const { navigate, create } = await setup();
    const titles: string[] = [];
    for (let i = 0; i <= PAGE_LINK_LIST_LIMIT; i++) {
      titles.push((await create(`Page ${String(i).padStart(3, "0")}`, "", "public")).title);
    }
    await create("Hub", titles.map((title) => `[[${title}]]`).join("\n"), "public");
    const links = pageRootOf(await (await navigate("/Hub")).text())?.links;
    expect(links?.map((link) => link.title)).toEqual(titles.slice(0, PAGE_LINK_LIST_LIMIT));
  });

  it("リンク先の取得だけが失敗しても、書き換えない index.html を 503 で返す", async () => {
    await seed();
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) =>
            sql.includes("FROM links")
              ? {
                  bind: () => ({
                    all: async () => {
                      throw new Error("D1 is unavailable");
                    },
                  }),
                }
              : target.prepare(sql);
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const res = await createApp().request(
      "/Open_Note",
      { headers: { Accept: HTML_ACCEPT } },
      { ...ownerEnv(), ASSETS: assets, DB: db },
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(INDEX_HTML);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("public のページだけがリンク先を引き、links の主キーと pages の id をたどって並べ替えない", async () => {
    const { draft, create } = await seed();
    const hub = await create("Hub", "[[Open Note]]", "public");
    const statements: string[] = [];
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const open = (path: string) =>
      createApp().request(
        path,
        { headers: { Accept: HTML_ACCEPT } },
        { ...ownerEnv(), ASSETS: assets, DB: db },
      );

    expect(pageRootOf(await (await open(`/p/${draft.id}`)).text())).toBeNull();
    expect(statements).toHaveLength(1);
    statements.length = 0;
    expect(pageRootOf(await (await open("/Hub")).text())?.links).toHaveLength(1);
    expect(statements).toHaveLength(2);
    const sql = statements[1] ?? "";
    expect(sql).toContain("FROM links");
    expect(sql).not.toMatch(/body|excerpt/);
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(hub.id, PAGE_LINK_LIST_LIMIT)
      .all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join("\n");
    expect(plan).not.toContain("TEMP B-TREE");
    expect(plan).not.toMatch(/^SCAN/m);
  });
});
