import type { Hono } from "hono";
import { allowAnonymous } from "./auth/middleware";
import type { AppEnv } from "./env";
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
 * 307 を返すため。
 */
export function registerSpaRoutes(app: Hono<AppEnv>) {
  return app.get("*", allowAnonymous(), async (c, next) => {
    if (isWorkerPath(c.req.path)) return next();
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    if (asset.status !== 404) return withHtmlHeaders(asset);
    await asset.body?.cancel();
    if (!acceptsHtml(c.req.header("Accept"))) return next();
    return withHtmlHeaders(await c.env.ASSETS.fetch(new URL("/", c.req.url)));
  });
}
