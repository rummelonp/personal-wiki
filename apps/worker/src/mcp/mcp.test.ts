import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { MAX_BODY_BYTES, MAX_TITLE_BYTES } from "@personal-wiki/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { MAX_REQUEST_BYTES, type WriteMetric } from "../pages/operations";
import { buildClient, snapshotDb, T0 } from "../test/pages";
import { insertApiToken } from "../test/tokens";
import { createWikiMcpServer } from "./server";
import type { WikiToolContext } from "./tool";

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
      headers: { Accept: "application/json, text/event-stream", ...headers },
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
    const json = JSON.parse(content[0]?.text ?? "") as Record<string, unknown>;
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

  it("Cookie だけの要求は匿名として 401", async () => {
    await mcpClient();
    const res = await createApp().request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Cookie: "session=anything",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("Origin の付いた要求は token があっても 403 で、tool を実行しない", async () => {
    const { post, metrics } = await mcpClient();
    const before = await snapshotDb();
    for (const origin of ["https://evil.example", ORIGIN, "null"]) {
      const res = await post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "create_page", arguments: { title: "Via Browser", body: "" } },
        },
        { Origin: origin },
      );
      expect(res.status).toBe(403);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
    expect(await snapshotDb()).toEqual(before);
    expect(metrics).toEqual([]);
  });

  it("GET と DELETE は stateless なので 405", async () => {
    const { request } = await mcpClient();
    for (const method of ["GET", "DELETE"]) {
      const res = await request("/mcp", {
        method,
        headers: { Accept: "application/json, text/event-stream" },
      });
      expect(res.status).toBe(405);
    }
  });

  it("JSON-RPC の batch は 400 で、どの要求も実行しない", async () => {
    const { post, metrics } = await mcpClient();
    const before = await snapshotDb();
    const call = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "create_page", arguments: { title: `Batch ${id}`, body: "" } },
    });
    const res = await post([call(1), call(2)]);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    expect(await snapshotDb()).toEqual(before);
    expect(metrics).toEqual([]);
  });

  it("JSON として読めない本文は 400", async () => {
    const { request } = await mcpClient();
    const res = await request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: "{",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32700 } });
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
  it("7 つの tool を、知らないキーを拒む入力の schema で返す", async () => {
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
      "search",
      "list_recent",
      "list_backlinks",
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
    expect(byName.search?.inputSchema.required).toEqual(["query"]);
    expect(byName.search?.inputSchema.properties.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 50,
    });
    expect(byName.list_recent?.inputSchema.required ?? []).toEqual([]);
    expect(byName.list_recent?.inputSchema.properties.limit).toMatchObject({ maximum: 100 });
    expect(byName.list_backlinks?.inputSchema.required ?? []).toEqual([]);
    expect(Object.keys(byName.list_backlinks?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["id", "title"]),
    );
    expect(byName.list_backlinks?.description).toContain("まだ作られていないページ");
    for (const name of ["search", "list_recent", "list_backlinks", "read_page"]) {
      expect(byName[name]?.annotations.readOnlyHint).toBe(true);
    }
    expect(byName.create_page?.annotations.readOnlyHint).toBe(false);
    expect(byName.search?.description).toContain("2 文字以下は部分一致");
    expect(byName.create_page?.description).toContain("draft");
    expect(byName.update_page?.description).toContain("read_page で取った version が必須");
    expect(byName.update_page?.description).toContain("上書きで押し切らない");
    expect(byName.update_page?.description).toContain("`[[旧 title]]` はすぐには書き換わらない");
    expect(byName.append_to_page?.description).toContain("そのまま送り直してよい");
    for (const name of ["create_page", "update_page", "append_to_page"]) {
      expect(byName[name]?.description).toContain("秘密を書かない");
    }
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
    });
    const instructions = init.result?.instructions as string;
    for (const rule of [
      "search",
      "draft",
      "秘密",
      "オーナーがブラウザ",
      "frontmatter",
      "[[title]]",
      "[[旧 title]]",
    ]) {
      expect(instructions).toContain(rule);
    }
    const listed = await rpc("tools/list", undefined, { "MCP-Protocol-Version": "2025-06-18" });
    expect(listed.result?.tools).toHaveLength(7);
  });
});

