import { env } from "cloudflare:workers";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import type { Principal } from "../auth/principal";
import { defineTool, toolResult } from "./tool";

// /mcp は token 以外を tool まで通さないので、登録した callback を直接呼んで確かめる
async function callAs(principal: Principal): Promise<CallToolResult> {
  let ran = false;
  const tool = defineTool({
    name: "probe",
    scope: "write",
    title: "probe",
    description: "probe",
    inputSchema: z.strictObject({}),
    annotations: {},
    run: async () => {
      ran = true;
      return toolResult({ ok: true });
    },
  });
  let callback: ((args: unknown) => Promise<CallToolResult>) | undefined;
  const server = {
    registerTool: (_name: string, _config: unknown, cb: typeof callback) => {
      callback = cb;
    },
  } as unknown as McpServer;
  tool.register(server, {
    db: env.DB,
    principal,
    now: () => 0,
    recordWrite: () => {},
    origin: "http://localhost",
  });
  const result = await (callback as NonNullable<typeof callback>)({});
  if (result.isError) expect(ran).toBe(false);
  return result;
}

const errorJson = (result: CallToolResult) =>
  JSON.parse((result.content[0] as { text: string }).text);

describe("tool の呼び出しの認可", () => {
  it("token 以外は scope の話をせずに拒む", async () => {
    for (const principal of [{ kind: "owner" }, { kind: "anonymous" }] as const) {
      const result = await callAs(principal);
      expect(result.isError).toBe(true);
      expect(errorJson(result)).toEqual({
        error: "forbidden",
        message: "MCP の tool は token でだけ呼べる",
      });
    }
  });

  it("scope の足りない token は scope の名前を添えて拒み、足りていれば動かす", async () => {
    const reader = await callAs({
      kind: "token",
      issuer: "api",
      id: 1,
      name: "r",
      scopes: ["read"],
    });
    expect(errorJson(reader)).toEqual({
      error: "forbidden",
      message: "この token には write の scope が無い",
    });
    const writer = await callAs({
      kind: "token",
      issuer: "api",
      id: 2,
      name: "w",
      scopes: ["read", "write"],
    });
    expect(writer.isError).toBeUndefined();
  });
});
