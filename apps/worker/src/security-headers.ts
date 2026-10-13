import { createMiddleware } from "hono/factory";
import { defineBaseMiddleware } from "./auth/middleware";
import type { AppEnv } from "./env";

/**
 * すべての応答に付けるヘッダー。早期に返す 400 や 404 にも効かせるため、最初に登録する。
 * Referrer-Policy は、ページの URL（title を含む）を外部のリンク先へ送らないため。
 */
export const securityHeaders = defineBaseMiddleware(
  createMiddleware<AppEnv>(async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
  }),
);

/**
 * SPA の HTML に付ける CSP。vite のビルドは inline の script を出さないので script-src は 'self' だけにする。
 * style-src の 'unsafe-inline' は、編集画面のエディタ（CodeMirror）が実行時に style 要素を差し込むため。
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

/**
 * HTML の応答に CSP などを付けて返す。引数の Response のヘッダーは変更できないことがある
 * （ASSETS の応答）ので、複製してから付ける。
 * - Cache-Control: no-cache は、デプロイ後に古い index.html が古いハッシュの JS を指し続けないため。
 *   owner の応答は resolvePrincipal が後から private, no-store に上書きする
 * - X-Robots-Tag: noindex は、匿名の閲覧を開くまで検索エンジンに載せないため
 */
export function withHtmlHeaders(res: Response): Response {
  const copy = new Response(res.body, res);
  if (copy.headers.get("Content-Type")?.toLowerCase().startsWith("text/html")) {
    copy.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    copy.headers.set("Cache-Control", "no-cache");
    copy.headers.set("X-Robots-Tag", "noindex");
  }
  return copy;
}
