import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { SESSION_COOKIE_NAME } from "./auth/session";
import { ownerCookie, ownerEnv } from "./test/owner";
import { type PageJson, T0 } from "./test/pages";
import { insertToken } from "./test/tokens";

/*
 * ページの URL の HTML に差し込むメタ情報と、公開範囲で変わるヘッダー。匿名が draft の title を開いた
 * 応答は、存在しない title の応答と区別できてはならない。
 */

const ORIGIN = "http://localhost";
const HTML_ACCEPT = "text/html,application/xhtml+xml,*/*;q=0.8";
const INDEX_HTML =
  '<!doctype html><html lang="ja"><head><meta charset="UTF-8" /><title>wiki</title></head>' +
  '<body><div id="root"></div></body></html>';

const assets = {
  fetch: async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input instanceof Request ? input.url : input));
    if (pathname !== "/") return new Response("not found", { status: 404 });
    return new Response(INDEX_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"index"' },
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
    expect(metaOf(await res.text())).toEqual({
      title: "Open Note - wiki",
      ogTitle: "Open Note",
      ogDescription: "公開の kangaroo の話",
      ogUrl: `${ORIGIN}/Open%20Note`,
      ogType: "article",
      canonical: `${ORIGIN}/Open%20Note`,
      twitterCard: "summary",
      robots: null,
    });
  });

  it("title は大文字小文字を区別せずに引き、正規の URL は保存された title から作る", async () => {
    const { navigate } = await seed();
    const res = await navigate("/open%20NOTE");
    expect(res.status).toBe(200);
    expect(metaOf(await res.text()).ogUrl).toBe(`${ORIGIN}/Open%20Note`);
  });

  it("/p/<id> で開いても正規の URL は /<title> にする", async () => {
    const { navigate, open } = await seed();
    for (const path of [`/p/${open.id}`, `/p/${open.id}/`]) {
      const res = await navigate(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("X-Robots-Tag"), path).toBeNull();
      const meta = metaOf(await res.text());
      expect(meta.ogUrl, path).toBe(`${ORIGIN}/Open%20Note`);
      expect(meta.canonical, path).toBe(`${ORIGIN}/Open%20Note`);
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
});

describe("draft のページの HTML", () => {
  it("匿名の /p/<draft の id> は 200 で、noindex、no-referrer、no-store を付け、OGP も差し込む", async () => {
    const { navigate, draft } = await seed();
    const res = await navigate(`/p/${draft.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
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
      expect(res.headers.get("Referrer-Policy"), label).toBe("no-referrer");
      const meta = metaOf(await res.text());
      expect(meta.ogTitle, label).toBe("Hidden Plan");
      expect(meta.ogUrl, label).toBe(`${ORIGIN}/p/${draft.id}`);
      expect(meta.robots, label).toBe("noindex");
    }
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
  it("存在しない・削除済み・形式の違う id と、ページの URL の形でないパスは noindex の 404", async () => {
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
    ]) {
      expect(await snapshot(await navigate(path)), path).toEqual(expected);
    }
  });

  it("HTML を受け付けないリクエストは、ページがあっても JSON の 404", async () => {
    const { call, open } = await seed();
    for (const path of ["/Open%20Note", `/p/${open.id}`]) {
      for (const accept of [undefined, "application/json"]) {
        const res = await call(path, accept === undefined ? {} : { headers: { Accept: accept } });
        expect(res.status, path).toBe(404);
        expect(await res.json()).toEqual({ error: "not_found" });
      }
    }
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
    expect(meta.ogUrl).toBe(`${ORIGIN}/${encodeURIComponent(title)}`);
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
