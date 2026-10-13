import type { Hono } from "hono";
import { allowAnonymous } from "./auth/middleware";
import type { AppEnv } from "./env";
import { resolveHtmlTarget, rewritePageHtml } from "./page-html";
import { isWorkerPath } from "./paths";
import { withHtmlHeaders } from "./security-headers";

function acceptsHtml(accept: string | undefined): boolean {
  return accept?.toLowerCase().includes("text/html") ?? false;
}

/**
 * Static Assets のファイルと、SPA の index.html を返す catch-all。他のルートより後ろに登録する。
 *
 * wrangler.jsonc の run_worker_first で `/assets/*` 以外は Worker が先に受ける。
 * 1. Worker のパス（paths.ts）は応答を作らずに next() へ回す。後から登録した API のルートも隠さず、
 *    何も応答しなければ notFound の JSON の 404 になる
 * 2. ASSETS に実際のファイル（`apps/web/public` の favicon など）があればそれを返す
 * 3. 無ければ、HTML を受け付けるナビゲーションにだけ index.html を返す。fetch や画像の読み込みに
 *    200 の HTML を返すと、呼び出し元が中身を取り違えるので、それ以外は JSON の 404 にする
 *
 * index.html は `/` で取る。`/index.html` を取ると Static Assets の既定の html_handling が `/` への
 * 307 を返すため。`/` そのものは 2 で ASSETS が index.html を返す。
 *
 * 3 の index.html は、ページの URL ならメタ情報を差し込み、ページが無ければ 404 にする（page-html.ts）。
 * - 404 は書き換えずに返す。匿名から見た draft の title と存在しない title を、ステータス、ヘッダー、
 *   本文のどれでも区別させないため。draft の title で引けたかどうかで分岐する処理をここに足さない
 * - noindex を外すのは、トップと public のページだけ。draft は id で開けても検索エンジンに載せない
 * - draft の Referrer-Policy: no-referrer は、本文の外部リンクを踏んだときに `/p/<id>` を送らないため
 * - draft の HTML は title と抜粋を含むので、id で取った draft の JSON と同じく no-store にする
 * - 書き換えた応答と 404 は index.html と中身が違うので、ASSETS の ETag を外す
 */
export function registerSpaRoutes(app: Hono<AppEnv>) {
  return app.get("*", allowAnonymous(), async (c, next) => {
    if (isWorkerPath(c.req.path)) return next();
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    const url = new URL(c.req.url);
    if (asset.status !== 404) {
      return withHtmlHeaders(asset, { indexable: url.pathname === "/" && url.search === "" });
    }
    await asset.body?.cancel();
    if (!acceptsHtml(c.req.header("Accept"))) return next();

    const [target, index] = await Promise.all([
      resolveHtmlTarget(c.env.DB, url, c.get("principal")),
      c.env.ASSETS.fetch(new URL("/", url)),
    ]);
    if (!index.ok || target.kind === "home") return withHtmlHeaders(index);
    if (target.kind === "notFound") {
      const res = withHtmlHeaders(
        new Response(index.body, { status: 404, headers: index.headers }),
      );
      res.headers.delete("ETag");
      return res;
    }
    const { page } = target;
    const res = withHtmlHeaders(rewritePageHtml(index, page, url.origin), {
      indexable: page.visibility === "public",
    });
    res.headers.delete("ETag");
    if (page.visibility === "draft") {
      res.headers.set("Referrer-Policy", "no-referrer");
      res.headers.set("Cache-Control", "no-store");
    }
    return res;
  });
}
