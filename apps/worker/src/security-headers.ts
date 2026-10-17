import { createMiddleware } from "hono/factory";
import { defineBaseMiddleware } from "./auth/middleware";
import type { AppEnv } from "./env";

/**
 * すべてのレスポンスに付けるヘッダー。早期に返す 400 や 404 にも効かせるため、最初に登録する。
 * - Referrer-Policy は、ページの URL（title を含む）を外部のリンク先へ送らないため
 * - `/api/*` の X-Robots-Tag: noindex は、匿名で読める JSON（ページの本文や一覧）を検索エンジンに
 *   載せないため。HTML の noindex は withHtmlHeaders が別に付ける
 * - `/api/*` の JSON の Cross-Origin-Resource-Policy: same-origin は、owner のレスポンスを別の origin が
 *   no-cors で取り込む経路を塞ぐため。cross-site では SameSite=Lax で cookie が送られないので、
 *   防ぐのは同じ site の別 origin からの取り込みと、Spectre 系の読み取り。添付の画像は JSON ではないので
 *   対象にしない。owner と token に返す画像には attachments/routes.ts が付ける
 */
export const securityHeaders = defineBaseMiddleware(
  createMiddleware<AppEnv>(async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    if (c.req.path.startsWith("/api/")) {
      c.header("X-Robots-Tag", "noindex");
      if (c.res.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
        c.header("Cross-Origin-Resource-Policy", "same-origin");
      }
    }
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
 * HTML のレスポンスに CSP などを付けて返す。引数の Response のヘッダーは変更できないことがある
 * （ASSETS や HTMLRewriter のレスポンス）ので、複製してから付ける。
 * - Cache-Control: no-cache は、デプロイ後に古い index.html が古いハッシュの JS を指し続けないため。
 *   ページの URL の HTML は principal で中身が変わるが、Vary: Authorization, Cookie と毎回の再検証で
 *   足りる。owner と token のレスポンスは resolvePrincipal が後から private, no-store に上書きする
 * - X-Robots-Tag: noindex は、indexable を指定したレスポンス（トップと public のページ。spa.ts）にだけ付けない。
 *   未知のパスや 404 まで検索エンジンに載せないよう、既定は付ける側に倒す
 */
export function withHtmlHeaders(
  res: Response,
  { indexable = false }: { indexable?: boolean } = {},
): Response {
  const copy = new Response(res.body, res);
  if (copy.headers.get("Content-Type")?.toLowerCase().startsWith("text/html")) {
    copy.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    copy.headers.set("Cache-Control", "no-cache");
    if (indexable) copy.headers.delete("X-Robots-Tag");
    else copy.headers.set("X-Robots-Tag", "noindex");
  }
  return copy;
}
