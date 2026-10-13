import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { MAX_REQUEST_BYTES } from "../pages/routes";
import { buildClient, snapshotDb, T0 } from "../test/pages";

const ORIGIN = "http://localhost";

interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolOutcome {
  isError: boolean;
  json: Record<string, unknown>;
}

/** 応答は単発の JSON か、1 件のメッセージを運ぶ SSE のどちらでも来うる。 */
async function readRpc(res: Response): Promise<RpcResponse> {
  const text = await res.text();
  if (res.headers.get("Content-Type")?.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as RpcResponse);
    if (data.length !== 1) throw new Error(`SSE のメッセージが 1 件でない: ${text}`);
    return data[0] as RpcResponse;
  }
  return JSON.parse(text) as RpcResponse;
}

async function mcpClient(options: Parameters<typeof buildClient>[0] = {}) {
  const client = await buildClient(options);
  let nextId = 1;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    client.request("/mcp", {
      method: "POST",
      // Agents SDK の handler は localhost 宛てのリクエストで Host を検査する
      headers: { Accept: "application/json, text/event-stream", Host: "localhost", ...headers },
      json: body,
    });
  async function rpc(method: string, params?: unknown, headers?: Record<string, string>) {
    const id = nextId++;
    const res = await post(
      { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) },
      headers,
    );
    expect(res.status).toBe(200);
    const message = await readRpc(res);
    expect(message.id).toBe(id);
    return message;
  }
  async function call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const { result, error } = await rpc("tools/call", { name, arguments: args });
    if (error !== undefined || result === undefined) {
      throw new Error(`JSON-RPC のエラー: ${JSON.stringify(error)}`);
    }
    const content = result.content as { type: string; text: string }[];
    const text = content[0]?.text ?? "";
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text);
    } catch {
      // 入力の検証に落ちたときは SDK が平文のメッセージを返す
      json = { text };
    }
    return { isError: result.isError === true, json };
  }
  return { ...client, post, rpc, call };
}

async function setVisibility(id: string, visibility: "public" | "draft") {
  await env.DB.prepare("UPDATE pages SET visibility = ?2 WHERE id = ?1").bind(id, visibility).run();
}

describe("/mcp の認可", () => {
  it("token が無ければ 401", async () => {
    const app = createApp();
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Host: "localhost",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      },
      env,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("read の token は read_page を使えるが、create_page は isError で何も書かない", async () => {
    const writer = await mcpClient({ name: "writer" });
    const created = await writer.call("create_page", { title: "Read Me", body: "本文" });
    const reader = await mcpClient({ name: "reader", scopes: "read" });

    const read = await reader.call("read_page", { id: created.json.id });
    expect(read.isError).toBe(false);
    expect(read.json).toMatchObject({ title: "Read Me", body: "本文" });

    const before = await snapshotDb();
    const denied = await reader.call("create_page", { title: "x", body: "" });
    expect(denied).toEqual({
      isError: true,
      json: { error: "forbidden", message: "この token には write の scope が無い" },
    });
    for (const [name, args] of [
      ["update_page", { id: created.json.id, version: 1, title: "x", body: "" }],
      ["append_to_page", { id: created.json.id, text: "x" }],
    ] as const) {
      expect(await reader.call(name, args)).toMatchObject({
        isError: true,
        json: { error: "forbidden" },
      });
    }
    expect(await snapshotDb()).toEqual(before);
    expect(reader.metrics).toEqual([]);
  });

  it("応答は共有キャッシュに載せない", async () => {
    const { post } = await mcpClient();
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("Content-Length が上限を超えるリクエストは解析せずに 413", async () => {
    const { post } = await mcpClient();
    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "Content-Length": String(MAX_REQUEST_BYTES + 1) },
    );
    expect(res.status).toBe(413);
  });
});

describe("tools/list", () => {
  it("4 つの tool を、知らないキーを拒む入力の schema で返す", async () => {
    const { rpc } = await mcpClient({ scopes: "read" });
    const { result } = await rpc("tools/list");
    const tools = result?.tools as {
      name: string;
      description: string;
      inputSchema: {
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties: boolean;
      };
      annotations: { readOnlyHint?: boolean };
    }[];
    expect(tools.map((t) => t.name)).toEqual([
      "read_page",
      "create_page",
      "update_page",
      "append_to_page",
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys(tool.inputSchema.properties)).not.toContain("visibility");
    }
    expect(byName.read_page?.inputSchema.required ?? []).toEqual([]);
    expect(byName.create_page?.inputSchema.required).toEqual(["title", "body"]);
    expect(byName.update_page?.inputSchema.required).toEqual(["id", "version", "title", "body"]);
    expect(byName.append_to_page?.inputSchema.required).toEqual(["id", "text"]);
    expect(byName.read_page?.annotations.readOnlyHint).toBe(true);
    expect(byName.create_page?.annotations.readOnlyHint).toBe(false);
    expect(byName.create_page?.description).toContain("draft");
    expect(byName.update_page?.description).toContain("read_page");
  });

  it("2025 年版のプロトコルの initialize と、ヘッダー付きの tools/list に応える", async () => {
    const { rpc } = await mcpClient();
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "personal-wiki" },
      instructions: expect.stringContaining("draft"),
    });
    const listed = await rpc("tools/list", undefined, { "MCP-Protocol-Version": "2025-06-18" });
    expect(listed.result?.tools).toHaveLength(4);
  });
});