describe("2026-07-28 版のプロトコル", () => {
  const MODERN = "2026-07-28";
  const envelope = {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  };
  const modernHeaders = (method: string, name?: string): Record<string, string> => ({
    "MCP-Protocol-Version": MODERN,
    "Mcp-Method": method,
    ...(name === undefined ? {} : { "Mcp-Name": name }),
  });

  it("server/discover に instructions を返す", async () => {
    const { rpc } = await mcpClient();
    const discovered = await rpc(
      "server/discover",
      { _meta: envelope },
      modernHeaders("server/discover"),
    );
    expect(discovered.result).toMatchObject({
      supportedVersions: [MODERN],
      instructions: expect.stringContaining("draft"),
    });
  });

  it("tools/call で tool を呼び、principal と D1 が tool に届く", async () => {
    const { rpc, metrics } = await mcpClient();
    const { result } = await rpc(
      "tools/call",
      { _meta: envelope, name: "create_page", arguments: { title: "Modern", body: "本文" } },
      modernHeaders("tools/call", "create_page"),
    );
    // resultType は 2026-07-28 版の経路だけが付ける
    expect(result).toMatchObject({ resultType: "complete" });
    expect(result?.isError).toBeUndefined();
    const content = result?.content as { text: string }[];
    expect(JSON.parse(content[0]?.text ?? "")).toMatchObject({
      title: "Modern",
      visibility: "draft",
    });
    expect(metrics).toHaveLength(1);
  });
});

describe("tool の中の例外", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("store が投げた例外の文面は返さず、internal_error にしてログに残す", async () => {
    const { call, metrics } = await mcpClient();
    await env.DB.prepare(
      "CREATE TRIGGER fail_insert BEFORE INSERT ON pages BEGIN SELECT RAISE(ABORT, 'secret detail'); END",
    ).run();
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });

    const result = await call("create_page", { title: "Boom", body: "" });

    expect(result).toEqual({ isError: true, json: { error: "internal_error" } });
    expect(metrics).toEqual([]);
    expect(logged).toHaveLength(1);
    const entry = JSON.parse(logged[0] as string);
    expect(entry).toMatchObject({ event: "mcp.tool_error", tool: "create_page" });
    expect(entry.error).toContain("secret detail");
  });
});

