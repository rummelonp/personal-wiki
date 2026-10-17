import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const INDEX_HTML = "<!doctype html><title>wiki</title>";
const FAVICON = "fake-icon";
const HTML_ACCEPT = "text/html,application/xhtml+xml,*/*;q=0.8";

// Static Assets と同じく、置いたファイルだけを返し、無いパスは 404 にする
function fakeAssets() {
  const requested: string[] = [];
  const assets = {
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      requested.push(url);
      const { pathname } = new URL(url);
      if (pathname === "/") {
        return new Response(INDEX_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"index"' },
        });
      }
      if (pathname === "/favicon.ico") {
        return new Response(FAVICON, { headers: { "Content-Type": "image/x-icon" } });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { assets, requested };
}

describe("SPA の配信", () => {
  it("HTML のナビゲーションには index.html を返し、ページの無いパスは 404 にする", async () => {
    const { assets, requested } = fakeAssets();
    const app = createApp();
    for (const [path, status] of [
      ["/", 200],
      ["/p/abc", 404],
      ["/%E3%83%9A%E3%83%BC%E3%82%B8?x=1", 404],
    ] as const) {
      const res = await app.request(
        path,
        { headers: { Accept: HTML_ACCEPT } },
        { ...env, ASSETS: assets },
      );
      expect(res.status, path).toBe(status);
      expect(await res.text()).toBe(INDEX_HTML);
      expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    }
    // ファイルが無いときの index.html は、307 を返す /index.html ではなく / で取る
    expect(requested.map((url) => new URL(url).pathname)).toEqual([
      "/",
      "/p/abc",
      "/",
      "/%E3%83%9A%E3%83%BC%E3%82%B8",
      "/",
    ]);
  });

  it("noindex を外すのはクエリの無いトップだけで、検索や絞り込みの画面には残す", async () => {
    const { assets } = fakeAssets();
    const app = createApp();
    for (const [path, robots] of [
      ["/", null],
      ["/?q=x", "noindex"],
      ["/?tag=x", "noindex"],
    ] as const) {
      const res = await app.request(
        path,
        { headers: { Accept: HTML_ACCEPT } },
        { ...env, ASSETS: assets },
      );
      expect(res.status, path).toBe(200);
      expect(res.headers.get("X-Robots-Tag"), path).toBe(robots);
      expect(res.headers.get("Cache-Control"), path).toBe("no-cache");
    }
  });

  it("ページの無いパスの index.html に CSP、no-cache、noindex と共通のヘッダーを付ける", async () => {
    const { assets } = fakeAssets();
    const res = await createApp().request(
      "/p/abc",
      { headers: { Accept: HTML_ACCEPT } },
      { ...env, ASSETS: assets },
    );
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    // ASSETS のレスポンスを複製して返すので、後段のミドルウェアがヘッダーを足せる
    expect(res.headers.get("Vary")).toContain("Cookie");
  });

  it("public に置いたファイルはそのまま返す", async () => {
    const { assets } = fakeAssets();
    for (const accept of [HTML_ACCEPT, "image/*"]) {
      const res = await createApp().request(
        "/favicon.ico",
        { headers: { Accept: accept } },
        { ...env, ASSETS: assets },
      );
      expect(res.status).toBe(200);
      expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(FAVICON);
      expect(res.headers.get("Content-Type")).toBe("image/x-icon");
      expect(res.headers.get("Content-Security-Policy")).toBeNull();
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });

  it("HTML を受け付けない読み込みで無いファイルは JSON の 404", async () => {
    const { assets } = fakeAssets();
    const app = createApp();
    for (const accept of [undefined, "application/json", "image/*"]) {
      const res = await app.request(
        "/missing.png",
        accept === undefined ? {} : { headers: { Accept: accept } },
        { ...env, ASSETS: assets },
      );
      expect(res.status, accept).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  it("Worker のパスの知らないパスは ASSETS を見ずに JSON の 404", async () => {
    const { assets, requested } = fakeAssets();
    const app = createApp();
    for (const path of [
      "/api/unknown",
      "/api",
      "/mcp/foo",
      "/_auth/unknown",
      "/_auth",
      "/.well-known/oauth-protected-resource",
      "/_auth/oauth",
      "/_auth/oauth/unknown",
      "/assets/missing.js",
    ]) {
      const res = await app.request(
        path,
        { headers: { Accept: HTML_ACCEPT } },
        { ...env, ASSETS: assets },
      );
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
      expect(res.headers.get("Content-Security-Policy")).toBeNull();
    }
    expect(requested).toHaveLength(0);
  });

  it("GET 以外は index.html を返さない", async () => {
    const { assets, requested } = fakeAssets();
    const res = await createApp().request(
      "/p/abc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: HTML_ACCEPT },
        body: "{}",
      },
      { ...env, ASSETS: assets },
    );
    expect(res.status).toBe(404);
    expect(requested).toHaveLength(0);
  });
});
