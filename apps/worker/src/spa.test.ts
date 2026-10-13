import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const INDEX_HTML = "<!doctype html><title>wiki</title>";

function fakeAssets() {
  const requested: string[] = [];
  const assets = {
    fetch: async (input: RequestInfo | URL) => {
      requested.push(String(input instanceof Request ? input.url : input));
      return new Response(INDEX_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"index"' },
      });
    },
  } as unknown as Fetcher;
  return { assets, requested };
}

describe("SPA の配信", () => {
  it("API 以外のナビゲーションには index.html を返す", async () => {
    const { assets, requested } = fakeAssets();
    const app = createApp();
    for (const path of ["/", "/p/abc", "/%E3%83%9A%E3%83%BC%E3%82%B8?x=1", "/index.html"]) {
      const res = await app.request(path, {}, { ...env, ASSETS: assets });
      expect(res.status, path).toBe(200);
      expect(await res.text()).toBe(INDEX_HTML);
      expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    }
    // /index.html を引くと 307 で / に飛ばされるので、常に / を引く
    expect(requested.every((url) => new URL(url).pathname === "/")).toBe(true);
  });

  it("返した応答のヘッダーを書き換えられる（ASSETS の応答をそのまま返さない）", async () => {
    const { assets } = fakeAssets();
    const res = await createApp().request("/p/abc", {}, { ...env, ASSETS: assets });
    expect(res.headers.get("Vary")).toContain("Cookie");
  });

  it("/api、/mcp、/_auth の知らないパスは JSON の 404 のまま", async () => {
    const { assets, requested } = fakeAssets();
    const app = createApp();
    for (const path of ["/api/unknown", "/api", "/mcp/foo", "/_auth/unknown", "/_auth"]) {
      const res = await app.request(path, {}, { ...env, ASSETS: assets });
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(requested).toHaveLength(0);
  });

  it("GET 以外は index.html を返さない", async () => {
    const { assets, requested } = fakeAssets();
    const res = await createApp().request(
      "/p/abc",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      { ...env, ASSETS: assets },
    );
    expect(res.status).toBe(404);
    expect(requested).toHaveLength(0);
  });
});
