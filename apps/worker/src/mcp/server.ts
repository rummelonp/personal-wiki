import {
  type AuthInfo,
  createMcpHandler,
  INVALID_REQUEST,
  isJsonContentType,
  McpServer,
  originValidationResponse,
  PARSE_ERROR,
} from "@modelcontextprotocol/server";
import type { Hono } from "hono";
import { requireToken } from "../auth/middleware";
import type { AppEnv } from "../env";
import { MAX_REQUEST_BYTES, type WriteMetric } from "../pages/operations";
import { MAX_BODY_BYTES } from "../pages/store";
import { PAGE_TOOLS } from "./page-tools";
import { SEARCH_TOOLS } from "./search-tools";
import type { WikiTool, WikiToolContext } from "./tool";

/** tools/list に出る順。tool を足すときはここに並べる。 */
const TOOLS: readonly WikiTool[] = [...SEARCH_TOOLS, ...PAGE_TOOLS];

/** 接続中ずっとクライアントの文脈に載るので、tool をまたぐ規則だけを短く書く。tool 固有の規則は description に書く */
const INSTRUCTIONS = [
  "オーナー一人の Markdown wiki。",
  "- 作業の始めに主題の語で search し、関連するノートを read_page で読む。",
  "- 新しく作る前に search で同じ主題を探し、あれば作らずに追記か更新する。",
  "- メモや調べた結果は append_to_page で末尾に足す。update_page での本文全体の書き換えは構成を直すときだけ。",
  "- 作るノートは draft。draft も URL を知っていれば誰でも読めるので、パスワード、API キー、トークン、個人情報などの秘密を書かない。",
  "- 公開範囲は tool から変えられない。公開はオーナーがブラウザで行うので、頼まれたらオーナーに伝える。frontmatter に書いても反映されない。",
  "- 本文の `[[title]]` は別ノートへのリンク。参照元は list_backlinks、最近の動きは list_recent で見る。",
].join("\n");

/**
 * tool の登録は、登録のたびに SDK が inputSchema を処理するぶん CPU を使う。tools/call は呼ばれる
 * 1 件しか使わないので、calledTool が TOOLS にあれば、その 1 件だけを登録する。
 * 名前が TOOLS に無いときは全件登録し、「tool が無い」という応答は SDK に任せて変えない。
 */
export function createWikiMcpServer(ctx: WikiToolContext, calledTool?: string): McpServer {
  const server = new McpServer(
    { name: "personal-wiki", version: "0.0.0" },
    { instructions: INSTRUCTIONS },
  );
  const called = TOOLS.filter((tool) => tool.name === calledTool);
  for (const tool of called.length > 0 ? called : TOOLS) tool.register(server, ctx);
  return server;
}

/** handler が factory に渡す、リクエスト 1 件ぶんの値 */
interface McpRequestScope {
  context: WikiToolContext;
  /** tools/call の対象の tool 名。tools/call でなければ undefined */
  calledTool: string | undefined;
}

// handler は factory に env を渡さないので、リクエストごとの値は authInfo.extra に載せて factory へ届ける
const SCOPE_KEY = "wikiMcpRequestScope";

function scopeOf(authInfo: AuthInfo | undefined): McpRequestScope {
  const scope = authInfo?.extra?.[SCOPE_KEY];
  if (scope === undefined) throw new Error("/mcp の handler にリクエストの値が渡されていない");
  return scope as McpRequestScope;
}

function calledToolName(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { method, params } = body as { method?: unknown; params?: unknown };
  if (method !== "tools/call" || typeof params !== "object" || params === null) return undefined;
  const { name } = params as { name?: unknown };
  return typeof name === "string" ? name : undefined;
}

export interface McpRoutesOptions {
  now: () => number;
  recordWrite: (metric: WriteMetric) => void;
}

function jsonRpcError(status: 400, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status });
}

/** 許可する Origin のホスト名。空なので、Origin を付けた要求はすべて 403 になる */
const ALLOWED_ORIGIN_HOSTNAMES: string[] = [];

/**
 * `/mcp` に stateless な Streamable HTTP の MCP サーバーを置く。リクエストごとに McpServer を作り、
 * 認可で決まった principal を tool に閉じ込める。
 *
 * 宣言は 1 つの ALL の登録に requireToken("read") を付け、write の tool は tool の中で scope を見る
 * （tool.ts の defineTool）。SDK の handler は Origin も CORS も扱わないので、ここで決める。
 * - Origin の付いた要求は 403 にする。/mcp を使う正当なブラウザのクライアントは無く、ブラウザ経由の
 *   要求（DNS rebinding を含む）だけが Origin を付ける。
 * - CORS のヘッダーは付けない。preflight は Authorization を持たず requireToken を通らない。
 * - JSON-RPC の batch（本文が配列）は 400 にする。2025-06-18 以降のプロトコルは batch を廃止しており、
 *   1 回の呼び出しで D1 のクエリ数と CPU 時間の上限を超えやすい。
 * GET と DELETE（セッションの操作）は SDK の stateless の経路が 405 で返す。
 */
export function registerMcpRoutes(app: Hono<AppEnv>, { now, recordWrite }: McpRoutesOptions) {
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const { context, calledTool } = scopeOf(authInfo);
      return createWikiMcpServer(context, calledTool);
    },
    {
      onerror: (error) => {
        console.error(JSON.stringify({ event: "mcp.error", error: error.message }));
      },
    },
  );
  return app.all("/mcp", requireToken("read"), async (c) => {
    const rejected = originValidationResponse(c.req.raw, ALLOWED_ORIGIN_HOSTNAMES);
    if (rejected !== undefined) return rejected;
    if (Number(c.req.header("Content-Length")) > MAX_REQUEST_BYTES) {
      return c.json({ error: "body_too_large", max: MAX_BODY_BYTES }, 413);
    }
    // batch を見分けるために本文を読むので、解析した値を SDK に渡して読み直させない。
    // Content-Type が JSON でない POST は読まずに渡し、SDK の 415 に任せる
    let parsedBody: unknown;
    if (c.req.method === "POST" && isJsonContentType(c.req.header("Content-Type"))) {
      try {
        parsedBody = await c.req.json();
      } catch {
        return jsonRpcError(400, PARSE_ERROR, "Parse error: the request body is not valid JSON");
      }
      if (Array.isArray(parsedBody)) {
        return jsonRpcError(400, INVALID_REQUEST, "JSON-RPC の batch は受け付けない");
      }
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
        extra: { [SCOPE_KEY]: { context, calledTool: calledToolName(parsedBody) } },
      },
      ...(parsedBody === undefined ? {} : { parsedBody }),
    });
  });
}
