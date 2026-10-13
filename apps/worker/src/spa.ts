import type { Hono } from "hono";
import { allowAnonymous } from "./auth/middleware";
import type { AppEnv } from "./env";

/**
 * Worker が受け持つパスの接頭辞。ここに入るパスは SPA の HTML を返さず、後ろのルートか
 * JSON の 404 に回す。未定義の API を呼んだクライアントが 200 の HTML を受け取って誤解しないため。
 */
const RESERVED_PREFIXES = ["/api", "/mcp", "/_auth"];

function isReservedPath(pathname: string): boolean {
  return RESERVED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * HTML へのナビゲーションに SPA の index.html を返す catch-all。他のルートより後ろに登録する。
 * 予約した接頭辞では応答を作らずに next() へ回すので、後から登録した API のルートも隠さない
 * （何も応答しなければ notFound の JSON の 404 になる）。
 *
 * wrangler.jsonc の run_worker_first で `/assets/*` 以外は Worker が先に受けるので、ここで
 * ASSETS から index.html を取る。`/index.html` を取ると Static Assets の既定の html_handling が
 * `/` への 307 を返すので、`/` を取る。ASSETS の応答のヘッダーは変更できないので、後段の
 * middleware（Vary などを足す）のために複製して返す。
 */
export function registerSpaRoutes(app: Hono<AppEnv>) {
  return app.get("*", allowAnonymous(), async (c, next) => {
    if (isReservedPath(c.req.path)) return next();
    const res = await c.env.ASSETS.fetch(new URL("/", c.req.url));
    return new Response(res.body, res);
  });
}
