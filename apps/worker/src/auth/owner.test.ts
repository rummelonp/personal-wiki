import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { Bindings } from "../env";
import {
  fakeJwks,
  ownerCookie,
  ownerEnv,
  ownerEnvWithoutBucket,
  SESSION_SECRET,
  signAccessJwt,
  signingKey,
  TEAM_DOMAIN,
} from "../test/owner";
import { insertToken } from "../test/tokens";
import { safeReturnUrl } from "./routes";
import { SESSION_COOKIE_NAME } from "./session";

const T0 = Date.UTC(2026, 9, 1);
const ORIGIN = "http://localhost";
const DAY_MS = 24 * 60 * 60 * 1000;

async function setup() {
  const key = await signingKey("key-1");
  const jwks = fakeJwks([key]);
  const clock = { now: T0 };
  const app = createApp({ now: () => clock.now, accessFetch: jwks.fetch, recordWrite: () => {} });
  const request = (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
    bindings: Bindings = ownerEnv(),
  ) =>
    app.request(
      path,
      { method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ?? null },
      bindings,
    );
  return { key, jwks, clock, app, request };
}

/** SPA の fetch と同じ形の、owner の cookie 付きの同一オリジンのリクエスト。 */
function ownerInit(
  cookie: string,
  method: string,
  json?: unknown,
  headers: Record<string, string> = {},
) {
  return {
    method,
    headers: {
      Cookie: cookie,
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      ...headers,
    },
    body: json === undefined ? "{}" : JSON.stringify(json),
  };
}

const getMe = async (res: Response) => ((await res.json()) as { kind: string }).kind;