describe("ページの tool", () => {
  it("create_page は draft で作り、/p/<id> の URL だけを返す", async () => {
    const { call, metrics, actor } = await mcpClient();
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
    expect(metrics).toEqual([{ op: "create", actor, pageId: id, rowsWritten: expect.any(Number) }]);
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
      titleUrl: `${ORIGIN}/Hello_World%2F2`,
    });
    expect((await call("read_page", { id: reserved.id })).json).toMatchObject({
      visibility: "public",
      url: `${ORIGIN}/p/${reserved.id}`,
      titleUrl: null,
    });
  });

  it("update_page は版が合えば置き換え、版が古ければ最新の本文と版を返して何も書かない", async () => {
    const { call, metrics, actor } = await mcpClient();
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
      actor,
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
        message:
          "version が合わない。最新の title と body を読み直し、変更を載せ直してから保存し直す",
        currentVersion: 2,
        current: { title: "Doc", body: "v2", version: 2 },
      },
    });
    expect(await snapshotDb()).toEqual(before);
    expect(metrics).toHaveLength(2);
  });

  it("update_page で title を変えると、リンクの書き換えを積んだ件数を返す", async () => {
    const { call, request } = await mcpClient();
    const { json: target } = await call("create_page", { title: "Old", body: "" });
    const { json: source } = await call("create_page", { title: "S", body: "[[Old]]" });
    const renamed = await call("update_page", {
      id: target.id,
      version: 1,
      title: "New",
      body: "",
    });
    expect(renamed).toMatchObject({
      isError: false,
      json: { id: target.id, title: "New", version: 2, linkRewrites: { queued: 1 } },
    });
    const unchanged = await call("update_page", {
      id: target.id,
      version: 2,
      title: "New",
      body: "本文",
    });
    expect(unchanged.json).not.toHaveProperty("linkRewrites");

    const res = await request("/api/link-rewrites/step", { method: "POST", json: {} });
    expect(await res.json()).toMatchObject({ processed: { sourcePageId: source.id } });
    expect((await call("read_page", { id: source.id })).json.body).toBe("[[New]]");

    const unsafe = await call("update_page", {
      id: target.id,
      version: 3,
      title: "New|x",
      body: "本文",
    });
    expect(unsafe.json).toMatchObject({ linkRewrites: { queued: 0, skipped: "unsafe_title" } });
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
    const { call, metrics, actor } = await mcpClient();
    const { json: created } = await call("create_page", { title: "Log", body: "- a" });
    const appended = await call("append_to_page", { id: created.id, text: "- b" });
    expect(appended).toMatchObject({ isError: false, json: { id: created.id, version: 2 } });
    expect((await call("read_page", { id: created.id })).json.body).toBe("- a\n- b");
    expect(metrics.at(-1)).toEqual({
      op: "append",
      actor,
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

  it("title の制御文字と本文の NUL は、REST と同じ invalid_field で拒み、何も書かない", async () => {
    const { call } = await mcpClient();
    const { json: created } = await call("create_page", { title: "Ctl", body: "元" });
    const before = await snapshotDb();
    // 位置は REST の試験で細かく確かめるので、ここでは MCP にも同じ項目が載ることだけを見る
    const fieldError = (field: string) => ({
      isError: true,
      json: {
        error: "invalid_field",
        field,
        reason: "control_char",
        line: 1,
        column: expect.any(Number),
        codePoint: expect.stringMatching(/^U\+00/),
        message: expect.stringContaining(`${field} の `),
      },
    });
    expect(await call("create_page", { title: "a\u0001b", body: "" })).toEqual(fieldError("title"));
    expect(await call("create_page", { title: "x", body: "a\u0000" })).toEqual(fieldError("body"));
    expect(
      await call("update_page", { id: created.id, version: 1, title: "a\u0000", body: "元" }),
    ).toEqual(fieldError("title"));
    expect(
      await call("update_page", { id: created.id, version: 1, title: "Ctl", body: "\u0000" }),
    ).toEqual(fieldError("body"));
    expect(await call("append_to_page", { id: created.id, text: "\u0000" })).toEqual(
      fieldError("text"),
    );
    expect(await snapshotDb()).toEqual(before);
    const accepted = await call("append_to_page", { id: created.id, text: "a\tb" });
    expect(accepted.isError).toBe(false);
  });

  it("visibility などの知らないキーは REST と同じコードで拒み、何も書かない", async () => {
    const { call } = await mcpClient();
    const { json: created } = await call("create_page", { title: "Vis", body: "" });
    const before = await snapshotDb();
    for (const [name, args] of [
      ["create_page", { title: "x", body: "", visibility: "public" }],
      ["update_page", { id: created.id, version: 1, title: "Vis", body: "", visibility: "public" }],
      ["append_to_page", { id: created.id, text: "x", visibility: "public" }],
    ] as const) {
      expect(await call(name, args)).toEqual({
        isError: true,
        json: {
          error: "visibility_not_allowed",
          message:
            "visibility は API から変えられない。visibility を外して送り直す（ページは draft で作られ、公開はオーナーがブラウザで行う）",
        },
      });
    }
    expect(await call("create_page", { title: "x", body: "", content: "y" })).toEqual({
      isError: true,
      json: { error: "unknown_field", field: "content" },
    });
    expect(
      await call("create_page", { title: "x", body: "", content: "y", visibility: "public" }),
    ).toMatchObject({ isError: true, json: { error: "visibility_not_allowed" } });
    expect(await snapshotDb()).toEqual(before);
  });

  it("欠けた引数と型の違う引数は REST と同じ error と field で返し、何も書かない", async () => {
    const { call } = await mcpClient();
    const { json: created } = await call("create_page", { title: "Args", body: "" });
    const before = await snapshotDb();
    expect(await call("create_page", { title: "x" })).toEqual({
      isError: true,
      json: { error: "missing_field", field: "body" },
    });
    expect(await call("create_page", { title: 1, body: "" })).toEqual({
      isError: true,
      json: { error: "invalid_field", field: "title", message: "文字列で渡す" },
    });
    expect(
      await call("update_page", { id: created.id, version: 1.5, title: "Args", body: "" }),
    ).toEqual({
      isError: true,
      json: { error: "invalid_field", field: "version", message: "整数で渡す" },
    });
    expect(await call("append_to_page", { id: created.id, text: "" })).toEqual({
      isError: true,
      json: { error: "invalid_field", field: "text", message: "1 文字以上で渡す" },
    });
    expect(await call("append_to_page", { id: created.id, text: "x", extra: 1, bad: 2 })).toEqual({
      isError: true,
      json: { error: "unknown_field", field: "extra" },
    });
    expect(await snapshotDb()).toEqual(before);
  });

  it("引数の検証より先に scope を調べる", async () => {
    const { call } = await mcpClient({ scopes: "read" });
    expect(await call("create_page", { title: 1 })).toMatchObject({
      isError: true,
      json: { error: "forbidden" },
    });
  });

  it("title が上限を超えると title_too_long を、本文が上限を超えると body_too_large を返し、何も書かない", async () => {
    const { call } = await mcpClient();
    const { json: created } = await call("create_page", { title: "Limit", body: "" });
    const before = await snapshotDb();
    const longTitle = "あ".repeat(Math.floor(MAX_TITLE_BYTES / 3) + 1);
    // 3 バイトの文字で、文字数ではなくバイト数で数えることを確かめる
    const largeBody = "あ".repeat(Math.floor(MAX_BODY_BYTES / 3) + 1);
    const tooLong = {
      isError: true,
      json: {
        error: "title_too_long",
        field: "title",
        max: MAX_TITLE_BYTES,
        actual: longTitle.length * 3,
        unit: "utf8_bytes",
        message: expect.any(String),
      },
    };
    const tooLarge = {
      isError: true,
      json: {
        error: "body_too_large",
        field: "body",
        max: MAX_BODY_BYTES,
        actual: largeBody.length * 3,
        unit: "utf8_bytes",
        message: expect.any(String),
      },
    };
    expect(await call("create_page", { title: longTitle, body: "" })).toEqual(tooLong);
    expect(await call("create_page", { title: "Big", body: largeBody })).toEqual(tooLarge);
    expect(
      await call("update_page", { id: created.id, version: 1, title: longTitle, body: "" }),
    ).toEqual(tooLong);
    expect(
      await call("update_page", { id: created.id, version: 1, title: "Limit", body: largeBody }),
    ).toEqual(tooLarge);
    expect(await call("append_to_page", { id: created.id, text: largeBody })).toEqual({
      isError: true,
      json: { ...tooLarge.json, field: "text", currentBytes: 0 },
    });
    expect(await snapshotDb()).toEqual(before);
  });

  it("削除済みのページは、読むのも書くのも存在しないページと同じ not_found になる", async () => {
    const { call } = await mcpClient();
    const { json: created } = await call("create_page", { title: "Gone", body: "x" });
    await env.DB.prepare("UPDATE pages SET deleted_at = ?2, deleted_by = 'owner' WHERE id = ?1")
      .bind(created.id as string, T0)
      .run();
    const before = await snapshotDb();
    const notFound = { isError: true, json: { error: "not_found" } };
    expect(await call("read_page", { id: created.id })).toEqual(notFound);
    expect(await call("read_page", { title: "Gone" })).toEqual(notFound);
    expect(
      await call("update_page", { id: created.id, version: 1, title: "Gone", body: "y" }),
    ).toEqual(notFound);
    expect(await call("append_to_page", { id: created.id, text: "y" })).toEqual(notFound);
    expect(await call("list_backlinks", { id: created.id })).toEqual(notFound);
    expect(await snapshotDb()).toEqual(before);
  });

  it("update_page の version は REST の If-Match と同じ 15 桁までで、超えると拒む", async () => {
    const { call } = await mcpClient();
    const { json: created } = await call("create_page", { title: "Ver", body: "" });
    const before = await snapshotDb();
    const tooLarge = await call("update_page", {
      id: created.id,
      version: 1_000_000_000_000_000,
      title: "Ver",
      body: "x",
    });
    expect(tooLarge).toEqual({
      isError: true,
      json: { error: "invalid_field", field: "version", max: 999_999_999_999_999 },
    });
    // 2^53 を超える数でも、安全な整数の上限ではなく version の上限を返す
    expect(
      await call("update_page", { id: created.id, version: 1e16, title: "Ver", body: "x" }),
    ).toEqual(tooLarge);
    expect(await snapshotDb()).toEqual(before);
    const largest = await call("update_page", {
      id: created.id,
      version: 999_999_999_999_999,
      title: "Ver",
      body: "x",
    });
    expect(largest).toMatchObject({ isError: true, json: { error: "version_conflict" } });
  });
});

describe("検索と一覧の tool", () => {
  it("read の token で search を使え、抜粋と URL を返す", async () => {
    const writer = await mcpClient({ name: "writer" });
    const { json: a } = await writer.call("create_page", {
      title: "Alpha",
      body: "検索の対象の本文",
    });
    await writer.call("create_page", { title: "Beta", body: "無関係" });
    await setVisibility(a.id as string, "public");
    const reader = await mcpClient({ scopes: "read" });

    const long = await reader.call("search", { query: "対象の本文" });
    expect(long).toEqual({
      isError: false,
      json: {
        results: [
          {
            id: a.id,
            title: "Alpha",
            visibility: "public",
            updatedAt: T0,
            excerpt: "検索の対象の本文",
            tags: [],
            url: `${ORIGIN}/p/${a.id}`,
            titleUrl: `${ORIGIN}/Alpha`,
          },
        ],
      },
    });
    const short = await reader.call("search", { query: "ＢＥ" });
    expect((short.json.results as { title: string }[]).map((r) => r.title)).toEqual(["Beta"]);
  });

  it("search の検索語と limit は REST と同じ規則で検証する", async () => {
    const { call } = await mcpClient({ scopes: "read" });
    for (const query of ["  ", "a\tb", "x".repeat(201)]) {
      const result = await call("search", { query });
      expect(result).toMatchObject({
        isError: true,
        json: { error: "invalid_field", field: "query" },
      });
      expect(result.json.message).toEqual(expect.any(String));
    }
    expect(await call("search", { query: "abc", limit: 0 })).toEqual({
      isError: true,
      json: { error: "invalid_field", field: "limit", message: "1 以上で渡す" },
    });
    expect(await call("search", { query: "abc", limit: 51 })).toEqual({
      isError: true,
      json: { error: "invalid_field", field: "limit", max: 50 },
    });
    expect(await call("search", { query: "abc", limit: 1e300 })).toEqual({
      isError: true,
      json: { error: "invalid_field", field: "limit", max: 50 },
    });
    expect(await call("search", { query: "abc", limit: 1.5 })).toEqual({
      isError: true,
      json: { error: "invalid_field", field: "limit", message: "整数で渡す" },
    });
    expect((await call("search", { query: "abc", limit: 50 })).isError).toBe(false);
  });

  it("list_recent は更新の新しい順に返し、cursor で続きを取る", async () => {
    const { call, clock } = await mcpClient();
    const ids: string[] = [];
    for (const title of ["One", "Two", "Three"]) {
      clock.now += 1000;
      const body = title === "Three" ? "三つ目の本文 #memo #Work/Sub" : "";
      ids.push((await call("create_page", { title, body })).json.id as string);
    }
    const first = await call("list_recent", { limit: 2 });
    expect(first.isError).toBe(false);
    const firstPages = first.json.pages as { id: string; url: string; titleUrl: null }[];
    expect(firstPages.map((p) => p.id)).toEqual([ids[2], ids[1]]);
    expect(firstPages[0]).toMatchObject({ url: `${ORIGIN}/p/${ids[2]}`, titleUrl: null });
    // 本文の先頭の抜粋（行末のタグは除く）とタグ。本文が空のページは excerpt が無い
    expect(firstPages[0]).toMatchObject({
      excerpt: "三つ目の本文",
      tags: ["memo", "Work/Sub"],
    });
    expect(firstPages[1]).toEqual(expect.objectContaining({ tags: [] }));
    expect(firstPages[1]).not.toHaveProperty("excerpt");
    expect(first.json.nextCursor).toEqual(expect.any(String));

    const rest = await call("list_recent", { limit: 2, cursor: first.json.nextCursor });
    expect((rest.json.pages as { id: string }[]).map((p) => p.id)).toEqual([ids[0]]);
    expect(rest.json.nextCursor).toBeNull();

    expect(await call("list_recent", { cursor: "nope" })).toEqual({
      isError: true,
      json: { error: "invalid_field", field: "cursor" },
    });
    expect(await call("list_recent", { limit: 101 })).toEqual({
      isError: true,
      json: { error: "invalid_field", field: "limit", max: 100 },
    });
  });

  it("list_backlinks はリンク元を返し、無いページと形式の違う id は not_found", async () => {
    const { call } = await mcpClient({ name: "writer" });
    const { json: target } = await call("create_page", { title: "Target", body: "" });
    const { json: source } = await call("create_page", { title: "Source", body: "[[Target]]" });
    await call("create_page", { title: "Other", body: "" });

    const reader = await mcpClient({ name: "reader", scopes: "read" });
    const listed = await reader.call("list_backlinks", { id: target.id });
    expect(listed.isError).toBe(false);
    expect((listed.json.pages as { id: string }[]).map((p) => p.id)).toEqual([source.id]);
    expect(listed.json.nextCursor).toBeNull();

    for (const id of ["not-a-page-id", "A".repeat(22)]) {
      expect(await reader.call("list_backlinks", { id })).toEqual({
        isError: true,
        json: { error: "not_found" },
      });
    }
    expect(await reader.call("list_backlinks", { id: target.id, cursor: "x" })).toMatchObject({
      isError: true,
      json: { field: "cursor" },
    });
  });

  it("list_backlinks は title でも引け、まだ無いページのリンク元を返す", async () => {
    const { call, clock } = await mcpClient({ name: "writer" });
    const { json: target } = await call("create_page", { title: "Target", body: "" });
    clock.now += 1000;
    const { json: viaTarget } = await call("create_page", {
      title: "Via Target",
      body: "[[Target]]",
    });
    clock.now += 1000;
    const { json: viaMissing } = await call("create_page", {
      title: "Via Missing",
      body: "[[Ghost Page]]",
    });
    clock.now += 1000;
    const { json: viaBoth } = await call("create_page", {
      title: "Via Both",
      body: "[[ghost page]] と [[Target]]",
    });
    await call("create_page", { title: "Ghost Page Self", body: "[[Ghost Page Self]]" });

    const reader = await mcpClient({ name: "reader", scopes: "read" });
    const ids = (outcome: ToolOutcome) => (outcome.json.pages as { id: string }[]).map((p) => p.id);

    // 作られていないページの title でも、全角半角と大文字小文字を区別せずにリンク元が返る
    const missing = await reader.call("list_backlinks", { title: "ＧＨＯＳＴ Page" });
    expect(missing.isError).toBe(false);
    expect(ids(missing)).toEqual([viaBoth.id, viaMissing.id]);
    expect(missing.json.nextCursor).toBeNull();
    expect(await reader.call("list_backlinks", { title: "Nobody Links Here" })).toEqual({
      isError: false,
      json: { pages: [], nextCursor: null },
    });

    // 作られているページを title で引いた結果は、id で引いた結果と同じ
    const byTitle = await reader.call("list_backlinks", { title: "target" });
    expect(ids(byTitle)).toEqual([viaBoth.id, viaTarget.id]);
    expect(byTitle).toEqual(await reader.call("list_backlinks", { id: target.id }));

    const first = await reader.call("list_backlinks", { title: "Ghost Page", limit: 1 });
    expect(ids(first)).toEqual([viaBoth.id]);
    const rest = await reader.call("list_backlinks", {
      title: "Ghost Page",
      limit: 1,
      cursor: first.json.nextCursor,
    });
    expect(ids(rest)).toEqual([viaMissing.id]);
    expect(rest.json.nextCursor).toBeNull();

    // 自分自身へのリンクはリンク元に含めない
    expect(ids(await reader.call("list_backlinks", { title: "Ghost Page Self" }))).toEqual([]);
  });

  it("list_backlinks は id と title の指定の誤りを invalid_arguments か invalid_field で返す", async () => {
    const { call } = await mcpClient({ scopes: "read write" });
    const { json: target } = await call("create_page", { title: "Target", body: "" });

    for (const args of [{}, { id: target.id, title: "Target" }, { limit: 5 }]) {
      expect(await call("list_backlinks", args)).toMatchObject({
        isError: true,
        json: { error: "invalid_arguments", message: expect.any(String) },
      });
    }
    for (const title of ["", "  　 "]) {
      expect(await call("list_backlinks", { title })).toMatchObject({
        isError: true,
        json: { error: "invalid_field", field: "title" },
      });
    }
    expect(await call("list_backlinks", { title: "Target", cursor: "x" })).toMatchObject({
      isError: true,
      json: { error: "invalid_field", field: "cursor" },
    });
    expect(await call("list_backlinks", { title: 1 })).toEqual({
      isError: true,
      json: { error: "invalid_field", field: "title", message: "文字列で渡す" },
    });
  });

  it("list_backlinks の title 引きは、read の token で REST の by-title と同じリンク元を返す", async () => {
    const writer = await mcpClient({ name: "writer" });
    const { json: open } = await writer.call("create_page", { title: "Open", body: "[[Ghost]]" });
    const { json: hidden } = await writer.call("create_page", {
      title: "Hidden",
      body: "[[Ghost]]",
    });
    await setVisibility(open.id as string, "public");

    // read の token は draft も読める（id で引く list_backlinks と同じ）。REST の by-title も同じ集合を返す
    const reader = await mcpClient({ name: "reader", scopes: "read" });
    const viaMcp = await reader.call("list_backlinks", { title: "Ghost" });
    const viaRest = await reader.request("/api/pages/by-title/backlinks?title=Ghost");
    const restIds = ((await viaRest.json()) as { pages: { id: string }[] }).pages.map((p) => p.id);
    const mcpIds = (viaMcp.json.pages as { id: string }[]).map((p) => p.id);
    expect(mcpIds).toEqual(restIds);
    expect([...mcpIds].sort()).toEqual([open.id, hidden.id].sort());
  });

  it("title で引く tool は `_` と空白を同じ文字として扱い、重複も同じ規則で検査する", async () => {
    const { call } = await mcpClient({ name: "writer" });
    const { json: target } = await call("create_page", { title: "a b", body: "" });
    const { json: source } = await call("create_page", { title: "source", body: "[[a_b]]" });

    expect(await call("read_page", { title: "A_B" })).toMatchObject({
      isError: false,
      json: { id: target.id, title: "a b" },
    });
    for (const title of ["a_b", "a b"]) {
      const listed = await call("list_backlinks", { title });
      expect(
        (listed.json.pages as { id: string }[]).map((p) => p.id),
        title,
      ).toEqual([source.id]);
    }
    expect(await call("create_page", { title: "a_b", body: "" })).toMatchObject({
      isError: true,
      json: { error: "title_conflict" },
    });
  });
});

describe("リクエストをまたいだ状態", () => {
  // 1 つの app（= 1 つの handler）に別の principal の要求を交互に流し、値が混ざらないことを確かめる
  async function sharedApp() {
    const metrics: WriteMetric[] = [];
    const app = createApp({ now: () => T0, recordWrite: (m) => metrics.push(m) });
    const tokens = {
      alice: await insertApiToken({ name: "alice", scopes: "read write" }),
      bob: await insertApiToken({ name: "bob", scopes: "read" }),
    };
    let nextId = 1;
    async function rpc(who: keyof typeof tokens, method: string, params?: unknown) {
      const id = nextId++;
      const res = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokens[who].token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
        },
        env,
      );
      expect(res.status).toBe(200);
      return readRpc(res);
    }
    const create = async (who: keyof typeof tokens, title: string) => {
      const { result } = await rpc(who, "tools/call", {
        name: "create_page",
        arguments: { title, body: "" },
      });
      return result as { isError?: boolean; content: { text: string }[] };
    };
    return { rpc, create, metrics, tokens };
  }

  it("write と read の principal を交互に流しても、scope と actor が混ざらない", async () => {
    const { create, metrics, tokens } = await sharedApp();
    for (let i = 0; i < 4; i++) {
      const a = await create("alice", `A${i}`);
      expect(a.isError).toBeUndefined();
      const b = await create("bob", `B${i}`);
      expect(b.isError).toBe(true);
      expect(JSON.parse(b.content[0]?.text ?? "")).toMatchObject({ error: "forbidden" });
    }
    expect(metrics).toHaveLength(4);
    expect(metrics.every((m) => m.actor === tokens.alice.actor)).toBe(true);
  });

  it("同時に流した要求でも、principal ごとの結果が入れ替わらない", async () => {
    const { create, metrics, tokens } = await sharedApp();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => create(i % 2 === 0 ? "alice" : "bob", `P${i}`)),
    );
    results.forEach((r, i) => {
      expect(r.isError === true).toBe(i % 2 === 1);
    });
    expect(metrics).toHaveLength(3);
    expect(metrics.every((m) => m.actor === tokens.alice.actor)).toBe(true);
  });

  it("tools/call のあとの tools/list は 7 つの tool を返し、知らない tool は JSON-RPC のエラー", async () => {
    const { rpc, create } = await sharedApp();
    await create("alice", "First");
    const listed = await rpc("bob", "tools/list");
    expect((listed.result?.tools as unknown[] | undefined)?.length).toBe(7);

    const unknown = await rpc("alice", "tools/call", { name: "no_such_tool", arguments: {} });
    expect(unknown.error).toEqual({ code: -32602, message: "Tool no_such_tool not found" });
    // 知らない tool の呼び出しのあとも、通常の tool が使える
    expect((await create("alice", "Second")).isError).toBeUndefined();
  });

  it("name が文字列でない tools/call と params の無い tools/call は、従来どおりの JSON-RPC エラーになる", async () => {
    const { rpc } = await sharedApp();
    const noName = (await rpc("alice", "tools/call", { name: 1, arguments: {} })).error;
    const noParams = (await rpc("alice", "tools/call")).error;
    expect(noName).toEqual({
      code: -32602,
      message: expect.stringContaining("Invalid tools/call request"),
    });
    expect(noParams).toEqual({
      code: -32602,
      message: expect.stringContaining("Invalid tools/call request"),
    });
  });

  it("createWikiMcpServer は、呼ばれる tool が TOOLS にあればその 1 件だけを登録し、無ければ全件を登録する", () => {
    const registerTool = vi.spyOn(McpServer.prototype, "registerTool");
    // 登録だけを見るので、tool の実行時に使う ctx は渡さない
    const ctx = {} as WikiToolContext;
    const registeredNames = () => registerTool.mock.calls.map(([name]) => name);
    try {
      createWikiMcpServer(ctx, "read_page");
      expect(registeredNames()).toEqual(["read_page"]);

      registerTool.mockClear();
      createWikiMcpServer(ctx, "no_such");
      expect(registeredNames()).toHaveLength(7);

      registerTool.mockClear();
      createWikiMcpServer(ctx);
      expect(registeredNames()).toHaveLength(7);
    } finally {
      registerTool.mockRestore();
    }
  });
});
