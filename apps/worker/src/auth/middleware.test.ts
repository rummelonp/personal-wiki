import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import type { AppEnv } from "../env";
import { generateTestToken, insertToken, lastUsedAt } from "../test/tokens";
import { LAST_USED_UPDATE_INTERVAL_MS } from "./api-tokens";
import {
  allowAnonymous,
  allowAnonymousRead,
  defineBaseMiddleware,
  requireToken,
} from "./middleware";
import { SESSION_COOKIE_NAME } from "./session";

const T0 = Date.UTC(2026, 9, 1);

function buildApp(clock: { now: number } = { now: T0 }) {
  const calls = { undeclared: 0 };
  const app = createApp({ now: () => clock.now })
    .get("/api/test/read", requireToken("read"), (c) => c.json({ principal: c.get("principal") }))
    .post("/api/test/write", requireToken("write"), (c) => c.json({ ok: true }))
    .get("/api/test/undeclared", (c) => {
      calls.undeclared += 1;
      return c.json({ ok: true });
    });
  const request = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    app.request(path, { method, headers }, env);
  return { app, calls, request };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("GET /api/healthz", () => {
  it("Worker の入口から匿名で 200 を返す", async () => {
    const res = await SELF.fetch("https://wiki.example.com/api/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("requireToken", () => {
  it("read のトークンで read のルートが 200 になり、principal が渡る", async () => {
    const token = await insertToken({ name: "laptop", scopes: "read" });
    const res = await buildApp().request("/api/test/read", bearer(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual({
      principal: { kind: "token", name: "laptop", scopes: ["read"] },
    });
  });

  it("write のトークンは read と write の両方のルートを通る", async () => {
    const token = await insertToken({ name: "agent", scopes: "read write" });
    const { request } = buildApp();
    expect((await request("/api/test/read", bearer(token))).status).toBe(200);
    expect((await request("/api/test/write", bearer(token), "POST")).status).toBe(200);
  });

  it("scope が足りなければ 403", async () => {
    const token = await insertToken({ name: "reader", scopes: "read" });
    const res = await buildApp().request("/api/test/write", bearer(token), "POST");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("Authorization が無ければ 401", async () => {
    const res = await buildApp().request("/api/test/read");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("scheme の大文字小文字は問わない", async () => {
    const token = await insertToken({ name: "laptop", scopes: "read" });
    const res = await buildApp().request("/api/test/read", { Authorization: `bearer ${token}` });
    expect(res.status).toBe(200);
  });
});

describe("無効なトークン", () => {
  async function snapshot(res: Response) {
    return {
      status: res.status,
      wwwAuthenticate: res.headers.get("WWW-Authenticate"),
      body: await res.text(),
    };
  }

  it("不正な形式・未登録・失効済み・匿名を区別できない同じ 401 にする", async () => {
    const revoked = await insertToken({ name: "old", scopes: "read write", revokedAt: T0 - 1 });
    const { request } = buildApp();
    const responses = await Promise.all(
      [
        {},
        { Authorization: "Bearer not-a-token" },
        { Authorization: "Bearer" },
        { Authorization: `Basic ${generateTestToken()}` },
        bearer(generateTestToken()),
        bearer(revoked),
      ].map(async (headers) => snapshot(await request("/api/test/read", headers))),
    );
    for (const res of responses) {
      expect(res).toEqual({
        status: 401,
        wwwAuthenticate: "Bearer",
        body: JSON.stringify({ error: "unauthorized" }),
      });
    }
  });

  it("匿名を受け付けるルートでも、無効なトークンを送れば 401", async () => {
    const res = await buildApp().request("/api/healthz", bearer(generateTestToken()));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("失効したトークンの last_used_at は書き換えない", async () => {
    const revoked = await insertToken({ name: "old", scopes: "read", revokedAt: T0 - 1 });
    await buildApp().request("/api/test/read", bearer(revoked));
    expect(await lastUsedAt("old")).toBeNull();
  });
});

describe("Cookie と Bearer の併用", () => {
  it("有効なトークンでも自前のセッション cookie と一緒なら 400", async () => {
    const token = await insertToken({ name: "laptop", scopes: "read" });
    const res = await buildApp().request("/api/test/read", {
      ...bearer(token),
      Cookie: `${SESSION_COOKIE_NAME}=anything`,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "ambiguous_credentials" });
    // 拒否したリクエストは使用として記録しない
    expect(await lastUsedAt("laptop")).toBeNull();
  });

  it("第三者の cookie なら Bearer の妨げにしない", async () => {
    const token = await insertToken({ name: "laptop", scopes: "read" });
    const res = await buildApp().request("/api/test/read", {
      ...bearer(token),
      Cookie: "__cf_bm=anything; session=anything",
    });
    expect(res.status).toBe(200);
  });

  it("検証できない cookie だけなら匿名として扱う", async () => {
    const res = await buildApp().request("/api/healthz", {
      Cookie: `${SESSION_COOKIE_NAME}=anything`,
    });
    expect(res.status).toBe(200);
  });
});

describe("認可の宣言が無いルート", () => {
  it("有効なトークンでもハンドラを呼ばずに 404 にする", async () => {
    const token = await insertToken({ name: "agent", scopes: "read write" });
    const { request, calls } = buildApp();
    for (const headers of [{}, bearer(token)]) {
      const res = await request("/api/test/undeclared", headers);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(calls.undeclared).toBe(0);
  });

  it("存在しないパスも同じ 404 にする", async () => {
    const res = await buildApp().request("/api/nothing");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("無効なトークンなら、宣言の無いパスでも 404 より先に 401 にする", async () => {
    const res = await buildApp().request("/api/test/undeclared", bearer(generateTestToken()));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  describe("別の登録の宣言に便乗させない", () => {
    const undeclared = vi.fn((c: Context) => c.text("secret"));
    const declared = (c: Context) => c.text("declared");

    beforeEach(() => {
      undeclared.mockClear();
    });

    async function expectRejected(app: Hono<AppEnv>, path: string, method = "GET") {
      const res = await app.request(path, { method }, env);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect(undeclared).not.toHaveBeenCalled();
    }

    it("後ろに登録した、同じパスにマッチするパラメータ付きルートの宣言", async () => {
      const app = createApp()
        .get("/api/pages/secret", undeclared)
        .get("/api/pages/:slug", requireToken("write"), declared);
      await expectRejected(app, "/api/pages/secret");
    });

    it("SPA の catch-all に付けた allowAnonymous()", async () => {
      const app = createApp().post("/api/x", undeclared).all("*", allowAnonymous(), declared);
      await expectRejected(app, "/api/x", "POST");
    });

    it("prefix の use() に付けた宣言", async () => {
      const app = createApp().use("/api/*", allowAnonymous()).get("/api/secret", undeclared);
      await expectRejected(app, "/api/secret");
    });

    it("ハンドラより後ろに登録した宣言", async () => {
      const app = createApp().get("/api/x", undeclared).use("/api/*", requireToken("read"));
      await expectRejected(app, "/api/x");
    });

    it("同じパス・同じ method でも、ハンドラより後ろに登録した宣言", async () => {
      const app = createApp()
        .get("/api/x", undeclared)
        .get("/api/x", requireToken("read"), declared);
      await expectRejected(app, "/api/x");
    });

    it("同じパスの別の method にだけ付けた宣言", async () => {
      const app = createApp()
        .get("/api/x", allowAnonymous(), declared)
        .on(["GET", "POST"], "/api/x", undeclared);
      await expectRejected(app, "/api/x", "POST");
    });

    it("use() の宣言の後ろに登録した method 別のハンドラ", async () => {
      const app = createApp().use("/api/x", allowAnonymous()).put("/api/x", undeclared);
      await expectRejected(app, "/api/x", "PUT");
    });

    it("all() の宣言の後ろに登録した method 別のハンドラ", async () => {
      const app = createApp()
        .all("/api/x", allowAnonymous(), async (_c, next) => next())
        .post("/api/x", undeclared);
      await expectRejected(app, "/api/x", "POST");
    });

    it("GET の宣言の後ろに登録した all() のハンドラ", async () => {
      const app = createApp()
        .get("/api/x", allowAnonymous(), async (_c, next) => next())
        .all("/api/x", undeclared);
      await expectRejected(app, "/api/x");
    });

    it("基盤として登録したハンドラを個別のルートに置いたもの", async () => {
      const app = createApp().get(
        "/api/x",
        defineBaseMiddleware(createMiddleware(async (c) => undeclared(c))),
      );
      await expectRejected(app, "/api/x");
    });

    it("基盤として登録していない全体の middleware", async () => {
      const app = createApp()
        .use("*", async (_c, next) => next())
        .get("/api/x", allowAnonymous(), undeclared);
      await expectRejected(app, "/api/x");
    });
  });

  it("基盤として登録した middleware は宣言を要求しない", async () => {
    const app = createApp()
      .use(
        "*",
        defineBaseMiddleware(
          createMiddleware(async (c, next) => {
            await next();
            c.header("X-Base", "1");
          }),
        ),
      )
      .get("/api/x", allowAnonymous(), (c) => c.text("ok"));
    const res = await app.request("/api/x", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Base")).toBe("1");
  });

  it("onError を持つ子 app を合成しても、子 app のルートの宣言を認める", async () => {
    const token = await insertToken({ name: "laptop", scopes: "read" });
    const child = new Hono<AppEnv>()
      .onError((_err, c) => c.text("child error", 500))
      .get("/read", requireToken("read"), (c) => c.text("ok"))
      .get("/public", allowAnonymous(), (c) => c.text("ok"));
    const app = createApp().route("/api/child", child);
    expect((await app.request("/api/child/read", { headers: bearer(token) }, env)).status).toBe(
      200,
    );
    expect((await app.request("/api/child/read", {}, env)).status).toBe(401);
    expect((await app.request("/api/child/public", {}, env)).status).toBe(200);
  });
});

describe("同じパスに付けた宣言", () => {
  const mcp = (req: Request) => new Response(`mcp ${new URL(req.url).pathname}`);

  it("use() の宣言で、同じパスに mount したアプリを守る", async () => {
    const token = await insertToken({ name: "agent", scopes: "read" });
    const app = createApp().use("/mcp/*", requireToken("read")).mount("/mcp", mcp);
    const ok = await app.request("/mcp/tools", { headers: bearer(token) }, env);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("mcp /tools");
    expect((await app.request("/mcp/tools", {}, env)).status).toBe(401);
  });

  it("all() の宣言でハンドラを守る", async () => {
    const token = await insertToken({ name: "agent", scopes: "read" });
    // createApp が実際の /mcp を登録するので、別の path で確かめる
    const app = createApp().all("/api/test/all", requireToken("read"), (c) => c.text("ok"));
    expect(
      (await app.request("/api/test/all", { method: "POST", headers: bearer(token) }, env)).status,
    ).toBe(200);
    expect((await app.request("/api/test/all", { method: "POST" }, env)).status).toBe(401);
  });

  it("SPA の catch-all は匿名で通り、API の宣言はそのまま効く", async () => {
    const assets = { fetch: async () => new Response("spa") } as unknown as Fetcher;
    const app = createApp().get("/api/test/:slug", requireToken("read"), (c) => c.text("page"));
    const spa = await app.request("/pages/home", {}, { ...env, ASSETS: assets });
    expect(spa.status).toBe(200);
    expect(await spa.text()).toBe("spa");
    expect((await app.request("/api/test/home", {}, { ...env, ASSETS: assets })).status).toBe(401);
  });
});

describe("/api/* の X-Robots-Tag", () => {
  it("早期の 401 と 404 も含めて noindex を付ける", async () => {
    const { request } = buildApp();
    for (const [path, headers, status] of [
      ["/api/healthz", {}, 200],
      ["/api/test/read", {}, 401],
      ["/api/healthz", bearer(generateTestToken()), 401],
      ["/api/test/missing", {}, 404],
    ] as const) {
      const res = await request(path, headers);
      expect(res.status, path).toBe(status);
      expect(res.headers.get("X-Robots-Tag"), path).toBe("noindex");
    }
  });
});

describe("allowAnonymousRead", () => {
  it("変更系の method に付けても、匿名は 401 で、read の token は通る", async () => {
    const token = await insertToken({ name: "reader", scopes: "read" });
    const app = createApp().post("/api/test/misdeclared", allowAnonymousRead(), (c) =>
      c.json({ ok: true }),
    );
    const anonymous = await app.request("/api/test/misdeclared", { method: "POST" }, env);
    expect(anonymous.status).toBe(401);
    const viaToken = await app.request(
      "/api/test/misdeclared",
      { method: "POST", headers: bearer(token) },
      env,
    );
    expect(viaToken.status).toBe(200);
  });

  it("匿名の GET と HEAD は通す", async () => {
    const app = createApp().get("/api/test/open", allowAnonymousRead(), (c) =>
      c.json({ ok: true }),
    );
    for (const method of ["GET", "HEAD"]) {
      const res = await app.request("/api/test/open", { method }, env);
      expect(res.status, method).toBe(200);
    }
  });
});

describe("キャッシュの制御", () => {
  it("トークンで認証した応答は、拒否も含めて共有キャッシュに載せない", async () => {
    const token = await insertToken({ name: "reader", scopes: "read" });
    const { request } = buildApp();
    for (const res of [
      await request("/api/test/read", bearer(token)),
      await request("/api/test/write", bearer(token), "POST"),
      await request("/api/healthz", bearer(token)),
    ]) {
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("Vary")).toBe("Authorization, Cookie");
    }
  });

  it("匿名の応答は、ハンドラが Cache-Control を付けていなければ no-store にする", async () => {
    const app = createApp()
      .get("/api/test/plain", allowAnonymous(), (c) => c.json({ ok: true }))
      .get("/api/test/cacheable", allowAnonymous(), (c) => {
        c.header("Cache-Control", "no-cache");
        return c.json({ ok: true });
      });
    for (const path of ["/api/healthz", "/api/test/plain", "/api/test/missing"]) {
      const res = await app.request(path, {}, env);
      expect(res.headers.get("Cache-Control"), path).toBe("no-store");
      expect(res.headers.get("Vary"), path).toBe("Authorization, Cookie");
    }
    const cacheable = await app.request("/api/test/cacheable", {}, env);
    expect(cacheable.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("ハンドラが直接返した Response にも付ける", async () => {
    const token = await insertToken({ name: "reader", scopes: "read" });
    const app = createApp().get("/api/raw", requireToken("read"), () =>
      Response.redirect("https://wiki.example.com/", 302),
    );
    const res = await app.request("/api/raw", { headers: bearer(token) }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("last_used_at", () => {
  it("初回に記録し、間隔が空くまでは書き直さない", async () => {
    const token = await insertToken({ name: "laptop", scopes: "read" });
    const clock = { now: T0 };
    const { request } = buildApp(clock);

    await request("/api/test/read", bearer(token));
    expect(await lastUsedAt("laptop")).toBe(T0);

    clock.now = T0 + LAST_USED_UPDATE_INTERVAL_MS - 1;
    await request("/api/test/read", bearer(token));
    expect(await lastUsedAt("laptop")).toBe(T0);

    clock.now = T0 + LAST_USED_UPDATE_INTERVAL_MS;
    await request("/api/test/read", bearer(token));
    expect(await lastUsedAt("laptop")).toBe(T0 + LAST_USED_UPDATE_INTERVAL_MS);
  });
});
