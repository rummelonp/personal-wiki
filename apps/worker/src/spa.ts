import type { Hono } from "hono";
import { allowAnonymous } from "./auth/middleware";
import type { AppEnv } from "./env";
import { findPageForPath, type PageMeta, rewritePageHtml } from "./page-html";
import { isWorkerPath } from "./paths";
import { withHtmlHeaders } from "./security-headers";

// - html: HTML を明示して受け付ける（ブラウザのナビゲーション）
// - any: Accept が無いか */* だけ。リンクプレビューのクローラーがこの形で来る
// - other: それ以外（fetch の application/json、他の型と */* を並べた画像の Accept など）
type AcceptKind = "html" | "any" | "other";

function acceptKindOf(accept: string | undefined): AcceptKind {
  if (accept === undefined || accept.replace(/\s/g, "") === "*/*") return "any";
  return accept.toLowerCase().includes("text/html") ? "html" : "other";
}

type PageLookup = { ok: true; page: PageMeta | null } | { ok: false };

/**
 * Static Assets のファイルと、SPA の index.html を返す catch-all。他のルートより後ろに登録する。
 *
 * wrangler.jsonc の run_worker_first で `/assets/*` 以外は Worker が先に受ける。
 * 1. Worker のパス（paths.ts）はレスポンスを作らずに next() へ回す。後から登録した API のルートも隠さず、
 *    何もレスポンスを返さなければ notFound の JSON の 404 になる
 * 2. ASSETS に実際のファイル（`apps/web/public` の favicon など）があればそれを返す。`/` もここで
 *    ASSETS が index.html を返すので、3 には来ない
 * 3. 無ければ、HTML を受け付けるナビゲーションにだけ index.html を返す。fetch や画像の読み込みに
 *    200 の HTML を返すと、呼び出し元が中身を取り違えるので、それ以外は JSON の 404 にする。
 *    例外として、Accept が無いか任意の型だけ（acceptKindOf の any）のリクエストには、読めるページがあるときに
 *    限って HTML を返す（リンクプレビューのクローラー向け）。ページが無ければ JSON の 404 のままにする
 *
 * index.html は `/` で取る。`/index.html` を取ると Static Assets の既定の html_handling が `/` への
 * 307 を返すため。
 *
 * 3 の index.html は、ページの URL ならメタ情報を差し込み、ページが無ければ 404 にする（page-html.ts）。
 * - 404 は書き換えずに返す。匿名から見た draft の title と存在しない title を、ステータス、ヘッダー、
 *   本文のどれでも区別させないため。draft の title で引けたかどうかで分岐する処理をここに足さない
 * - noindex を外すのは、トップと public のページだけ。draft は id で開けても検索エンジンに載せない
 * - draft の HTML は title と抜粋を含むので、id で取った draft の JSON と同じく no-store にする
 * - 書き換えたレスポンスと 404 は index.html と中身が違うので、ASSETS の ETag と Content-Length を外す
 * - D1 の検索が失敗したら、書き換えない index.html を 503 で返す。500 にすると SPA が起動できず、
 *   200 にするとメタ情報の無いページがインデックスに載る
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
    const accept = acceptKindOf(c.req.header("Accept"));
    if (accept === "other") return next();

    // 拒否を先に受け止めておく。ASSETS の取得が例外で抜けても、D1 の失敗が未処理の拒否として残らない
    const lookup: Promise<PageLookup> = findPageForPath(
      c.env.DB,
      url.pathname,
      c.get("principal"),
    ).then(
      (page) => ({ ok: true, page }),
      (error: unknown) => {
        console.error(JSON.stringify({ event: "spa.page_lookup_failed", error: String(error) }));
        return { ok: false };
      },
    );
    const index = await c.env.ASSETS.fetch(new URL("/", url));
    if (!index.ok) return withHtmlHeaders(index);
    const result = await lookup;

    if (!result.ok) {
      const res = withHtmlHeaders(
        new Response(index.body, { status: 503, headers: index.headers }),
      );
      res.headers.set("Cache-Control", "no-store");
      res.headers.delete("ETag");
      return res;
    }
    const { page } = result;
    if (page === null) {
      if (accept === "any") {
        await index.body?.cancel();
        return next();
      }
      const res = withHtmlHeaders(
        new Response(index.body, { status: 404, headers: index.headers }),
      );
      res.headers.delete("ETag");
      return res;
    }
    const res = withHtmlHeaders(rewritePageHtml(index, page, url.origin), {
      indexable: page.visibility === "public",
    });
    res.headers.delete("ETag");
    res.headers.delete("Content-Length");
    if (page.visibility === "draft") res.headers.set("Cache-Control", "no-store");
    return res;
  });
}