describe("ページの tool", () => {
  it("create_page は draft で作り、/p/<id> の URL だけを返す", async () => {
    const { call, metrics } = await mcpClient();
    const created = await call("create_page", { title: "  New  Page ", body: "本文" });
    expect(created.isError).toBe(false);
    const id = created.json.id as string;
    expect(created.json).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      title: "New  Page",
      visibility: "draft",
      version: 1,
      updatedAt: T0,
      url: `${ORIGIN}/p/${id}`,
      titleUrl: null,
    });
    expect(metrics).toEqual([
      { op: "create", actor: "token:agent", pageId: id, rowsWritten: expect.any(Number) },
    ]);
    const row = await env.DB.prepare("SELECT visibility FROM pages WHERE id = ?1")
      .bind(id)
      .first<{ visibility: string }>();
    expect(row?.visibility).toBe("draft");
  });

  it("read_page は id と title のどちらでも引け、本文と版と URL を返す", async () => {
    const { call, clock } = await mcpClient();
    clock.now = T0 + 5;
    const { json: created } = await call("create_page", { title: "Notes", body: "# 見出し\n本文" });
    const expected = {
      id: created.id,
      title: "Notes",
      body: "# 見出し\n本文",
      visibility: "draft",
      version: 1,
      createdAt: T0 + 5,
      updatedAt: T0 + 5,
      url: `${ORIGIN}/p/${created.id}`,
      titleUrl: null,
    };
    expect(await call("read_page", { id: created.id })).toEqual({ isError: false, json: expected });
    expect(await call("read_page", { title: "ｎｏｔｅｓ" })).toEqual({
      isError: false,
      json: expected,
    });
  });

  it("read_page の誤りは isError", async () => {
    const { call } = await mcpClient();
    const { json: created } = await call("create_page", { title: "A", body: "" });
    expect(await call("read_page", {})).toMatchObject({
      isError: true,
      json: { error: "invalid_arguments" },
    });
    expect(await call("read_page", { id: created.id, title: "A" })).toMatchObject({
      isError: true,
      json: { error: "invalid_arguments" },
    });
    expect(await call("read_page", { id: "short" })).toEqual({
      isError: true,
      json: { error: "not_found" },
    });
    expect(await call("read_page", { title: "missing" })).toEqual({
      isError: true,
      json: { error: "not_found" },
    });
  });

  it("public のページは title の URL も返す。予約語と重なる title は /p/<id> だけ", async () => {
    const { call } = await mcpClient();
    const { json: plain } = await call("create_page", { title: "Hello World/2", body: "" });
    const { json: reserved } = await call("create_page", { title: "API", body: "" });
    await setVisibility(plain.id as string, "public");
    await setVisibility(reserved.id as string, "public");
    expect((await call("read_page", { id: plain.id })).json).toMatchObject({
      visibility: "public",
      url: `${ORIGIN}/p/${plain.id}`,
      titleUrl: `${ORIGIN}/Hello%20World%2F2`,
    });
    expect((await call("read_page", { id: reserved.id })).json).toMatchObject({
      visibility: "public",
      url: `${ORIGIN}/p/${reserved.id}`,
      titleUrl: null,
    });
  });

  it("update_page は版が合えば置き換え、版が古ければ最新の本文と版を返して何も書かない", async () => {
    const { call, metrics } = await mcpClient();
    const { json: created } = await call("create_page", { title: "Doc", body: "v1" });
    const updated = await call("update_page", {
      id: created.id,
      version: 1,
      title: "Doc",
      body: "v2",
    });
    expect(updated).toMatchObject({ isError: false, json: { id: created.id, version: 2 } });
    expect(metrics.at(-1)).toEqual({
      op: "update",
      actor: "token:agent",
      pageId: created.id,
      rowsWritten: expect.any(Number),
    });

    const before = await snapshotDb();
    const conflict = await call("update_page", {
      id: created.id,
      version: 1,
      title: "Doc",
      body: "stale",
    });
    expect(conflict).toEqual({
      isError: true,
      json: {
        error: "version_conflict",
        message: "版が合わない。最新版を読み直してから保存し直す",
        currentVersion: 2,
        current: { title: "Doc", body: "v2", version: 2 },
      },
    });
    expect(await snapshotDb()).toEqual(before);
    expect(metrics).toHaveLength(2);
  });

  it("update_page と append_to_page は存在しないページに not_found を返す", async () => {
    const { call } = await mcpClient();
    const missing = "A".repeat(22);
    for (const [name, args] of [
      ["update_page", { id: missing, version: 1, title: "x", body: "" }],
      ["append_to_page", { id: missing, text: "x" }],
      ["append_to_page", { id: "not-an-id", text: "x" }],
    ] as const) {
      expect(await call(name, args)).toEqual({ isError: true, json: { error: "not_found" } });
    }
  });

  it("append_to_page は版を渡さずに末尾へ足す", async () => {
    const { call, metrics } = await mcpClient();
    const { json: created } = await call("create_page", { title: "Log", body: "- a" });
    const appended = await call("append_to_page", { id: created.id, text: "- b" });
    expect(appended).toMatchObject({ isError: false, json: { id: created.id, version: 2 } });
    expect((await call("read_page", { id: created.id })).json.body).toBe("- a\n- b");
    expect(metrics.at(-1)).toEqual({
      op: "append",
      actor: "token:agent",
      pageId: created.id,
      rowsWritten: expect.any(Number),
      attempts: 1,
    });
  });

  it("書き込みのエラーは REST と同じ本文で返す", async () => {
    const { call } = await mcpClient();
    await call("create_page", { title: "Dup", body: "" });
    expect(await call("create_page", { title: "dup", body: "" })).toEqual({
      isError: true,
      json: { error: "title_conflict", message: "同じ title のページがすでにある" },
    });
    expect(await call("create_page", { title: "   ", body: "" })).toMatchObject({
      isError: true,
      json: { error: "invalid_title" },
    });
  });

  it("visibility などの知らないキーは拒み、何も書かない", async () => {
    const { call } = await mcpClient();
    const { json: created } = await call("create_page", { title: "Vis", body: "" });
    const before = await snapshotDb();
    for (const [name, args] of [
      ["create_page", { title: "x", body: "", visibility: "public" }],
      ["update_page", { id: created.id, version: 1, title: "Vis", body: "", visibility: "public" }],
      ["append_to_page", { id: created.id, text: "x", visibility: "public" }],
    ] as const) {
      const outcome = await call(name, args);
      expect(outcome.isError).toBe(true);
      expect(JSON.stringify(outcome.json)).toContain("visibility");
    }
    expect(await call("append_to_page", { id: created.id, text: "" })).toMatchObject({
      isError: true,
    });
    expect(await snapshotDb()).toEqual(before);
  });
});
