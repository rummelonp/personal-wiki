import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { ownerCookie, ownerEnv } from "./test/owner";
import { T0 } from "./test/pages";

const CORP = "Cross-Origin-Resource-Policy";

describe("Cross-Origin-Resource-Policy", () => {
  it("/api/* の JSON の応答に same-origin を付ける（匿名、owner、エラーを問わない）", async () => {
    const app = createApp({ now: () => T0 });
    const cookie = await ownerCookie(T0);
    for (const [path, init] of [
      ["/api/me", {}],
      ["/api/me", { headers: { Cookie: cookie } }],
      ["/api/pages", {}],
      ["/api/unknown", {}],
    ] as const) {
      const res = await app.request(path, init, ownerEnv());
      expect(res.headers.get("Content-Type"), path).toContain("application/json");
      expect(res.headers.get(CORP), path).toBe("same-origin");
    }
  });

  it("/api/* 以外には付けない", async () => {
    const assets = {
      fetch: async () =>
        new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }),
    } as unknown as Fetcher;
    const res = await createApp().request(
      "/",
      { headers: { Accept: "text/html" } },
      { ...env, ASSETS: assets },
    );
    expect(res.headers.get(CORP)).toBeNull();
  });
});
