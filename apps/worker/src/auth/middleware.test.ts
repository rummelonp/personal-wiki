import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { AppEnv } from "../env";
import { generateTestToken, insertToken, lastUsedAt } from "../test/tokens";
import { LAST_USED_UPDATE_INTERVAL_MS } from "./api-tokens";
import { allowAnonymous, requireToken } from "./middleware";

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
  it("有効なトークンでも Cookie と一緒なら 400", async () => {
    const token = await insertToken({ name: "laptop", scopes: "read" });
    const res = await buildApp().request("/api/test/read", {
      ...bearer(token),
      Cookie: "session=anything",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "ambiguous_credentials" });
    // 拒否したリクエストは使用として記録しない
    expect(await lastUsedAt("laptop")).toBeNull();
  });

  it("Cookie だけなら匿名として扱う", async () => {
    const res = await buildApp().request("/api/healthz", { Cookie: "session=anything" });
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
