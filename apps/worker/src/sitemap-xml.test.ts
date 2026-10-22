import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { ROOT_PAGE_LIST_LIMIT } from "./page-html";
import { SITEMAP_URL_LIMIT } from "./sitemap-xml";
import { ownerCookie, ownerEnv } from "./test/owner";
import { insertPublicPages, type PageJson, T0 } from "./test/pages";
import { insertToken } from "./test/tokens";

/*
 * `/sitemap.xml` には、どの principal が取っても public で削除されていないページだけが入る。
 * draft、削除済み、public から draft に戻したページの title と id は、本文のどこにも出てはならない。
 */

const ORIGIN = "http://localhost";
const HEAD = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
];
const TAIL = ["</urlset>", ""];

async function setup() {
  const clock = { now: T0 };
  const app = createApp({ now: () => clock.now, recordWrite: () => {} });
  const cookie = await ownerCookie(T0);
  const bindings = ownerEnv();
  const call = (path: string, init: RequestInit = {}) => app.request(path, init, bindings);
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
  async function create(title: string, visibility: "public" | "draft" = "draft") {
    const res = await asOwner("/api/pages", "POST", { title, body: "" });
    if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
    const page = await res.json<PageJson>();
    return visibility === "draft" ? page : setVisibility(page.id, visibility);
  }
  return { cookie, call, asOwner, create, setVisibility };
}

function entry(loc: string, updatedAt: number): string {
  const lastmod = new Date(updatedAt).toISOString().replace(".000Z", "Z");
  return `<url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`;
}

/** `<loc>` の中身を文書の順に返す。escape は解かない。 */
function locsOf(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1] ?? "");
}

