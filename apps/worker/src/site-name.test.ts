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

  it("deploy の検査を通らない名前は既定の名前にする", () => {
    expect(siteNameOf({ SITE_NAME: "a\u202eb" })).toBe("personal-wiki");
    expect(siteNameOf({ SITE_NAME: "a\u2028b" })).toBe("personal-wiki");
    expect(siteNameOf({ SITE_NAME: "😀".repeat(41) })).toBe("personal-wiki");
    expect(siteNameOf({ SITE_NAME: "😀".repeat(40) })).toBe("😀".repeat(40));
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

  it("MCP の識別子は固定で、表示名の title は SITE_NAME で変わり、無ければ既定の名前", async () => {
    const named = await initialize("rummelonp wiki");
    expect(named).toContain('"name":"personal-wiki"');
    expect(named).toContain('"title":"rummelonp wiki"');
    expect(named).not.toContain('"name":"rummelonp wiki"');
    const unnamed = await initialize(undefined);
    expect(unnamed).toContain('"name":"personal-wiki"');
    expect(unnamed).toContain('"title":"personal-wiki"');
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
