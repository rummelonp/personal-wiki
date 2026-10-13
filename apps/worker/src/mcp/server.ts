import { type AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { Hono } from "hono";
import { requireToken } from "../auth/middleware";
import type { AppEnv } from "../env";
import type { WriteMetric } from "../pages/operations";
import { MAX_REQUEST_BYTES } from "../pages/routes";
import { MAX_BODY_BYTES } from "../pages/store";
import { PAGE_TOOLS } from "./page-tools";
import type { WikiTool, WikiToolContext } from "./tool";

/** tools/list に出る順。tool を足すときはここに並べる。 */
const TOOLS: readonly WikiTool[] = [...PAGE_TOOLS];

const INSTRUCTIONS = [
  "一人用の Markdown wiki。",
  "作るページは常に draft で、公開はオーナーがブラウザで行う。draft でも URL を知っていれば誰でも読めるので、秘密を書かない。",
  "更新は read_page で version を取ってから update_page で行う。メモやログの書き足しは append_to_page を使う。",
].join("\n");

export function createWikiMcpServer(ctx: WikiToolContext): McpServer {
  const server = new McpServer(
    { name: "personal-wiki", version: "0.0.0" },
    { instructions: INSTRUCTIONS },
  );
  for (const tool of TOOLS) tool.register(server, ctx);
  return server;
}

// handler は factory に env を渡さないので、リクエストごとの値は authInfo.extra に載せて factory へ届ける
const CONTEXT_KEY = "wikiToolContext";

function contextOf(authInfo: AuthInfo | undefined): WikiToolContext {
  const context = authInfo?.extra?.[CONTEXT_KEY];
  if (context === undefined) throw new Error("/mcp の handler に tool の context が渡されていない");
  return context as WikiToolContext;
}

export interface McpRoutesOptions {
  now: () => number;
  recordWrite: (metric: WriteMetric) => void;
}

/**
 * `/mcp` に stateless な Streamable HTTP の MCP サーバーを置く。リクエストごとに McpServer を作り、
 * 認可で決まった principal を tool に閉じ込める。
 *
 * 宣言は 1 つの ALL の登録に requireToken("read") を付け、write の tool は tool の中で scope を見る
 * （tool.ts の defineTool）。CORS は付けない。宛先はブラウザ以外のクライアントで、preflight は
 * Authorization を持たず requireToken を通らない。
 */
export function registerMcpRoutes(app: Hono<AppEnv>, { now, recordWrite }: McpRoutesOptions) {
  const handler = createMcpHandler(({ authInfo }) => createWikiMcpServer(contextOf(authInfo)), {
    route: "/mcp",
    corsOptions: false,
    onerror: (error) => {
      console.error(JSON.stringify({ event: "mcp.error", error: error.message }));
    },
  });
  return app.all("/mcp", requireToken("read"), async (c) => {
    if (Number(c.req.header("Content-Length")) > MAX_REQUEST_BYTES) {
      return c.json({ error: "body_too_large", max: MAX_BODY_BYTES }, 413);
    }
    const principal = c.get("principal");
    const context: WikiToolContext = {
      db: c.env.DB,
      principal,
      origin: new URL(c.req.url).origin,
      now,
      recordWrite,
    };
    return handler.fetch(c.req.raw, {
      authInfo: {
        // 平文の token は認証のあと保持しない。SDK の型が要求するので空にする
        token: "",
        clientId: principal.kind === "token" ? principal.name : principal.kind,
        scopes: principal.kind === "token" ? [...principal.scopes] : [],
        extra: { [CONTEXT_KEY]: context },
      },
    });
  });
}