describe("/sitemap.xml", () => {
  it("public で削除されていないページだけを、匿名にも owner と token にも更新日時と一緒に新しい順に並べる", async () => {
    const { call, asOwner, create, setVisibility, cookie } = await setup();
    const open = await create("Open Note", "public");
    const draft = await create("Hidden Plan");
    const second = await create("Second", "public");
    const gone = await create("Gone", "public");
    const deleted = await asOwner(`/api/pages/${gone.id}`, "DELETE", undefined, {
      "If-Match": `"${gone.version}"`,
    });
    expect(deleted.status).toBe(204);
    const reverted = await create("Reverted", "public");
    await setVisibility(reverted.id, "draft");
    const updated = await asOwner(
      `/api/pages/${open.id}`,
      "PUT",
      { title: open.title, body: "x" },
      { "If-Match": `"${open.version}"` },
    );
    expect(updated.status).toBe(200);
    const openUpdatedAt = (await updated.json<PageJson>()).updatedAt;
    expect(openUpdatedAt).toBeGreaterThan(second.updatedAt);

    const token = await insertToken({ name: "reader", scopes: "read" });
    for (const headers of [{}, { Cookie: cookie }, { Authorization: `Bearer ${token}` }]) {
      const label = Object.keys(headers)[0] ?? "anonymous";
      const res = await call("/sitemap.xml", { headers });
      expect(res.status, label).toBe(200);
      const xml = await res.text();
      expect(xml, label).toBe(
        [
          ...HEAD,
          entry(`${ORIGIN}/Open_Note`, openUpdatedAt),
          entry(`${ORIGIN}/Second`, second.updatedAt),
          ...TAIL,
        ].join("\n"),
      );
      for (const word of [draft.id, "Hidden", gone.id, "Gone", reverted.id, "Reverted"]) {
        expect(xml, `${label} ${word}`).not.toContain(word);
      }
    }
  });

  it("lastmod は updated_at のミリ秒を W3C Datetime の UTC の秒までにする", async () => {
    const { call, create } = await setup();
    const page = await create("Open Note", "public");
    expect(page.updatedAt).toBe(T0 + 2000);
    const xml = await (await call("/sitemap.xml")).text();
    expect(xml).toContain("<lastmod>2026-10-01T00:00:02Z</lastmod>");
  });

  it("application/xml の utf-8 で noindex を付けて返し、匿名には no-store、owner と token には private, no-store を付ける", async () => {
    const { call, create, cookie } = await setup();
    await create("Open Note", "public");
    const anonymous = await call("/sitemap.xml");
    expect(anonymous.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(anonymous.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(anonymous.headers.get("Cache-Control")).toBe("no-store");
    expect(anonymous.headers.get("ETag")).toBeNull();
    expect(anonymous.headers.get("Vary")).toContain("Cookie");
    expect(anonymous.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const token = await insertToken({ name: "reader", scopes: "read" });
    for (const headers of [{ Cookie: cookie }, { Authorization: `Bearer ${token}` }]) {
      const res = await call("/sitemap.xml", { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });

  it("public から draft に戻したページは、次の取得で消える", async () => {
    const { call, create, setVisibility } = await setup();
    const page = await create("Soon Private", "public");
    expect(locsOf(await (await call("/sitemap.xml")).text())).toEqual([`${ORIGIN}/Soon_Private`]);
    await setVisibility(page.id, "draft");
    const xml = await (await call("/sitemap.xml")).text();
    expect(xml).not.toContain(page.id);
    expect(xml).not.toContain("Soon");
  });

  it("public のページが無ければ、空の urlset を 200 で返す", async () => {
    const { call, create } = await setup();
    await create("Hidden Plan");
    const res = await call("/sitemap.xml");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe([...HEAD, ...TAIL].join("\n"));
  });

  it("URL の & < > \" ' は文字参照にし、予約語と重なる title は /p/<id>、/ を含む title は %2F にする", async () => {
    const { call, create } = await setup();
    const sitemap = await create("Sitemap.XML", "public");
    await create("Slash/", "public");
    await create(`it's <a> & "b"`, "public");
    const xml = await (await call("/sitemap.xml")).text();
    expect(locsOf(xml)).toEqual([
      `${ORIGIN}/it&apos;s_%3Ca%3E_%26_%22b%22`,
      `${ORIGIN}/Slash%2F`,
      `${ORIGIN}/p/${sitemap.id}`,
    ]);
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it(`トップの一覧の ${ROOT_PAGE_LIST_LIMIT} 件で切らず、${SITEMAP_URL_LIMIT} 件までを 1 回の読み取りで引く`, async () => {
    await insertPublicPages(
      Array.from({ length: ROOT_PAGE_LIST_LIMIT + 1 }, (_, i) => `Page ${i}`),
    );
    const statements: { sql: string; params: unknown[] }[] = [];
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(s, p) {
                if (p === "bind") {
                  return (...params: unknown[]) => {
                    statements.push({ sql, params });
                    return s.bind(...params);
                  };
                }
                const value = Reflect.get(s, p, s);
                return typeof value === "function" ? value.bind(s) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const res = await createApp().request("/sitemap.xml", {}, { ...ownerEnv(), DB: db });
    expect(locsOf(await res.text())).toHaveLength(ROOT_PAGE_LIST_LIMIT + 1);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.params).toEqual([SITEMAP_URL_LIMIT]);
    expect(statements[0]?.sql).not.toMatch(/body|excerpt/);
  });

  it("クエリが付いても同じ本文を返し、HEAD は GET と同じステータスとヘッダーを本文なしで返す", async () => {
    const { call, create } = await setup();
    await create("Open Note", "public");
    const plain = await (await call("/sitemap.xml")).text();
    expect(await (await call("/sitemap.xml?visibility=draft")).text()).toBe(plain);
    const head = await call("/sitemap.xml", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(head.headers.get("Cache-Control")).toBe("no-store");
    expect(await head.text()).toBe("");
  });

  it("下の階層と末尾の / は SPA の HTML でなく JSON の 404 にする", async () => {
    const { call } = await setup();
    for (const path of ["/sitemap.xml/", "/sitemap.xml/x"]) {
      const res = await call(path, { headers: { Accept: "text/html" } });
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: "not_found" });
    }
  });

  it("D1 の一覧の取得が失敗したら、空の urlset でなく 503 を no-store で返す", async () => {
    const failingDb = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new Error("D1 is unavailable");
          },
        }),
      }),
    } as unknown as D1Database;
    const res = await createApp().request("/sitemap.xml", {}, { ...ownerEnv(), DB: failingDb });
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).not.toContain("urlset");
  });
});
