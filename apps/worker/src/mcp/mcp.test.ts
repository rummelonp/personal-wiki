import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { MAX_BODY_BYTES, MAX_TITLE_BYTES } from "@personal-wiki/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { MAX_REQUEST_BYTES, type WriteMetric } from "../pages/operations";
import { parseActor } from "../pages/revision-history";
import { UNRESOLVED_SOURCES_PER_TITLE } from "../pages/search";
import { setVisibility as switchVisibility } from "../pages/store";
import { buildClient, linksFrom, snapshotDb, T0, tagsOf } from "../test/pages";
import { insertApiToken } from "../test/tokens";
import { createWikiMcpServer } from "./server";
import type { WikiToolContext } from "./tool";

const ORIGIN = "http://localhost";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** tools/list が返す順。tool の増減と入れ替えに気づけるよう、名前で比べる */
const TOOL_NAMES = [
  "search",
  "list_recent",
  "list_backlinks",
  "list_unresolved_links",
  "read_page",
  "list_revisions",
  "create_page",
  "update_page",
  "edit_page",
  "rewrite_links",
  "append_to_page",
];

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

/** レスポンスは単発の JSON か、1 件のメッセージを運ぶ SSE のどちらでも来うる。 */
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
      ["edit_page", { id: created.json.id, version: 1, edits: [{ old: "本文", new: "x" }] }],
      ["rewrite_links", {}],
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

  // 同意画面の読み書きの説明（auth/oauth-routes.ts）はこの 5 つでできることだけを書いているので、範囲が変わったら説明も直す
  it("write の scope を要る tool は create_page、update_page、edit_page、rewrite_links、append_to_page だけ", async () => {
    const reader = await mcpClient({ name: "reader", scopes: "read" });
    const { result } = await reader.rpc("tools/list");
    const tools = (result?.tools ?? []) as { name: string }[];
    const names = tools.map((tool) => tool.name);
    expect(names.toSorted()).toEqual(TOOL_NAMES.toSorted());
    const before = await snapshotDb();
    const writeOnly: string[] = [];
    // scope は引数の検証より先に調べるので、空の引数で呼べば read の token では何も書かずに判定できる
    for (const name of names) {
      const outcome = await reader.call(name, {});
      if (outcome.isError && outcome.json.error === "forbidden") writeOnly.push(name);
    }
    expect(writeOnly.toSorted()).toEqual([
      "append_to_page",
      "create_page",
      "edit_page",
      "rewrite_links",
      "update_page",
    ]);
    expect(await snapshotDb()).toEqual(before);
  });

  it("レスポンスは共有キャッシュに載せない", async () => {
    const { post } = await mcpClient();
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("Cookie だけのリクエストは匿名として 401", async () => {
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

  it("Origin の付いたリクエストは token があっても 403 で、tool を実行しない", async () => {
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

  it("JSON-RPC の batch は 400 で、どのリクエストも実行しない", async () => {
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
  it("11 個の tool を、知らないキーを拒む入力の schema で返す", async () => {
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
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys(tool.inputSchema.properties)).not.toContain("visibility");
    }
    expect(byName.read_page?.inputSchema.required ?? []).toEqual([]);
    expect(byName.create_page?.inputSchema.required).toEqual(["title", "body"]);
    expect(byName.update_page?.inputSchema.required).toEqual(["id", "version", "title", "body"]);
    expect(byName.edit_page?.inputSchema.required).toEqual(["id", "version", "edits"]);
    expect(byName.edit_page?.inputSchema.properties.edits).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: { required: ["old", "new"], additionalProperties: false },
    });
    expect(byName.append_to_page?.inputSchema.required).toEqual(["id", "text"]);
    expect(byName.search?.inputSchema.required).toEqual(["query"]);
    expect(byName.search?.inputSchema.properties.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 50,
    });
    expect(byName.list_recent?.inputSchema.required ?? []).toEqual([]);
    expect(byName.list_recent?.inputSchema.properties.limit).toMatchObject({ maximum: 100 });
    expect(byName.list_recent?.inputSchema.properties.tag).toMatchObject({ type: "string" });
    expect(byName.list_recent?.description).toContain("子のタグ");
    expect(byName.list_recent?.description).toContain("createdAt");
    expect(byName.list_backlinks?.inputSchema.required ?? []).toEqual([]);
    expect(Object.keys(byName.list_backlinks?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["id", "title"]),
    );
    expect(byName.list_backlinks?.description).toContain("まだ作られていないページ");
    expect(byName.list_unresolved_links?.inputSchema.required ?? []).toEqual([]);
    expect(Object.keys(byName.list_unresolved_links?.inputSchema.properties ?? {})).toEqual([
      "id",
      "title",
      "limit",
      "cursor",
    ]);
    expect(byName.list_unresolved_links?.inputSchema.properties.limit).toMatchObject({
      maximum: 100,
    });
    for (const rule of [
      "行き先のページがまだ無い",
      "titleKey",
      "list_backlinks",
      "rewrite_links",
      "形の検査はせず",
    ]) {
      expect(byName.list_unresolved_links?.description).toContain(rule);
    }
    expect(byName.list_revisions?.inputSchema.required ?? []).toEqual([]);
    expect(byName.list_revisions?.inputSchema.properties.limit).toMatchObject({ maximum: 100 });
    expect(byName.list_revisions?.description).toContain("版の番号は連続しない");
    expect(byName.read_page?.description).toContain(
      "update_page と edit_page には上の階層の version を渡す",
    );
    for (const name of [
      "search",
      "list_recent",
      "list_backlinks",
      "list_unresolved_links",
      "read_page",
      "list_revisions",
    ]) {
      expect(byName[name]?.annotations.readOnlyHint).toBe(true);
    }
    expect(byName.create_page?.annotations.readOnlyHint).toBe(false);
    expect(byName.search?.description).toContain("2 文字以下は部分一致");
    expect(byName.create_page?.description).toContain("draft");
    for (const rule of ["主題を表す名詞句", "接頭辞を付けない", "`[ ] | # ^`", "`\\` で終わる"]) {
      expect(byName.create_page?.description).toContain(rule);
    }
    expect(byName.update_page?.description).toContain("read_page で取った version が必須");
    expect(byName.update_page?.description).toContain("上書きで押し切らない");
    expect(byName.update_page?.description).toContain(
      "`[[旧 title]]` はこの呼び出しでは書き換わらず",
    );
    expect(byName.update_page?.description).toContain("rewrite_links");
    expect(byName.rewrite_links?.inputSchema.required ?? []).toEqual([]);
    expect(Object.keys(byName.rewrite_links?.inputSchema.properties ?? {})).toEqual([
      "targetPageId",
    ]);
    for (const rule of [
      "remaining が 0 になるまで",
      "ほかのページの改題で待っているリンクも一緒に書き換える",
      "conflict が true なら",
      "本文は変わらず",
      "failed は",
    ]) {
      expect(byName.rewrite_links?.description).toContain(rule);
    }
    expect(byName.update_page?.description).toContain("edit_page");
    for (const rule of ["version が必須", "適用する前の本文", "何も保存せずに edit_failed"]) {
      expect(byName.edit_page?.description).toContain(rule);
    }
    expect(byName.append_to_page?.description).toContain("そのまま送り直してよい");
    for (const name of ["create_page", "update_page", "edit_page", "append_to_page"]) {
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
      serverInfo: { name: "personal-wiki", title: "personal-wiki" },
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
      "記法は Obsidian と同じ",
      "Mermaid",
      "`<br>`",
      "コメント（`<!-- -->`）",
      "これらは使わない",
      "`[x](Page.md)`",
      "wiki のページには飛ばず",
      "バックリンクにもならない",
      "`[x](https://...)`",
      "`![[page#^id]]`",
      "`tags: a, b`",
      "`aliases`",
      "`%%コメント%%`",
      "MCP からは添付を足せない",
      "主題を表す名詞句",
      "接頭辞を付けない",
      "`[ ] | # ^`",
      "`\\` で終わる",
    ]) {
      expect(instructions).toContain(rule);
    }
    // title の規則は全ページに及ぶので、記法の差の箇条の配下に入れない。
    expect(instructions.indexOf("主題を表す名詞句")).toBeLessThan(
      instructions.indexOf("記法は Obsidian と同じ"),
    );
    // aliases は編集画面で見えても、リンクと検索の対象ではない。
    expect(instructions).toContain("リンクと検索に効くのは `tags` だけ");
    const listed = await rpc("tools/list", undefined, { "MCP-Protocol-Version": "2025-06-18" });
    const listedTools = (listed.result?.tools ?? []) as { name: string }[];
    expect(listedTools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
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
      bodySha256: expect.stringMatching(SHA256_HEX),
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
      bodySha256: expect.stringMatching(SHA256_HEX),
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

  it("read_page のエラーは isError", async () => {
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

  it("update_page で title を変えると、リンクの書き換えをキューに入れた件数を返す", async () => {
    const { call } = await mcpClient();
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

    const stepped = await call("rewrite_links", {});
    expect(stepped).toMatchObject({ json: { processed: { id: source.id } } });
    expect((await call("read_page", { id: source.id })).json.body).toBe("[[New]]");

    const unsafe = await call("update_page", {
      id: target.id,
      version: 3,
      title: "New|x",
      body: "本文",
    });
    expect(unsafe.json).toMatchObject({ linkRewrites: { queued: 0, skipped: "unsafe_title" } });
  });

  it("rewrite_links は remaining が 0 になるまで 1 ページずつ書き換え、新しい title の list_backlinks に出す", async () => {
    const { call, metrics, actor } = await mcpClient();
    const { json: a } = await call("create_page", { title: "Alpha", body: "" });
    const { json: b } = await call("create_page", { title: "Beta", body: "" });
    const { json: s1 } = await call("create_page", { title: "S1", body: "[[Alpha]] [[Beta]]" });
    const { json: s2 } = await call("create_page", { title: "S2", body: "x [[alpha]]" });
    await call("update_page", { id: a.id, version: 1, title: "Alpha 2", body: "" });
    await call("update_page", { id: b.id, version: 1, title: "Beta 2", body: "" });
    expect((await call("list_backlinks", { id: a.id })).json).toMatchObject({ pages: [] });

    // キューの順は作成の時刻と id で決まり、同じ時刻なら id の順なので、どちらが先かはテストで決めない
    const first = await call("rewrite_links", {});
    const second = await call("rewrite_links", {});
    const processed = [first, second].map((outcome) => outcome.json.processed as { id: string });
    expect(processed.map((page) => page.id).toSorted()).toEqual([s1.id, s2.id].toSorted());
    expect(first).toMatchObject({
      isError: false,
      json: { conflict: false, failed: [], remaining: 1 },
    });
    expect(second.json).toMatchObject({ conflict: false, failed: [], remaining: 0 });
    expect(processed.find((page) => page.id === s1.id)).toEqual({
      id: s1.id,
      title: "S1",
      visibility: "draft",
      version: 2,
      rewritten: 2,
    });
    expect(await call("rewrite_links", {})).toEqual({
      isError: false,
      json: { processed: null, conflict: false, failed: [], remaining: 0 },
    });

    expect((await call("read_page", { id: s1.id })).json.body).toBe("[[Alpha 2]] [[Beta 2]]");
    expect((await call("read_page", { id: s2.id })).json.body).toBe("x [[Alpha 2]]");
    const backlinks = await call("list_backlinks", { id: a.id });
    expect((backlinks.json.pages as { id: string }[]).map((page) => page.id).toSorted()).toEqual(
      [s1.id, s2.id].toSorted(),
    );
    const written = metrics.filter((metric) => metric.op === "link_rewrite");
    expect(written.map((metric) => metric.pageId).toSorted()).toEqual([s1.id, s2.id].toSorted());
    expect(written.every((metric) => metric.actor === actor)).toBe(true);
    const revisions = await call("list_revisions", { id: s1.id });
    expect(revisions.json.revisions).toMatchObject([{ version: 2, author: { kind: "token" } }, {}]);
  });

  it("rewrite_links は targetPageId の改題で待っている分だけを進める", async () => {
    const { call } = await mcpClient();
    const { json: a } = await call("create_page", { title: "Alpha", body: "" });
    const { json: b } = await call("create_page", { title: "Beta", body: "" });
    const { json: sa } = await call("create_page", { title: "SA", body: "[[Alpha]]" });
    const { json: sb } = await call("create_page", { title: "SB", body: "[[Beta]]" });
    await call("update_page", { id: a.id, version: 1, title: "Alpha 2", body: "" });
    await call("update_page", { id: b.id, version: 1, title: "Beta 2", body: "" });

    const forB = await call("rewrite_links", { targetPageId: b.id });
    expect(forB.json).toMatchObject({ processed: { id: sb.id }, remaining: 0 });
    expect((await call("read_page", { id: sa.id })).json.body).toBe("[[Alpha]]");
    expect(await call("rewrite_links", { targetPageId: b.id })).toMatchObject({
      json: { processed: null },
    });
    expect((await call("rewrite_links", {})).json).toMatchObject({ processed: { id: sa.id } });
  });

  it("rewrite_links は書き換えられないリンク元を failed に title つきで返し、本文を変えない", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { call } = await mcpClient();
    const { json: target } = await call("create_page", { title: "Old", body: "" });
    const { json: s } = await call("create_page", { title: "S", body: "a ` b [[Old]] c" });
    await call("update_page", { id: target.id, version: 1, title: "Ne`w", body: "" });

    expect(await call("rewrite_links", {})).toEqual({
      isError: false,
      json: {
        processed: null,
        conflict: false,
        failed: [{ id: s.id, title: "S" }],
        remaining: 0,
      },
    });
    expect((await call("read_page", { id: s.id })).json).toMatchObject({
      body: "a ` b [[Old]] c",
      version: 1,
    });
  });

  it("rewrite_links は形式の違う targetPageId を invalid_field、知らないキーを unknown_field で返す", async () => {
    const { call } = await mcpClient();
    const before = await snapshotDb();
    expect(await call("rewrite_links", { targetPageId: "not-an-id" })).toEqual({
      isError: true,
      json: { error: "invalid_field", field: "targetPageId" },
    });
    expect(await call("rewrite_links", { id: "x" })).toMatchObject({
      isError: true,
      json: { error: "unknown_field" },
    });
    expect(await snapshotDb()).toEqual(before);
  });

  it("update_page と edit_page と append_to_page は存在しないページに not_found を返す", async () => {
    const { call } = await mcpClient();
    const missing = "A".repeat(22);
    for (const [name, args] of [
      ["update_page", { id: missing, version: 1, title: "x", body: "" }],
      ["edit_page", { id: missing, version: 1, edits: [{ old: "a", new: "b" }] }],
      ["edit_page", { id: "not-an-id", version: 1, edits: [{ old: "a", new: "b" }] }],
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
    const { json: dup } = await call("create_page", { title: "Dup", body: "" });
    expect(await call("create_page", { title: "dup", body: "" })).toEqual({
      isError: true,
      json: {
        error: "title_conflict",
        existing: { id: dup.id, title: "Dup", visibility: "draft" },
        message:
          "同じ title とみなすページがすでにある（大文字小文字、全角半角、_ と空白の違いは区別しない）。そのページに追記するか、title を変える",
      },
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
    expect(
      await call("edit_page", { id: created.id, version: 1, edits: [{ old: "x", new: "y" }] }),
    ).toEqual(notFound);
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
      json: {
        error: "invalid_field",
        field: "version",
        max: 999_999_999_999_999,
        message: "999999999999999 以下で渡す",
      },
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

describe("bodySha256", () => {
  // description の手順（保存された本文を UTF-8 にした SHA-256 の小文字の 16 進）で別に求めた値
  const VECTORS = [
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["日本語\r\n- 項目\n", "d4aef048f38a59c85c43030736b104ebc3af33364e7b997b1dfa1da62c728967"],
    [
      "---\ntags: [a]\n---\n本文",
      "c2daae8dcb4de019cfb6a664df1870b37c6994270fa2278c34fe581580bc10f1",
    ],
  ] as const;

  it("read_page と書き込みの応答は、保存された本文を UTF-8 にした SHA-256 を返す", async () => {
    const { call } = await mcpClient();
    for (const [i, [body, hash]] of VECTORS.entries()) {
      const created = await call("create_page", { title: `Hash ${i}`, body });
      expect(created.json.bodySha256).toBe(hash);
      const read = await call("read_page", { id: created.json.id });
      // 改行と末尾は保存で変わらないので、読んだ本文のハッシュと一致する
      expect(read.json).toMatchObject({ body, bodySha256: hash });
    }
  });

  it("update_page、edit_page、append_to_page の応答は書いた後の本文のハッシュで、read_page と一致する", async () => {
    const { call } = await mcpClient();
    const { json: created } = await call("create_page", { title: "Doc", body: "- a" });
    const id = created.id as string;
    const hashes = [created.bodySha256 as string];
    const hashOf = async () => (await call("read_page", { id })).json.bodySha256;

    const appended = await call("append_to_page", { id, text: "- b" });
    // 改行を挟んで "- a\n- b" になる。追記後の本文はクライアントが持たないので、応答のハッシュで確かめる
    expect(appended.json.bodySha256).toBe(
      "4e11985d599fbbf978c25d40a56777b17b1f399b68a59ed9c1971fa2e35cc281",
    );
    expect(await hashOf()).toBe(appended.json.bodySha256);
    hashes.push(appended.json.bodySha256 as string);

    const edited = await call("edit_page", {
      id,
      version: appended.json.version,
      edits: [{ old: "- b", new: "- c" }],
    });
    expect(edited.json).toMatchObject({
      changed: true,
      bodySha256: "b8187a727bf3d3dcb784a4a4400b41aca7058a7f40e785b35612fb5d9505f3a5",
    });
    expect(await hashOf()).toBe(edited.json.bodySha256);
    hashes.push(edited.json.bodySha256 as string);

    const updated = await call("update_page", {
      id,
      version: edited.json.version,
      title: "Doc",
      body: "abc",
    });
    expect(updated.json.bodySha256).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await hashOf()).toBe(updated.json.bodySha256);
    hashes.push(updated.json.bodySha256 as string);

    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("本文が変わらない edit_page は、同じハッシュと今の版を返す", async () => {
    const { call } = await mcpClient();
    const { json: created } = await call("create_page", { title: "Doc", body: "same" });
    const edited = await call("edit_page", {
      id: created.id,
      version: 1,
      edits: [{ old: "same", new: "same" }],
    });
    expect(edited.json).toMatchObject({
      changed: false,
      version: 1,
      bodySha256: created.bodySha256,
    });
  });

  it("title だけを変える update_page は、本文のハッシュを変えない", async () => {
    const { call } = await mcpClient();
    const { json: created } = await call("create_page", { title: "Old", body: "abc" });
    const updated = await call("update_page", {
      id: created.id,
      version: 1,
      title: "New",
      body: "abc",
    });
    expect(updated.json).toMatchObject({ version: 2, bodySha256: created.bodySha256 });
  });

  it("revision を指定した read_page は、revision.body のハッシュを revision に入れ、上の階層には入れない", async () => {
    const { call } = await mcpClient();
    const { json: created } = await call("create_page", { title: "Doc", body: "abc" });
    await call("update_page", { id: created.id, version: 1, title: "Doc", body: "" });
    const res = await call("read_page", { id: created.id, revision: 1 });
    expect(res.json).not.toHaveProperty("bodySha256");
    expect(res.json.revision).toMatchObject({
      body: "abc",
      bodySha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
  });
});

describe("edit_page", () => {
  async function created(body: string, title = "Doc") {
    const client = await mcpClient();
    const { json } = await client.call("create_page", { title, body });
    return { ...client, id: json.id as string };
  }

  it("一意に一致する文字列を置き換え、title と visibility を変えずに版を 1 つ積む", async () => {
    const { call, metrics, actor, id } = await created("# 見出し\n\n- 古い項目\n- 残す項目\n");
    const edited = await call("edit_page", {
      id,
      version: 1,
      edits: [{ old: "古い項目", new: "新しい項目" }],
    });
    expect(edited).toEqual({
      isError: false,
      json: {
        id,
        title: "Doc",
        visibility: "draft",
        version: 2,
        bodySha256: expect.stringMatching(SHA256_HEX),
        updatedAt: expect.any(Number),
        url: expect.stringContaining(`/p/${id}`),
        titleUrl: null,
        changed: true,
      },
    });
    expect((await call("read_page", { id })).json.body).toBe(
      "# 見出し\n\n- 新しい項目\n- 残す項目\n",
    );
    expect(metrics.at(-1)).toEqual({
      op: "update",
      actor,
      pageId: id,
      rowsWritten: expect.any(Number),
    });
    const revisions = (await call("list_revisions", { id })).json.revisions as {
      version: number;
    }[];
    expect(revisions.map((r) => r.version)).toEqual([2, 1]);
  });

  it("複数の edit は適用する前の本文に対して数え、順序が違っても同じ結果になる", async () => {
    const body = "alpha\nbeta\ngamma\n";
    const edits = [
      { old: "alpha", new: "beta" },
      { old: "gamma", new: "" },
      { old: "beta\n", new: "BETA\n" },
    ];
    const forward = await created(body, "Forward");
    expect(await forward.call("edit_page", { id: forward.id, version: 1, edits })).toMatchObject({
      isError: false,
      json: { version: 2, changed: true },
    });
    // 1 件目の new に現れた "beta" は、3 件目の old には一致しない
    expect((await forward.call("read_page", { id: forward.id })).json.body).toBe("beta\nBETA\n\n");

    const reversed = await created(body, "Reversed");
    await reversed.call("edit_page", { id: reversed.id, version: 1, edits: edits.toReversed() });
    expect((await reversed.call("read_page", { id: reversed.id })).json.body).toBe(
      "beta\nBETA\n\n",
    );
  });

  it("0 件の一致と 2 件以上の一致は、失敗した edit の index と件数を返して、ほかの edit も保存しない", async () => {
    const { call, metrics, id } = await created("aaa bbb ccc bbb");
    const before = await snapshotDb();
    const metricsBefore = metrics.length;
    const failed = await call("edit_page", {
      id,
      version: 1,
      edits: [
        { old: "ccc", new: "CCC" },
        { old: "zzz", new: "x" },
        { old: "bbb", new: "x" },
        { old: "aa", new: "x" },
      ],
    });
    expect(failed).toEqual({
      isError: true,
      json: {
        error: "edit_failed",
        message: expect.any(String),
        failures: [
          { index: 1, reason: "not_found", message: expect.any(String) },
          { index: 2, reason: "ambiguous", matches: 2, message: expect.any(String) },
          // 重なる一致も数えるので、"aa" は "aaa" の中の 2 か所に一致する
          { index: 3, reason: "ambiguous", matches: 2, message: expect.any(String) },
        ],
      },
    });
    expect(await snapshotDb()).toEqual(before);
    expect(metrics).toHaveLength(metricsBefore);
  });

  it("本文の同じ範囲で重なる edit は overlap で拒み、隣り合うだけなら通す", async () => {
    const { call, id } = await created("0123456789");
    const before = await snapshotDb();
    expect(
      await call("edit_page", {
        id,
        version: 1,
        edits: [
          { old: "23456", new: "x" },
          { old: "01234", new: "y" },
          { old: "9", new: "z" },
        ],
      }),
    ).toEqual({
      isError: true,
      json: {
        error: "edit_failed",
        message: expect.any(String),
        failures: [{ index: 0, reason: "overlap", with: 1, message: expect.any(String) }],
      },
    });
    expect(await snapshotDb()).toEqual(before);
    expect(
      await call("edit_page", {
        id,
        version: 1,
        edits: [
          { old: "01234", new: "a" },
          { old: "56789", new: "b" },
        ],
      }),
    ).toMatchObject({ isError: false });
    expect((await call("read_page", { id })).json.body).toBe("ab");
  });

  it("空の old、空の edits、101 件以上、知らないキーは schema の検証で拒み、何も保存しない", async () => {
    const { call, id } = await created("abc");
    const before = await snapshotDb();
    expect(await call("edit_page", { id, version: 1, edits: [{ old: "", new: "x" }] })).toEqual({
      isError: true,
      json: { error: "invalid_field", field: "edits.0.old", message: "1 文字以上で渡す" },
    });
    expect(await call("edit_page", { id, version: 1, edits: [] })).toMatchObject({
      isError: true,
      json: { error: "invalid_field", field: "edits" },
    });
    const tooMany = Array.from({ length: 101 }, () => ({ old: "a", new: "b" }));
    expect(await call("edit_page", { id, version: 1, edits: tooMany })).toMatchObject({
      isError: true,
      json: { error: "invalid_field", field: "edits", max: 100 },
    });
    expect(await call("edit_page", { id, version: 1 })).toMatchObject({
      isError: true,
      json: { error: "missing_field", field: "edits" },
    });
    expect(
      await call("edit_page", { id, version: 1, edits: [{ old: "a", new: "b", extra: 1 }] }),
    ).toMatchObject({ isError: true });
    expect(await call("edit_page", { id, version: 1, title: "x", edits: [] })).toMatchObject({
      isError: true,
      json: { error: "unknown_field", field: "title" },
    });
    expect(await snapshotDb()).toEqual(before);
  });

  it("版が古ければ update_page と同じ version_conflict と最新の本文を返し、edit を適用しない", async () => {
    const { call, metrics, id } = await created("v1 本文");
    await call("update_page", { id, version: 1, title: "Doc", body: "v2 本文" });
    const before = await snapshotDb();
    const metricsBefore = metrics.length;
    const edit = { old: "本文", new: "BODY" };
    const stale = await call("edit_page", { id, version: 1, edits: [edit] });
    expect(stale).toEqual({
      isError: true,
      json: {
        error: "version_conflict",
        message:
          "version が合わない。最新の title と body を読み直し、変更を載せ直してから保存し直す",
        currentVersion: 2,
        current: { title: "Doc", body: "v2 本文", version: 2 },
      },
    });
    // 古い版では、一致しない edit も version_conflict が先になる
    expect(
      await call("edit_page", { id, version: 1, edits: [{ old: "存在しない", new: "x" }] }),
    ).toEqual(stale);
    expect(await snapshotDb()).toEqual(before);
    expect(metrics).toHaveLength(metricsBefore);

    expect(await call("edit_page", { id, version: 2, edits: [edit] })).toMatchObject({
      isError: false,
      json: { version: 3 },
    });
  });

  it("置き換えた結果が今の本文と同じなら、何も書かずに今の版を返す", async () => {
    const { call, metrics, id } = await created("same");
    const before = await snapshotDb();
    const metricsBefore = metrics.length;
    const result = await call("edit_page", {
      id,
      version: 1,
      edits: [{ old: "same", new: "same" }],
    });
    expect(result).toMatchObject({ isError: false, json: { version: 1, changed: false } });
    // edits の件数は呼び出し元が知っている値で、保存の有無と取り違えるので返さない
    expect(result.json).not.toHaveProperty("applied");
    expect(await snapshotDb()).toEqual(before);
    expect(metrics).toHaveLength(metricsBefore);
  });

  it("タグとリンクの派生データは、置き換えた本文から作り直す", async () => {
    const { call, id } = await created("[[Other]] #old\n");
    expect(
      await call("edit_page", {
        id,
        version: 1,
        edits: [
          { old: "[[Other]]", new: "[[Another]]" },
          { old: "#old", new: "#fresh" },
        ],
      }),
    ).toMatchObject({ isError: false });
    expect((await tagsOf(id)).map((t) => t.tag)).toEqual(["fresh"]);
    expect((await linksFrom(id)).map((l) => l.key)).toEqual(["another"]);
  });

  it("frontmatter の visibility を置き換えても、update_page と同じく公開範囲は変わらない", async () => {
    for (const [from, to] of [
      ["draft", "public"],
      ["public", "draft"],
    ] as const) {
      const viaEdit = await created(`---\nvisibility: ${from}\n---\n本文\n`, `Edit ${from}`);
      const viaUpdate = await created(`---\nvisibility: ${from}\n---\n本文\n`, `Update ${from}`);
      await setVisibility(viaEdit.id, from);
      await setVisibility(viaUpdate.id, from);
      const edited = await viaEdit.call("edit_page", {
        id: viaEdit.id,
        version: 1,
        edits: [{ old: `visibility: ${from}`, new: `visibility: ${to}` }],
      });
      const updated = await viaUpdate.call("update_page", {
        id: viaUpdate.id,
        version: 1,
        title: `Update ${from}`,
        body: `---\nvisibility: ${to}\n---\n本文\n`,
      });
      expect(edited).toMatchObject({ isError: false, json: { visibility: from, version: 2 } });
      expect(updated).toMatchObject({ isError: false, json: { visibility: from, version: 2 } });
      expect((await viaEdit.call("read_page", { id: viaEdit.id })).json).toMatchObject({
        visibility: from,
        body: `---\nvisibility: ${to}\n---\n本文\n`,
      });
    }
  });

  it("保存後の本文が上限を超えるか NUL を含むときは、update_page と同じエラーで何も書かない", async () => {
    const { call, id } = await created("元の本文");
    const before = await snapshotDb();
    const largeBody = "あ".repeat(Math.floor(MAX_BODY_BYTES / 3) + 1);
    expect(
      await call("edit_page", { id, version: 1, edits: [{ old: "元の本文", new: largeBody }] }),
    ).toEqual({
      isError: true,
      json: {
        error: "body_too_large",
        field: "body",
        max: MAX_BODY_BYTES,
        actual: largeBody.length * 3,
        unit: "utf8_bytes",
        message: expect.any(String),
      },
    });
    expect(
      await call("edit_page", { id, version: 1, edits: [{ old: "元の", new: "\u0000" }] }),
    ).toMatchObject({
      isError: true,
      json: { error: "invalid_field", field: "body", reason: "control_char", line: 1, column: 1 },
    });
    expect(await snapshotDb()).toEqual(before);
  });

  it("上限の件数の edit を、上限近い本文に対しても処理する", async () => {
    const letters = Array.from({ length: 100 }, (_, i) => String.fromCharCode(0x3041 + i));
    const body = letters.join("").padEnd(Math.floor(MAX_BODY_BYTES / 3) - 10, "\n");
    const { call, id } = await created(body);
    const edits = letters.map((old) => ({ old, new: "x" }));
    expect(await call("edit_page", { id, version: 1, edits })).toMatchObject({
      isError: false,
      json: { version: 2, changed: true },
    });
  });
});

describe("版の履歴の tool", () => {
  /** create_page と 2 回の update_page で版 1〜3 を積む。token の書き込みはまとめない */
  async function threeVersions() {
    const client = await mcpClient();
    const { call, clock } = client;
    clock.now = T0;
    const { json: created } = await call("create_page", { title: "Draft", body: "v1" });
    const id = created.id as string;
    clock.now = T0 + 10;
    await call("update_page", { id, version: 1, title: "Draft", body: "v2" });
    clock.now = T0 + 20;
    await call("update_page", { id, version: 2, title: "Final", body: "v3" });
    return { ...client, id, author: parseActor(client.actor) };
  }

  it("list_revisions は id と title のどちらでも、版の新しい順に本文を除いて返し、cursor で続きを取る", async () => {
    const { call, id, author } = await threeVersions();
    const all = {
      revisions: [
        { version: 3, title: "Final", createdAt: T0 + 20, author },
        { version: 2, title: "Draft", createdAt: T0 + 10, author },
        { version: 1, title: "Draft", createdAt: T0, author },
      ],
      nextCursor: null,
    };
    expect(await call("list_revisions", { id })).toEqual({ isError: false, json: all });
    expect(await call("list_revisions", { title: "final" })).toEqual({ isError: false, json: all });

    const first = await call("list_revisions", { id, limit: 2 });
    expect(first.json).toEqual({ revisions: all.revisions.slice(0, 2), nextCursor: "2" });
    const rest = await call("list_revisions", { id, limit: 2, cursor: "2" });
    expect(rest.json).toEqual({ revisions: all.revisions.slice(2), nextCursor: null });
  });

  it("read_page に revision を渡すと、上の階層は今のページの値だけにし、版の title と本文は revision に入れる", async () => {
    const { call, id, author } = await threeVersions();
    const res = await call("read_page", { id, revision: 1 });
    expect(res).toEqual({
      isError: false,
      json: {
        id,
        title: "Final",
        visibility: "draft",
        version: 3,
        createdAt: T0,
        updatedAt: T0 + 20,
        url: `${ORIGIN}/p/${id}`,
        titleUrl: null,
        revision: {
          version: 1,
          title: "Draft",
          body: "v1",
          bodySha256: expect.stringMatching(SHA256_HEX),
          createdAt: T0,
          author,
        },
      },
    });
    expect(res.json).not.toHaveProperty("body");
    const byTitle = await call("read_page", { title: "Final", revision: 2 });
    expect(byTitle.json).toMatchObject({
      id,
      title: "Final",
      revision: { version: 2, title: "Draft", body: "v2" },
    });
    expect(byTitle.json).not.toHaveProperty("body");
  });

  it("read の token でも draft の履歴を読める", async () => {
    const { id } = await threeVersions();
    const reader = await mcpClient({ name: "reader", scopes: "read" });
    expect((await reader.call("list_revisions", { id })).isError).toBe(false);
    expect(await reader.call("read_page", { id, revision: 1 })).toMatchObject({
      isError: false,
      json: { revision: { body: "v1" } },
    });
  });

  it("無い版は revision_not_found、無いページは not_found で、別のページの版の番号は読めない", async () => {
    const { call, id } = await threeVersions();
    const { json: other } = await call("create_page", { title: "Other", body: "one" });
    expect(await call("read_page", { id, revision: 4 })).toEqual({
      isError: true,
      json: { error: "revision_not_found" },
    });
    expect(await call("read_page", { id: other.id, revision: 3 })).toEqual({
      isError: true,
      json: { error: "revision_not_found" },
    });
    for (const args of [
      { id: "short", revision: 1 },
      { id: "A".repeat(22), revision: 1 },
      { title: "missing", revision: 1 },
    ]) {
      expect(await call("read_page", args)).toEqual({
        isError: true,
        json: { error: "not_found" },
      });
    }
    for (const args of [{ id: "short" }, { id: "A".repeat(22) }, { title: "missing" }]) {
      expect(await call("list_revisions", args)).toEqual({
        isError: true,
        json: { error: "not_found" },
      });
    }
  });

  it("list_revisions の id と title と cursor のエラーは isError", async () => {
    const { call, id } = await threeVersions();
    expect(await call("list_revisions", {})).toMatchObject({
      isError: true,
      json: { error: "invalid_arguments" },
    });
    expect(await call("list_revisions", { id, title: "Final" })).toMatchObject({
      isError: true,
      json: { error: "invalid_arguments" },
    });
    for (const cursor of ["", "0", "x", "01", "1".repeat(16)]) {
      expect(await call("list_revisions", { id, cursor }), cursor).toEqual({
        isError: true,
        json: { error: "invalid_field", field: "cursor" },
      });
    }
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
            version: 1,
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
    expect(await call("search", { query: "x".repeat(201) })).toEqual({
      isError: true,
      json: {
        error: "invalid_field",
        field: "query",
        reason: "too_long",
        max: 200,
        message: "検索語が長すぎる（上限 200 文字）",
      },
    });
    expect(await call("search", { query: "abc", limit: 0 })).toEqual({
      isError: true,
      json: { error: "invalid_field", field: "limit", message: "1 以上で渡す" },
    });
    expect(await call("search", { query: "abc", limit: 51 })).toEqual({
      isError: true,
      json: { error: "invalid_field", field: "limit", max: 50, message: "50 以下で渡す" },
    });
    expect(await call("search", { query: "abc", limit: 1e300 })).toEqual({
      isError: true,
      json: { error: "invalid_field", field: "limit", max: 50, message: "50 以下で渡す" },
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
      json: { error: "invalid_field", field: "limit", max: 100, message: "100 以下で渡す" },
    });
  });

  it("list_recent の各件の createdAt はページを作った時刻（epoch ミリ秒）で、更新しても変わらない", async () => {
    const { call, clock } = await mcpClient();
    clock.now = T0 + 1000;
    const first = (await call("create_page", { title: "First", body: "" })).json;
    clock.now = T0 + 2000;
    const second = (await call("create_page", { title: "Second", body: "" })).json;
    clock.now = T0 + 3000;
    await call("update_page", { id: first.id, version: first.version, title: "First", body: "x" });

    const pages = (await call("list_recent", {})).json.pages as { id: string; createdAt: number }[];
    // 更新で First が先頭に移っても、createdAt は作った時刻のまま
    expect(pages.map((p) => [p.id, p.createdAt])).toEqual([
      [first.id, T0 + 1000],
      [second.id, T0 + 2000],
    ]);
    expect((await call("read_page", { id: first.id })).json.createdAt).toBe(T0 + 1000);
  });

  it("search、list_recent、list_backlinks の各件の version は read_page と同じで、そのまま update_page に渡せる", async () => {
    const { call, clock } = await mcpClient();
    const { json: a } = await call("create_page", { title: "Alpha", body: "検索の対象の本文" });
    clock.now += 1000;
    const { json: b } = await call("create_page", { title: "Beta", body: "[[Alpha]]" });
    await call("update_page", { id: a.id, version: 1, title: "Alpha", body: "検索の対象の本文 2" });
    // 公開範囲の切り替えも version を進める
    clock.now += 1000;
    const switched = await switchVisibility(env.DB, {
      id: a.id as string,
      visibility: "public",
      now: clock.now,
    });
    expect(switched.ok).toBe(true);
    expect((await call("read_page", { id: a.id })).json.version).toBe(3);

    const versionOf = (json: Record<string, unknown>, key: string, id: unknown) =>
      (json[key] as { id: string; version: number }[]).find((page) => page.id === id)?.version;
    // FTS（3 文字以上）と LIKE（2 文字以下）のどちらの経路にも version が付く
    const results = [
      (await call("search", { query: "対象の本文" })).json,
      (await call("search", { query: "Al" })).json,
    ];
    for (const json of results) expect(versionOf(json, "results", a.id)).toBe(3);
    expect(versionOf((await call("list_recent", {})).json, "pages", a.id)).toBe(3);
    expect(versionOf((await call("list_recent", {})).json, "pages", b.id)).toBe(1);
    expect(versionOf((await call("list_backlinks", { title: "Alpha" })).json, "pages", b.id)).toBe(
      1,
    );
    expect(versionOf((await call("list_backlinks", { id: a.id })).json, "pages", b.id)).toBe(1);

    // 一覧の version で保存でき、保存すると一覧の version も進む。古い version は conflict になる
    const listed = versionOf((await call("list_recent", {})).json, "pages", a.id);
    const saved = await call("update_page", {
      id: a.id,
      version: listed,
      title: "Alpha",
      body: "検索の対象の本文 3",
    });
    expect(saved).toMatchObject({ isError: false, json: { version: 4 } });
    expect(versionOf((await call("list_recent", {})).json, "pages", a.id)).toBe(4);
    expect(
      await call("update_page", { id: a.id, version: listed, title: "Alpha", body: "古い版" }),
    ).toMatchObject({ isError: true, json: { error: "version_conflict" } });
  });

  it("list_recent の tag は親で子も拾い、表記を畳み、cursor で続きを取れる", async () => {
    const { call, clock } = await mcpClient();
    const ids: Record<string, string> = {};
    for (const [title, body] of [
      ["parent", "#Work"],
      ["child", "#work/Project"],
      ["grandchild", "#work/project/deep #other"],
      ["lookalike", "#workshop"],
      ["none", ""],
    ] as const) {
      clock.now += 1000;
      ids[title] = (await call("create_page", { title, body })).json.id as string;
    }
    const titlesOf = async (args: Record<string, unknown>) =>
      ((await call("list_recent", args)).json.pages as { title: string }[]).map((p) => p.title);

    expect(await titlesOf({ tag: "work" })).toEqual(["grandchild", "child", "parent"]);
    for (const tag of ["#work", "WORK", "Ｗork", " #Work "]) {
      expect(await titlesOf({ tag }), tag).toEqual(["grandchild", "child", "parent"]);
    }
    expect(await titlesOf({ tag: "work/project" })).toEqual(["grandchild", "child"]);
    expect(await titlesOf({ tag: "other" })).toEqual(["grandchild"]);
    expect(await titlesOf({ tag: "none" })).toEqual([]);
    expect(await titlesOf({})).toHaveLength(5);

    const first = await call("list_recent", { tag: "work", limit: 2 });
    expect((first.json.pages as { id: string }[]).map((p) => p.id)).toEqual([
      ids.grandchild,
      ids.child,
    ]);
    expect(first.json.nextCursor).toEqual(expect.any(String));
    const rest = await call("list_recent", {
      tag: "work",
      limit: 2,
      cursor: first.json.nextCursor,
    });
    expect((rest.json.pages as { id: string }[]).map((p) => p.id)).toEqual([ids.parent]);
    expect(rest.json.nextCursor).toBeNull();
  });

  it("list_recent の tag が空か長すぎると invalid_field", async () => {
    const { call } = await mcpClient();
    for (const tag of ["", "#", " ＃ "]) {
      expect(await call("list_recent", { tag }), tag).toEqual({
        isError: true,
        json: {
          error: "invalid_field",
          field: "tag",
          reason: "empty",
          message: expect.any(String),
        },
      });
    }
    expect(await call("list_recent", { tag: "a".repeat(201) })).toEqual({
      isError: true,
      json: {
        error: "invalid_field",
        field: "tag",
        reason: "too_long",
        max: 200,
        message: expect.any(String),
      },
    });
    expect((await call("list_recent", { tag: "a".repeat(200) })).isError).toBe(false);
    expect(await call("list_recent", { tag: 1 })).toMatchObject({
      isError: true,
      json: { error: "invalid_field", field: "tag" },
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

  it("list_backlinks は id と title の指定のエラーを invalid_arguments か invalid_field で返す", async () => {
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

  describe("list_unresolved_links", () => {
    const keysOf = (outcome: ToolOutcome) =>
      (outcome.json.links as { titleKey: string }[]).map((link) => link.titleKey);

    it("行き先の無いリンクを title_key ごとにまとめ、リンク元を新しい順に返す", async () => {
      const { call, clock } = await mcpClient({ name: "writer" });
      await call("create_page", { title: "Exists", body: "" });
      const { json: a } = await call("create_page", {
        title: "A",
        body: "[[Exists]] [[Ghost Page]] [[Missing]]",
      });
      clock.now += 1000;
      const { json: b } = await call("create_page", { title: "B", body: "[[ghost_page]]" });
      // 添付の embed は page への参照ではない
      await call("create_page", { title: "C", body: "![[image.png]]" });

      const reader = await mcpClient({ name: "reader", scopes: "read" });
      const listed = await reader.call("list_unresolved_links", {});
      expect(listed.isError).toBe(false);
      expect(listed.json.nextCursor).toBeNull();
      expect(listed.json.links).toEqual([
        {
          titleKey: "ghost page",
          sourceCount: 2,
          sources: [
            {
              id: b.id,
              title: "B",
              visibility: "draft",
              updatedAt: T0 + 1000,
              url: `${ORIGIN}/p/${b.id}`,
              titleUrl: null,
            },
            {
              id: a.id,
              title: "A",
              visibility: "draft",
              updatedAt: T0,
              url: `${ORIGIN}/p/${a.id}`,
              titleUrl: null,
            },
          ],
        },
        {
          titleKey: "missing",
          sourceCount: 1,
          sources: [expect.objectContaining({ id: a.id })],
        },
      ]);
    });

    it("sources は先頭の数件だけで、sourceCount は全体の数", async () => {
      const { call, clock } = await mcpClient({ name: "writer" });
      for (let i = 0; i < UNRESOLVED_SOURCES_PER_TITLE + 2; i++) {
        clock.now += 1000;
        await call("create_page", { title: `S${i}`, body: "[[Ghost]]" });
      }
      const [link] = (await call("list_unresolved_links", {})).json.links as {
        sourceCount: number;
        sources: { title: string }[];
      }[];
      expect(link?.sourceCount).toBe(UNRESOLVED_SOURCES_PER_TITLE + 2);
      expect(link?.sources.map((s) => s.title)).toEqual(
        ["S6", "S5", "S4", "S3", "S2"].slice(0, UNRESOLVED_SOURCES_PER_TITLE),
      );
    });

    it("ページを作ると消え、正規化の違う title のページでも消える", async () => {
      const { call } = await mcpClient({ name: "writer" });
      await call("create_page", { title: "Src", body: "[[Ghost Page]] [[Other]] [[ｐｉｎｇ]]" });
      expect(keysOf(await call("list_unresolved_links", {}))).toEqual([
        "ghost page",
        "other",
        "ping",
      ]);

      await call("create_page", { title: "GHOST_PAGE", body: "" });
      await call("create_page", { title: "Ping", body: "" });
      expect(keysOf(await call("list_unresolved_links", {}))).toEqual(["other"]);
    });

    it("改題の直後は旧 title が出て、rewrite_links で remaining が 0 になると消える", async () => {
      const { call } = await mcpClient({ name: "writer" });
      const { json: a } = await call("create_page", { title: "Old Name", body: "" });
      const { json: b } = await call("create_page", { title: "B", body: "[[Old Name]]" });
      expect(keysOf(await call("list_unresolved_links", {}))).toEqual([]);

      await call("update_page", { id: a.id, version: 1, title: "New Name", body: "" });
      const renamed = await call("list_unresolved_links", {});
      expect(renamed.json.links).toEqual([
        {
          titleKey: "old name",
          sourceCount: 1,
          sources: [expect.objectContaining({ id: b.id, title: "B" })],
        },
      ]);

      const stepped = await call("rewrite_links", {});
      expect(stepped.json).toMatchObject({ processed: { id: b.id }, remaining: 0 });
      expect(keysOf(await call("list_unresolved_links", {}))).toEqual([]);
      expect((await call("read_page", { id: b.id })).json.body).toBe("[[New Name]]");
    });

    it("削除したページへのリンクは出て、削除したページが書いたリンクは出ない", async () => {
      const { call, request } = await mcpClient({ name: "writer" });
      const { json: target } = await call("create_page", { title: "Target", body: "" });
      await call("create_page", { title: "Src", body: "[[Target]]" });
      const { json: gone } = await call("create_page", {
        title: "Gone",
        body: "[[Only From Gone]]",
      });
      expect(keysOf(await call("list_unresolved_links", {}))).toEqual(["only from gone"]);

      for (const [id, version] of [
        [target.id, 1],
        [gone.id, 1],
      ] as const) {
        const res = await request(`/api/pages/${id}`, {
          method: "DELETE",
          headers: { "If-Match": `"${version}"` },
        });
        expect(res.status).toBeLessThan(300);
      }
      expect(keysOf(await call("list_unresolved_links", {}))).toEqual(["target"]);
    });

    it("limit と cursor で title_key の順に続きを取る", async () => {
      const { call } = await mcpClient({ name: "writer" });
      await call("create_page", { title: "Src", body: "[[c]] [[a]] [[b]]" });
      const first = await call("list_unresolved_links", { limit: 2 });
      expect(keysOf(first)).toEqual(["a", "b"]);
      expect(first.json.nextCursor).toEqual(expect.any(String));
      const rest = await call("list_unresolved_links", {
        limit: 2,
        cursor: first.json.nextCursor,
      });
      expect(keysOf(rest)).toEqual(["c"]);
      expect(rest.json.nextCursor).toBeNull();

      // ちょうど limit 件で終わるときは続きを返さない
      const exact = await call("list_unresolved_links", { limit: 3 });
      expect(keysOf(exact)).toEqual(["a", "b", "c"]);
      expect(exact.json.nextCursor).toBeNull();

      for (const limit of [0, 101]) {
        expect(await call("list_unresolved_links", { limit })).toMatchObject({
          isError: true,
          json: { error: "invalid_field", field: "limit" },
        });
      }
    });

    it("先頭と末尾の `_` が空白で残る titleKey も、nextCursor をそのまま渡せば取りこぼさず続きを取れる", async () => {
      const { call } = await mcpClient({ name: "writer" });
      await call("create_page", { title: "Src", body: "[[__init__]] [[b_]] [[a]]" });
      const keys: string[] = [];
      let cursor: unknown;
      for (let i = 0; i < 5; i++) {
        const page = await call("list_unresolved_links", { limit: 1, cursor });
        expect(page.isError).toBe(false);
        keys.push(...keysOf(page));
        cursor = page.json.nextCursor;
        if (cursor === null) break;
      }
      // normalizeTitleKey し直すと `init` と `b` になり、nextCursor と一致しなくなる値
      expect(keys).toEqual(["  init  ", "a", "b "]);
      expect(cursor).toBeNull();
    });

    it("cursor は形を検査せず、渡した文字列より大きい titleKey を返す", async () => {
      const { call } = await mcpClient({ name: "writer" });
      await call("create_page", { title: "Src", body: "[[a]] [[b]] [[c]]" });
      // nextCursor の形でない値と、正規化すると変わる値でも、エラーにならず下限として使う
      for (const [cursor, expected] of [
        ["", ["a", "b", "c"]],
        ["B", ["a", "b", "c"]],
        ["ａ", []],
        ["a ", ["b", "c"]],
        ["a", ["b", "c"]],
        ["bb", ["c"]],
        ["z", []],
      ] as const) {
        const listed = await call("list_unresolved_links", { cursor });
        expect(listed.isError).toBe(false);
        expect(keysOf(listed)).toEqual(expected);
      }
    });

    it("id か title を渡すと、そのページの本文にあるリンクだけを返す", async () => {
      const { call } = await mcpClient({ name: "writer" });
      const { json: a } = await call("create_page", { title: "A page", body: "[[x]] [[y]]" });
      await call("create_page", { title: "Another", body: "[[y]] [[z]]" });
      await call("create_page", { title: "Clean", body: "text" });

      const byId = await call("list_unresolved_links", { id: a.id });
      expect(keysOf(byId)).toEqual(["x", "y"]);
      expect(byId.json.links).toEqual([
        { titleKey: "x", sourceCount: 1, sources: [expect.objectContaining({ id: a.id })] },
        { titleKey: "y", sourceCount: 1, sources: [expect.objectContaining({ id: a.id })] },
      ]);
      expect(await call("list_unresolved_links", { title: "A_PAGE" })).toEqual(byId);
      expect(await call("list_unresolved_links", { title: "Clean" })).toEqual({
        isError: false,
        json: { links: [], nextCursor: null },
      });
    });

    it("ページの指定のエラーは not_found か invalid_arguments", async () => {
      const { call } = await mcpClient({ name: "writer" });
      const { json: a } = await call("create_page", { title: "A", body: "" });
      const notFound = { isError: true, json: { error: "not_found" } };
      for (const args of [
        { id: "A".repeat(22) },
        { id: "bad" },
        { title: "Nope" },
        { title: " " },
      ]) {
        expect(await call("list_unresolved_links", args)).toEqual(notFound);
      }
      expect(await call("list_unresolved_links", { id: a.id, title: "A" })).toMatchObject({
        isError: true,
        json: { error: "invalid_arguments" },
      });
    });

    it("id で引くとき、draft のページは read の token でも引け、削除済みのページは not_found", async () => {
      const writer = await mcpClient({ name: "writer" });
      const { json: draft } = await writer.call("create_page", { title: "Draft", body: "[[x]]" });
      const { json: gone } = await writer.call("create_page", { title: "Gone", body: "[[y]]" });
      await env.DB.prepare("UPDATE pages SET deleted_at = ?2, deleted_by = 'owner' WHERE id = ?1")
        .bind(gone.id as string, T0)
        .run();

      const reader = await mcpClient({ name: "reader", scopes: "read" });
      expect(keysOf(await reader.call("list_unresolved_links", { id: draft.id }))).toEqual(["x"]);
      expect(await reader.call("list_unresolved_links", { id: gone.id })).toEqual({
        isError: true,
        json: { error: "not_found" },
      });
    });

    it("read の token で使え、write の無い token でも draft のリンク元を返す", async () => {
      const writer = await mcpClient({ name: "writer" });
      const { json: open } = await writer.call("create_page", { title: "Open", body: "[[Ghost]]" });
      const { json: hidden } = await writer.call("create_page", {
        title: "Hidden",
        body: "[[Ghost]]",
      });
      await setVisibility(open.id as string, "public");

      const reader = await mcpClient({ name: "reader", scopes: "read" });
      const listed = await reader.call("list_unresolved_links", {});
      const [link] = listed.json.links as { sourceCount: number; sources: { id: string }[] }[];
      expect(link?.sourceCount).toBe(2);
      expect(link?.sources.map((s) => s.id).sort()).toEqual([open.id, hidden.id].sort());
      // list_backlinks の title 引きと同じリンク元
      const backlinks = await reader.call("list_backlinks", { title: "ghost" });
      expect((backlinks.json.pages as { id: string }[]).map((p) => p.id)).toEqual(
        link?.sources.map((s) => s.id),
      );
    });
  });
});

describe("リクエストをまたいだ状態", () => {
  // 1 つの app（= 1 つの handler）に別の principal のリクエストを交互に流し、値が混ざらないことを確かめる
  async function sharedApp() {
    const metrics: WriteMetric[] = [];
    const app = createApp({ now: () => T0, recordWrite: (m) => metrics.push(m) });
    const tokens = {
      alice: await insertApiToken({ name: "alice", scopes: "read write" }),
      bob: await insertApiToken({ name: "bob", scopes: "read" }),
      carol: await insertApiToken({ name: "carol", scopes: "read write" }),
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
    const call = async (who: keyof typeof tokens, name: string, args: Record<string, unknown>) => {
      const { result } = await rpc(who, "tools/call", { name, arguments: args });
      const content = (result as { content: { text: string }[] }).content;
      return JSON.parse(content[0]?.text ?? "") as Record<string, unknown>;
    };
    return { rpc, create, call, metrics, tokens };
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

  it("同時に流したリクエストでも、principal ごとの結果が入れ替わらない", async () => {
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

  it("別の token が rewrite_links を呼んでも、書き換えた版の作者と計測の actor は改題した token になる", async () => {
    const { call, metrics, tokens } = await sharedApp();
    const target = await call("alice", "create_page", { title: "Old", body: "" });
    const source = await call("carol", "create_page", { title: "S", body: "[[Old]]" });
    await call("alice", "update_page", { id: target.id, version: 1, title: "New", body: "" });

    const stepped = await call("carol", "rewrite_links", {});
    expect(stepped).toMatchObject({ processed: { id: source.id, version: 2 }, remaining: 0 });

    const { revisions } = (await call("carol", "list_revisions", { id: source.id })) as {
      revisions: { version: number; author: unknown }[];
    };
    expect(revisions.map(({ version, author }) => ({ version, author }))).toEqual([
      { version: 2, author: parseActor(tokens.alice.actor) },
      { version: 1, author: parseActor(tokens.carol.actor) },
    ]);
    expect(metrics.filter((metric) => metric.op === "link_rewrite")).toEqual([
      {
        op: "link_rewrite",
        actor: tokens.alice.actor,
        pageId: source.id,
        rowsWritten: expect.any(Number),
      },
    ]);
  });

  it("rewrite_links に targetPageId を渡すと、選んだリンク元のほかの改題の分も 1 つの版で書き換える", async () => {
    const { call, metrics, tokens } = await sharedApp();
    const a = await call("alice", "create_page", { title: "Alpha", body: "" });
    const b = await call("alice", "create_page", { title: "Beta", body: "" });
    const both = await call("carol", "create_page", { title: "Both", body: "[[Alpha]] [[Beta]]" });
    const onlyA = await call("carol", "create_page", { title: "OnlyA", body: "[[Alpha]]" });
    await call("alice", "update_page", { id: a.id, version: 1, title: "Alpha 2", body: "" });
    await call("alice", "update_page", { id: b.id, version: 1, title: "Beta 2", body: "" });

    const stepped = await call("carol", "rewrite_links", { targetPageId: b.id });
    // remaining は targetPageId の分だけを数えるので、Alpha の改題だけで待つ OnlyA は含まない
    expect(stepped).toMatchObject({
      processed: { id: both.id, version: 2, rewritten: 2 },
      remaining: 0,
    });
    expect((await call("carol", "read_page", { id: both.id })).body).toBe("[[Alpha 2]] [[Beta 2]]");
    expect((await call("carol", "read_page", { id: onlyA.id })).body).toBe("[[Alpha]]");
    const written = metrics.filter((metric) => metric.op === "link_rewrite");
    expect(written).toMatchObject([{ actor: tokens.alice.actor, pageId: both.id }]);
    expect((await call("carol", "rewrite_links", {})).processed).toMatchObject({ id: onlyA.id });
  });

  it("tools/call のあとの tools/list は 11 個の tool を返し、知らない tool は JSON-RPC のエラー", async () => {
    const { rpc, create } = await sharedApp();
    await create("alice", "First");
    const listed = await rpc("bob", "tools/list");
    expect((listed.result?.tools as unknown[] | undefined)?.length).toBe(11);

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
      expect(registeredNames()).toEqual(TOOL_NAMES);

      registerTool.mockClear();
      createWikiMcpServer(ctx);
      expect(registeredNames()).toEqual(TOOL_NAMES);
    } finally {
      registerTool.mockRestore();
    }
  });
});
