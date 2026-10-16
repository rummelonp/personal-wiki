import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { siteNameOf } from "./site-name";
import { ownerEnv } from "./test/owner";
import { insertApiToken } from "./test/tokens";

describe("siteNameOf", () => {
  it("SITE_NAME の前後の空白を除いて返し、無いか空なら既定の名前にする", () => {
    expect(siteNameOf({ SITE_NAME: " rummelonp wiki " })).toBe("rummelonp wiki");
    expect(siteNameOf({})).toBe("personal-wiki");
    expect(siteNameOf({ SITE_NAME: "  " })).toBe("personal-wiki");
  });
});

describe("サイト名の出どころ", () => {
  async function initialize(siteName: string | undefined) {
    const { token } = await insertApiToken({ name: "agent", scopes: "read" });
    const bindings = siteName === undefined ? env : { ...env, SITE_NAME: siteName };
    const res = await createApp().request(
      "/mcp",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
          },
        }),
      },
      bindings,
    );
    expect(res.status).toBe(200);
    return res.text();
  }

  it("MCP の server 名は SITE_NAME で変わり、無ければ既定の名前", async () => {
    expect(await initialize("rummelonp wiki")).toContain('"name":"rummelonp wiki"');
    expect(await initialize(undefined)).toContain('"name":"personal-wiki"');
  });

  it("OAuth の resource_name は SITE_NAME で変わる", async () => {
    const res = await createApp().request(
      "/.well-known/oauth-protected-resource/mcp",
      {},
      ownerEnv({ SITE_NAME: "rummelonp wiki" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resource_name: "rummelonp wiki" });
  });
});
