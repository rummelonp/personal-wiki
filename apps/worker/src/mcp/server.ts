import {
  type AuthInfo,
  createMcpHandler,
  INVALID_REQUEST,
  isJsonContentType,
  McpServer,
  originValidationResponse,
  PARSE_ERROR,
} from "@modelcontextprotocol/server";
import { DEFAULT_SITE_NAME, MAX_BODY_BYTES } from "@personal-wiki/domain";
import type { Hono } from "hono";
import { requireToken } from "../auth/middleware";
import type { AppEnv } from "../env";
import { MAX_REQUEST_BYTES, type WriteMetric } from "../pages/operations";
import { clientNameLookup } from "../pages/revision-history";
import { siteNameOf } from "../site-name";
import { PAGE_TOOLS } from "./page-tools";
import { SEARCH_TOOLS } from "./search-tools";
import type { WikiTool, WikiToolContext } from "./tool";

/**
 * MCP の server の識別子。クライアントが接続を区別する名前で、サイト名（利用者が決める表示名）とは
 * 別にして固定する。表示名は title に出す。
 */
const SERVER_NAME = "personal-wiki";

/** tools/list に出る順。tool を足すときはここに並べる。 */
const TOOLS: readonly WikiTool[] = [...SEARCH_TOOLS, ...PAGE_TOOLS];

/**
 * 接続中ずっとクライアントの文脈に載るので、tool をまたぐ規則だけを短く書く。tool 固有の規則は description に書く。
 * instructions を渡さない client もあるので、作るときに欠かせない規則（title の付け方）は create_page の description にも重ねる。
 */
const INSTRUCTIONS = [
  "オーナー一人の Markdown wiki。",
  "- 作業の始めに主題の語で search し、関連するページを read_page で読む。",
  "- 新しく作る前に search で同じ主題を探し、あれば作らずに追記か更新する。",
  "- メモや調べた結果は append_to_page で末尾に足す。update_page での本文全体の書き換えは構成を直すときだけ。",
  "- 作るページは draft。draft も URL を知っていれば誰でも読めるので、パスワード、API キー、トークン、個人情報などの秘密を書かない。",
  "- 公開範囲は tool から変えられない。公開はオーナーがブラウザで行うので、頼まれたらオーナーに伝える。frontmatter に書いても反映されない。",
  "- 本文の `[[title]]` は別のページへのリンク。参照元は list_backlinks（id か title で引く。まだ無いページの title でもよい）、最近の動きは list_recent で見る。",
  "- title を変えても、他のページの `[[旧 title]]` はすぐには書き換わらず、それまで新しい title の list_backlinks に出ない。update_page のあとに rewrite_links を remaining が 0 になるまで呼ぶと書き換わる。詳しくは update_page の説明にある。",
  "- title はページの主題を表す名詞句にし、日付、エージェント名、「メモ」などの接頭辞を付けない。作る前に search で近いページの title の付け方を見て合わせる。`[ ] | # ^` を含む title と `\\` で終わる title は `[[...]]` のリンクが壊れるので使わない。",
  "記法は Obsidian と同じで、違いは次のとおり。",
  "- 数式、脚注、Mermaid、HTML のタグ（`<br>` を含む）とコメント（`<!-- -->`）は専用の表示が無く、ほぼ書いた文字のまま見える。これらは使わない。",
  "- ブロックを指す embed（`![[page#^id]]`）は展開されず、リンクになる。",
  "- 別のページへのリンクは `[[title]]` で書く。`[x](Page.md)` のような Markdown 形式のリンクは外部の URL として扱われ、wiki のページには飛ばず、バックリンクにもならない。外部の URL へのリンク（`[x](https://...)`）は使える。",
  "- frontmatter のうちリンクと検索に効くのは `tags` だけ。リストで書く（`tags: a, b` は 1 つの値になり、tag として読めず落ちる）。エディタは `aliases` も別名として見せるが、`[[...]]` の解決にも search にも使わないので、リンクは title で書く。",
  "- `%%コメント%%` は表示で隠れるだけで、本文を読めば誰でも見える。",
  "- `![[...]]` で指せる添付は、アップロードで返った名前のものだけ。MCP からは添付を足せない。",
].join("\n");

/**
 * tool の登録は、登録のたびに SDK が inputSchema を処理するぶん CPU を使う。tools/call は呼ばれる
 * 1 件しか使わないので、calledTool が TOOLS にあれば、その 1 件だけを登録する。
 * 名前が TOOLS に無いときは全件登録し、「tool が無い」というレスポンスは SDK に任せて変えない。
 */
export function createWikiMcpServer(
  ctx: WikiToolContext,
  calledTool?: string,
  siteName: string = DEFAULT_SITE_NAME,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: siteName, version: "0.0.0" },
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
  siteName: string;
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

/** 許可する Origin のホスト名。空なので、Origin を付けたリクエストはすべて 403 になる */
const ALLOWED_ORIGIN_HOSTNAMES: string[] = [];

/**
 * `/mcp` に stateless な Streamable HTTP の MCP サーバーを置く。リクエストごとに McpServer を作り、
 * 認可で決まった principal を tool に閉じ込める。
 *
 * 宣言は 1 つの ALL の登録に requireToken("read") を付け、write の tool は tool の中で scope を見る
 * （tool.ts の defineTool）。SDK の handler は Origin も CORS も扱わないので、ここで決める。
 * - Origin の付いたリクエストは 403 にする。/mcp を使う正当なブラウザのクライアントは無く、ブラウザ経由の
 *   リクエスト（DNS rebinding を含む）だけが Origin を付ける。
 * - CORS のヘッダーは付けない。preflight は Authorization を持たず requireToken を通らない。
 * - JSON-RPC の batch（本文が配列）は 400 にする。2025-06-18 以降のプロトコルは batch を廃止しており、
 *   1 回の呼び出しで D1 のクエリ数と CPU 時間の上限を超えやすい。
 * GET と DELETE（セッションの操作）は SDK の stateless の経路が 405 で返す。
 */
export function registerMcpRoutes(app: Hono<AppEnv>, { now, recordWrite }: McpRoutesOptions) {
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const { context, calledTool, siteName } = scopeOf(authInfo);
      return createWikiMcpServer(context, calledTool, siteName);
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
    const origin = new URL(c.req.url).origin;
    const context: WikiToolContext = {
      db: c.env.DB,
      principal,
      origin,
      now,
      recordWrite,
      clientName: clientNameLookup(c.env, origin),
    };
    return handler.fetch(c.req.raw, {
      authInfo: {
        // 平文の token は認証のあと保持しない。SDK の型が要求するので空にする
        token: "",
        clientId: principal.kind === "token" ? principal.name : principal.kind,
        scopes: principal.kind === "token" ? [...principal.scopes] : [],
        extra: {
          [SCOPE_KEY]: {
            context,
            calledTool: calledToolName(parsedBody),
            siteName: siteNameOf(c.env),
          },
        },
      },
      ...(parsedBody === undefined ? {} : { parsedBody }),
    });
  });
}