describe("GET /_auth/login", () => {
  it("正しい JWT なら cookie を発行し、return のパスへ戻す", async () => {
    const { key, request } = await setup();
    const res = await request("/_auth/login?return=%2Fp%2Fabc%3Fx%3D1", {
      headers: { "Cf-Access-Jwt-Assertion": await signAccessJwt(key, T0) },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/p/abc?x=1`);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(
      new RegExp(`^${SESSION_COOKIE_NAME}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+;`),
    );
    for (const attribute of ["Max-Age=86400", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) {
      expect(setCookie).toContain(attribute);
    }
    expect(setCookie).not.toContain("Domain");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("発行した cookie で owner になり、24 時間で切れる", async () => {
    const { key, request, clock } = await setup();
    const login = await request("/_auth/login", {
      headers: { "Cf-Access-Jwt-Assertion": await signAccessJwt(key, T0) },
    });
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    expect(await getMe(await request("/api/me", { headers: { Cookie: cookie } }))).toBe("owner");
    clock.now = T0 + DAY_MS - 1;
    expect(await getMe(await request("/api/me", { headers: { Cookie: cookie } }))).toBe("owner");
    clock.now = T0 + DAY_MS;
    expect(await getMe(await request("/api/me", { headers: { Cookie: cookie } }))).toBe(
      "anonymous",
    );
  });

  it("許可リストに無いメールは 403 で、cookie を出さない", async () => {
    const { key, request } = await setup();
    const res = await request("/_auth/login", {
      headers: {
        "Cf-Access-Jwt-Assertion": await signAccessJwt(key, T0, {
          payload: { email: "stranger@example.com" },
        }),
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("JWT が無いか検証に通らなければ 403", async () => {
    const { key, request } = await setup();
    expect((await request("/_auth/login")).status).toBe(403);
    const res = await request("/_auth/login", {
      headers: {
        "Cf-Access-Jwt-Assertion": await signAccessJwt(key, T0, { payload: { aud: ["x"] } }),
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("ACCESS_TEAM_DOMAIN を大文字で書いても iss と照合できる", async () => {
    const { key, request } = await setup();
    const res = await request(
      "/_auth/login",
      { headers: { "Cf-Access-Jwt-Assertion": await signAccessJwt(key, T0) } },
      { ...ownerEnv(), ACCESS_TEAM_DOMAIN: ` ${TEAM_DOMAIN.toUpperCase()} ` } as Bindings,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain(SESSION_COOKIE_NAME);
  });

  it("設定が 1 つでも欠けていれば JWKS を引かずに失敗する", async () => {
    const { key, request, jwks } = await setup();
    const jwt = await signAccessJwt(key, T0);
    for (const missing of [
      { ACCESS_TEAM_DOMAIN: undefined },
      { ACCESS_AUD: undefined },
      { OWNER_EMAILS: undefined },
      { OWNER_EMAILS: " , " },
      { SESSION_SECRET: undefined },
      { SESSION_SECRET: "short" },
      { ACCESS_TEAM_DOMAIN: "https://team.example/" },
    ]) {
      const bindings = { ...ownerEnv(), ...missing } as Bindings;
      const res = await request(
        "/_auth/login",
        { headers: { "Cf-Access-Jwt-Assertion": jwt } },
        bindings,
      );
      expect(res.status).toBe(500);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
    expect(jwks.state.calls).toBe(0);
  });
});

describe("safeReturnUrl（open redirect の拒否）", () => {
  it("同じオリジンのパスだけを通し、それ以外は / にする", () => {
    const origin = "https://wiki.example.com";
    const cases: [string | undefined, string][] = [
      ["/p/abc", `${origin}/p/abc`],
      ["/%E3%83%9A%E3%83%BC%E3%82%B8?q=1#h", `${origin}/%E3%83%9A%E3%83%BC%E3%82%B8?q=1#h`],
      ["/ページ", `${origin}/%E3%83%9A%E3%83%BC%E3%82%B8`],
      // 正規化で // から始まるパスになっても、絶対 URL で返すので別ホストへは飛ばない
      ["/.//evil.example", `${origin}//evil.example`],
      [undefined, `${origin}/`],
      ["", `${origin}/`],
      ["//evil.example", `${origin}/`],
      ["/\\evil.example", `${origin}/`],
      ["\\\\evil.example", `${origin}/`],
      ["/\t/evil.example", `${origin}/`],
      ["/\n/evil.example", `${origin}/`],
      ["https://evil.example/", `${origin}/`],
      ["javascript:alert(1)", `${origin}/`],
      ["evil.example", `${origin}/`],
      ["/_auth/login", `${origin}/`],
      ["/_auth", `${origin}/`],
      // Hono は %XX を復号してからルートを照合するので、/%5Fauth/login も login のルートに届く
      ["/%5Fauth/login", `${origin}/`],
      ["/%5F%61uth/x", `${origin}/`],
      ["/%E0%A4%A", `${origin}/`],
      [`/${"a".repeat(2048)}`, `${origin}/`],
      // OAuth の同意画面と接続の一覧だけは /_auth/ 以下でも戻す。それ以外の /_auth/oauth/* には戻さない
      ["/_auth/oauth/authorize?client_id=x", `${origin}/_auth/oauth/authorize?client_id=x`],
      ["/_auth/oauth/grants", `${origin}/_auth/oauth/grants`],
      ["/_auth/oauth/token", `${origin}/`],
      ["/_auth/oauth/grants/revoke", `${origin}/`],
      ["/_auth/oauth/authorize/x", `${origin}/`],
    ];
    for (const [raw, expected] of cases) {
      expect(safeReturnUrl(raw, origin), String(raw)).toBe(expected);
    }
  });

  it("login の Location にも同じ規則を当てる", async () => {
    const { key, request } = await setup();
    const res = await request(`/_auth/login?return=${encodeURIComponent("//evil.example/x")}`, {
      headers: { "Cf-Access-Jwt-Assertion": await signAccessJwt(key, T0) },
    });
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/`);
  });
});

describe("セッション cookie の検証", () => {
  it("改ざん、期限切れ、別の秘密で署名したものは anonymous", async () => {
    const { request, clock } = await setup();
    const valid = await ownerCookie(T0);
    const value = valid.slice(SESSION_COOKIE_NAME.length + 1);
    const [payload, signature] = value.split(".") as [string, string];
    const flipped = signature.startsWith("A") ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    const forgedPayload = btoa(JSON.stringify({ e: "owner@example.com", exp: 9999999999 }))
      .replaceAll("=", "")
      .replaceAll("+", "-")
      .replaceAll("/", "_");
    const cookies = [
      `${SESSION_COOKIE_NAME}=${payload}.${flipped}`,
      `${SESSION_COOKIE_NAME}=${forgedPayload}.${signature}`,
      `${SESSION_COOKIE_NAME}=${payload}`,
      `${SESSION_COOKIE_NAME}=`,
      await ownerCookie(T0, "x".repeat(44)),
    ];
    for (const cookie of cookies) {
      const res = await request("/api/me", { headers: { Cookie: cookie } });
      expect(res.status, cookie).toBe(200);
      expect(await getMe(res), cookie).toBe("anonymous");
    }
    expect(await getMe(await request("/api/me", { headers: { Cookie: valid } }))).toBe("owner");
    clock.now = T0 + DAY_MS;
    expect(await getMe(await request("/api/me", { headers: { Cookie: valid } }))).toBe("anonymous");
  });

  it("設定が欠けている、または許可リストからメールを外したら、有効な署名でも anonymous", async () => {
    const { request } = await setup();
    const cookie = await ownerCookie(T0);
    for (const overrides of [
      { SESSION_SECRET: undefined },
      { ACCESS_AUD: undefined },
      { ACCESS_TEAM_DOMAIN: undefined },
      { OWNER_EMAILS: "other@example.com" },
    ]) {
      const bindings = { ...ownerEnv(), ...overrides } as Bindings;
      const res = await request("/api/me", { headers: { Cookie: cookie } }, bindings);
      expect(await getMe(res)).toBe("anonymous");
    }
    // 素の env（設定が何も無い）でも同じ
    expect(await getMe(await request("/api/me", { headers: { Cookie: cookie } }, env))).toBe(
      "anonymous",
    );
  });

  it("名前の違う cookie は見ない", async () => {
    const { request } = await setup();
    const value = (await ownerCookie(T0)).slice(SESSION_COOKIE_NAME.length + 1);
    const res = await request("/api/me", { headers: { Cookie: `wiki_session=${value}` } });
    expect(await getMe(res)).toBe("anonymous");
  });
});

describe("GET /api/me", () => {
  it("principal の種類を返し、キャッシュさせない", async () => {
    const { request } = await setup();
    const token = await insertToken({ name: "laptop", scopes: "read" });
    const owner = await request("/api/me", { headers: { Cookie: await ownerCookie(T0) } });
    expect(await owner.json()).toEqual({
      kind: "owner",
      features: { attachments: true, linkRewrites: true },
    });
    expect(owner.headers.get("Cache-Control")).toBe("private, no-store");
    const viaToken = await request("/api/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(await viaToken.json()).toEqual({
      kind: "token",
      name: "laptop",
      scopes: ["read"],
      features: { attachments: true, linkRewrites: true },
    });
    const anonymous = await request("/api/me");
    expect(await anonymous.json()).toEqual({
      kind: "anonymous",
      features: { attachments: true, linkRewrites: true },
    });
    expect(anonymous.headers.get("Cache-Control")).toBe("no-store");
  });

  it("R2 の binding が無ければ features.attachments は false", async () => {
    const { request } = await setup();
    const res = await request("/api/me", {}, ownerEnvWithoutBucket());
    expect(await res.json()).toEqual({
      kind: "anonymous",
      features: { attachments: false, linkRewrites: true },
    });
  });
});

describe("CSRF", () => {
  const createBody = { title: "CSRF", body: "" };

  it("同一オリジンの JSON のリクエストは通る（Origin か Sec-Fetch-Site のどちらかでよい）", async () => {
    const { request } = await setup();
    const cookie = await ownerCookie(T0);
    const both = await request("/api/pages", ownerInit(cookie, "POST", createBody));
    expect(both.status).toBe(201);
    const originOnly = ownerInit(cookie, "POST", { title: "CSRF 2", body: "" });
    delete (originOnly.headers as Record<string, string>)["Sec-Fetch-Site"];
    expect((await request("/api/pages", originOnly)).status).toBe(201);
    const fetchSiteOnly = ownerInit(cookie, "POST", { title: "CSRF 3", body: "" });
    delete (fetchSiteOnly.headers as Record<string, string>).Origin;
    expect((await request("/api/pages", fetchSiteOnly)).status).toBe(201);
  });

  it("Content-Type の大文字小文字と charset の違いは JSON として通す", async () => {
    const { request } = await setup();
    const cookie = await ownerCookie(T0);
    for (const [i, contentType] of [
      "application/json; charset=utf-8",
      "Application/JSON",
      "application/json;charset=UTF-8",
    ].entries()) {
      const init = ownerInit(
        cookie,
        "POST",
        { title: `CSRF type ${i}`, body: "" },
        { "Content-Type": contentType },
      );
      expect((await request("/api/pages", init)).status, contentType).toBe(201);
    }
  });

  it("Origin と Sec-Fetch-Site が無い、別オリジン、JSON でない cookie 付きの変更系を拒む", async () => {
    const { request } = await setup();
    const cookie = await ownerCookie(T0);
    const variants: Record<string, string | undefined>[] = [
      { Origin: undefined, "Sec-Fetch-Site": undefined },
      { Origin: "https://evil.example", "Sec-Fetch-Site": undefined },
      { Origin: "https://evil.example" },
      { "Sec-Fetch-Site": "same-site" },
      { "Sec-Fetch-Site": "cross-site", Origin: undefined },
      { Origin: "null" },
      { "Content-Type": "text/plain" },
      { "Content-Type": "application/x-www-form-urlencoded" },
      { "Content-Type": undefined },
    ];
    for (const variant of variants) {
      const init = ownerInit(cookie, "POST", createBody);
      const headers = { ...init.headers, ...variant } as Record<string, string | undefined>;
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) delete headers[name];
      }
      const res = await request("/api/pages", {
        ...init,
        headers: headers as Record<string, string>,
      });
      expect(res.status, JSON.stringify(variant)).toBe(403);
      expect(await res.json()).toEqual({ error: "csrf_rejected" });
    }
    const { results } = await env.DB.prepare("SELECT id FROM pages").all();
    expect(results).toHaveLength(0);
  });

  it("PUT、DELETE、ログアウトも対象にする", async () => {
    const { request } = await setup();
    const cookie = await ownerCookie(T0);
    for (const [method, path] of [
      ["PUT", "/api/pages/AAAAAAAAAAAAAAAAAAAAAA"],
      ["DELETE", "/api/pages/AAAAAAAAAAAAAAAAAAAAAA"],
      ["PUT", "/api/pages/AAAAAAAAAAAAAAAAAAAAAA/visibility"],
      ["POST", "/_auth/logout"],
    ] as const) {
      const res = await request(path, {
        method,
        headers: {
          Cookie: cookie,
          Origin: "https://evil.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
  });

  it("Bearer のリクエストは Origin や Content-Type を問わない", async () => {
    const { request } = await setup();
    const token = await insertToken({ name: "agent", scopes: "read write" });
    const res = await request("/api/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
        "Content-Type": "text/plain",
      },
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /_auth/logout", () => {
  it("cookie を消す", async () => {
    const { request } = await setup();
    const res = await request("/_auth/logout", ownerInit(await ownerCookie(T0), "POST"));
    expect(res.status).toBe(204);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=;`));
    for (const attribute of ["Max-Age=0", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) {
      expect(setCookie).toContain(attribute);
    }
  });

  it("GET では受け付けない", async () => {
    const { request } = await setup();
    const res = await request("/_auth/logout", { headers: { Cookie: await ownerCookie(T0) } });
    expect(res.status).toBe(404);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("セッション cookie と Bearer の併用", () => {
  it("自前のセッション cookie と Authorization の併用は、cookie の有効性を問わず 400", async () => {
    const { request } = await setup();
    const token = await insertToken({ name: "agent", scopes: "read" });
    for (const cookie of [await ownerCookie(T0), `${SESSION_COOKIE_NAME}=garbage`]) {
      const res = await request("/api/me", {
        headers: { Cookie: `__cf_bm=x; ${cookie}`, Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "ambiguous_credentials" });
    }
  });

  it("第三者の cookie と Bearer は token として通る", async () => {
    const { request } = await setup();
    const token = await insertToken({ name: "agent", scopes: "read" });
    const res = await request("/api/me", {
      headers: {
        Cookie: "__cf_bm=abc; CF_Authorization=eyJ.x.y; wiki_session=z",
        Authorization: `Bearer ${token}`,
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: "token",
      name: "agent",
      scopes: ["read"],
      features: { attachments: true, linkRewrites: true },
    });
  });
});

describe("owner のページ API", () => {
  it("作成、取得、更新、追記、検索、最近、backlink、作り直しを使え、actor は owner", async () => {
    const { request } = await setup();
    const cookie = await ownerCookie(T0);
    const get = (path: string) => request(path, { headers: { Cookie: cookie } });

    const created = await request(
      "/api/pages",
      ownerInit(cookie, "POST", { title: "Owner Page", body: "hello world #owner" }),
    );
    expect(created.status).toBe(201);
    const page = (await created.json()) as { id: string; version: number; visibility: string };
    expect(page.visibility).toBe("draft");
    const linking = await request(
      "/api/pages",
      ownerInit(cookie, "POST", { title: "Linking", body: "[[Owner Page]]" }),
    );
    expect(linking.status).toBe(201);

    expect((await get(`/api/pages/${page.id}`)).status).toBe(200);
    expect((await get("/api/pages/by-title?title=Owner%20Page")).status).toBe(200);
    expect((await get("/api/search?q=hello")).status).toBe(200);
    expect((await get("/api/pages/recent")).status).toBe(200);
    expect((await get("/api/pages/recent?tag=owner")).status).toBe(200);
    const tags = await get("/api/tags");
    expect(tags.status).toBe(200);
    expect(await tags.json()).toEqual({ tags: [{ tag: "owner", count: 1 }] });
    const backlinks = await get(`/api/pages/${page.id}/backlinks`);
    expect(((await backlinks.json()) as { pages: unknown[] }).pages).toHaveLength(1);

    const updated = await request(
      `/api/pages/${page.id}`,
      ownerInit(cookie, "PUT", { title: "Owner Page", body: "updated" }, { "If-Match": '"1"' }),
    );
    expect(updated.status).toBe(200);
    const appended = await request(
      `/api/pages/${page.id}/append`,
      ownerInit(cookie, "POST", { text: "more" }),
    );
    expect(appended.status).toBe(200);
    const rebuild = await request("/api/admin/derived/rebuild", ownerInit(cookie, "POST", {}));
    expect(rebuild.status).toBe(200);
    const step = await request("/api/link-rewrites/step", ownerInit(cookie, "POST", {}));
    expect(step.status).toBe(200);

    const { results } = await env.DB.prepare(
      "SELECT DISTINCT actor FROM revisions WHERE page_id = ?",
    )
      .bind(page.id)
      .all<{ actor: string }>();
    expect(results.map((r) => r.actor)).toEqual(["owner"]);
  });

  it("匿名はページの書き込みに 401 のまま", async () => {
    const { request } = await setup();
    const id = "AAAAAAAAAAAAAAAAAAAAAA";
    const json = { "Content-Type": "application/json", "If-Match": '"1"' };
    for (const [method, path, body] of [
      ["POST", "/api/pages", { title: "x", body: "" }],
      ["PUT", `/api/pages/${id}`, { title: "x", body: "" }],
      ["POST", `/api/pages/${id}/append`, { text: "x" }],
      ["DELETE", `/api/pages/${id}`, undefined],
      ["PUT", `/api/pages/${id}/visibility`, { visibility: "public" }],
      ["POST", "/api/admin/derived/rebuild", {}],
      ["POST", "/api/link-rewrites/step", {}],
    ] as const) {
      const res = await request(path, {
        method,
        headers: json,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("owner の cookie では /mcp に入れない", async () => {
    const { request } = await setup();
    const res = await request(
      "/mcp",
      ownerInit(
        await ownerCookie(T0),
        "POST",
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        {
          Accept: "application/json, text/event-stream",
        },
      ),
    );
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/pages/:id/visibility", () => {
  async function createPage(request: Awaited<ReturnType<typeof setup>>["request"]) {
    const token = await insertToken({ name: "writer", scopes: "read write" });
    const res = await request("/api/pages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Visibility", body: "body" }),
    });
    const page = (await res.json()) as { id: string; version: number };
    return { page, token };
  }

  async function revisionCount(id: string) {
    const row = await env.DB.prepare("SELECT count(*) AS n FROM revisions WHERE page_id = ?")
      .bind(id)
      .first<{ n: number }>();
    return row?.n;
  }

  it("owner は public と draft を切り替えられ、変えたときだけ版を進める。revision は積まない", async () => {
    const { request, clock } = await setup();
    const { page } = await createPage(request);
    const cookie = await ownerCookie(T0);
    clock.now = T0 + 1000;

    const published = await request(
      `/api/pages/${page.id}/visibility`,
      ownerInit(cookie, "PUT", { visibility: "public" }),
    );
    expect(published.status).toBe(200);
    expect(published.headers.get("ETag")).toBe('"2"');
    expect(await published.json()).toMatchObject({
      id: page.id,
      visibility: "public",
      version: 2,
      updatedAt: T0 + 1000,
    });

    const again = await request(
      `/api/pages/${page.id}/visibility`,
      ownerInit(cookie, "PUT", { visibility: "public" }),
    );
    expect(await again.json()).toMatchObject({ visibility: "public", version: 2 });

    const back = await request(
      `/api/pages/${page.id}/visibility`,
      ownerInit(cookie, "PUT", { visibility: "draft" }),
    );
    expect(await back.json()).toMatchObject({ visibility: "draft", version: 3 });
    expect(await revisionCount(page.id)).toBe(1);
  });

  it("visibility を変える前の版で本文を更新すると 409 になる", async () => {
    const { request } = await setup();
    const { page, token } = await createPage(request);
    await request(
      `/api/pages/${page.id}/visibility`,
      ownerInit(await ownerCookie(T0), "PUT", { visibility: "public" }),
    );
    const res = await request(`/api/pages/${page.id}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "If-Match": `"${page.version}"`,
      },
      body: JSON.stringify({ title: "Visibility", body: "secret" }),
    });
    expect(res.status).toBe(409);
  });

  it("read と write の token は scope に関係なく 403、匿名は 401 で、何も変わらない", async () => {
    const { request } = await setup();
    const { page, token: writer } = await createPage(request);
    const reader = await insertToken({ name: "reader", scopes: "read" });
    for (const token of [writer, reader]) {
      const res = await request(`/api/pages/${page.id}/visibility`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    const anonymous = await request(`/api/pages/${page.id}/visibility`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(anonymous.status).toBe(401);
    const row = await env.DB.prepare("SELECT visibility, version FROM pages WHERE id = ?")
      .bind(page.id)
      .first();
    expect(row).toEqual({ visibility: "draft", version: 1 });
  });

  it("本文のエラーは 400、無いページは 404", async () => {
    const { request } = await setup();
    const { page } = await createPage(request);
    const cookie = await ownerCookie(T0);
    const put = (id: string, json: unknown) =>
      request(`/api/pages/${id}/visibility`, ownerInit(cookie, "PUT", json));
    expect(await (await put(page.id, {})).json()).toEqual({
      error: "missing_field",
      field: "visibility",
    });
    expect(await (await put(page.id, { visibility: "private" })).json()).toEqual({
      error: "invalid_field",
      field: "visibility",
    });
    expect(await (await put(page.id, { visibility: "public", title: "x" })).json()).toEqual({
      error: "unknown_field",
      field: "title",
    });
    expect((await put(page.id, [])).status).toBe(400);
    expect((await put("AAAAAAAAAAAAAAAAAAAAAA", { visibility: "public" })).status).toBe(404);
    expect((await put("short", { visibility: "public" })).status).toBe(404);
  });

  it("削除したページは 404 で、visibility を変えない", async () => {
    const { request } = await setup();
    const { page, token } = await createPage(request);
    const deleted = await request(`/api/pages/${page.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "If-Match": `"${page.version}"` },
    });
    expect(deleted.status).toBe(204);
    const res = await request(
      `/api/pages/${page.id}/visibility`,
      ownerInit(await ownerCookie(T0), "PUT", { visibility: "public" }),
    );
    expect(res.status).toBe(404);
    const row = await env.DB.prepare("SELECT visibility FROM pages WHERE id = ?")
      .bind(page.id)
      .first();
    expect(row).toEqual({ visibility: "draft" });
  });

  describe("If-Match（任意）", () => {
    it("今の版と合えば変え、合わなければ 409 で何も変えない", async () => {
      const { request } = await setup();
      const { page } = await createPage(request);
      const cookie = await ownerCookie(T0);
      const put = (visibility: string, ifMatch: string) =>
        request(
          `/api/pages/${page.id}/visibility`,
          ownerInit(cookie, "PUT", { visibility }, { "If-Match": ifMatch }),
        );

      const stale = await put("public", '"5"');
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: "version_conflict", currentVersion: 1 });

      const published = await put("public", '"1"');
      expect(published.status).toBe(200);
      expect(await published.json()).toMatchObject({ visibility: "public", version: 2 });

      // 同じ visibility でも、古い版を指していれば 409
      const sameButStale = await put("public", '"1"');
      expect(sameButStale.status).toBe(409);
      expect(await sameButStale.json()).toMatchObject({ currentVersion: 2 });
      const same = await put("public", "2");
      expect(await same.json()).toMatchObject({ visibility: "public", version: 2 });

      const row = await env.DB.prepare("SELECT visibility, version FROM pages WHERE id = ?")
        .bind(page.id)
        .first();
      expect(row).toEqual({ visibility: "public", version: 2 });
    });

    it("形式の崩れた If-Match は 400", async () => {
      const { request } = await setup();
      const { page } = await createPage(request);
      for (const ifMatch of ["abc", '"0"', "*", 'W/"1"']) {
        const res = await request(
          `/api/pages/${page.id}/visibility`,
          ownerInit(
            await ownerCookie(T0),
            "PUT",
            { visibility: "public" },
            { "If-Match": ifMatch },
          ),
        );
        expect(res.status, ifMatch).toBe(400);
        expect(await res.json()).toMatchObject({ error: "invalid_if_match" });
      }
    });

    it("無いページは If-Match が付いていても 404", async () => {
      const { request } = await setup();
      const res = await request(
        "/api/pages/AAAAAAAAAAAAAAAAAAAAAA/visibility",
        ownerInit(await ownerCookie(T0), "PUT", { visibility: "public" }, { "If-Match": '"1"' }),
      );
      expect(res.status).toBe(404);
    });
  });
});

describe("SESSION_SECRET", () => {
  it("テストの秘密は短すぎる値の下限を超えている", () => {
    expect(SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
  });
});
