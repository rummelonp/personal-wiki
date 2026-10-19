import type { Hono } from "hono";
import { allowAnonymous } from "./auth/middleware";
import type { AppEnv, Bindings } from "./env";
import {
  findPageForPath,
  type PageMeta,
  ROOT_PAGE_LIST_LIMIT,
  rewritePageHtml,
  rewriteRootHtml,
} from "./page-html";
import { listPublicPages, type PublicPageEntry } from "./pages/search";
import { isWorkerPath } from "./paths";
import { withHtmlHeaders } from "./security-headers";
import { siteNameOf } from "./site-name";

// - html: HTML を明示して受け付ける（ブラウザのナビゲーション）
// - any: Accept が無いか */* だけ。リンクプレビューのクローラーがこの形で来る
// - other: それ以外（fetch の application/json、他の型と */* を並べた画像の Accept など）
type AcceptKind = "html" | "any" | "other";

function acceptKindOf(accept: string | undefined): AcceptKind {
  if (accept === undefined || accept.replace(/\s/g, "") === "*/*") return "any";
  return accept.toLowerCase().includes("text/html") ? "html" : "other";
}

type Lookup<T> = { ok: true; value: T } | { ok: false };

/** 拒否を先に受け止めておく。ASSETS の取得が例外で抜けても、D1 の失敗が未処理の拒否として残らない */
function settle<T>(promise: Promise<T>, event: string): Promise<Lookup<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => {
      console.error(JSON.stringify({ event, error: String(error) }));
      return { ok: false };
    },
  );
}

function unavailable(index: Response): Response {
  const res = withHtmlHeaders(new Response(index.body, { status: 503, headers: index.headers }));
  res.headers.set("Cache-Control", "no-store");
  res.headers.delete("ETag");
  return res;
}

/**
 * クエリの無い `/` の index.html に、public のページの一覧を差し込む。クエリ付きの `/?tag=` などは絞り込みの
 * 画面で、絞らない一覧を入れると読み手が中身を取り違えるので、ASSETS の index.html をそのまま返す。
 * Accept では分けない。一覧を読ませたい AI のエージェントやクローラーは、Accept が無いか任意の型だけのことがある。
 * 応答の本文は D1 の中身で変わり、index.html の ETag では同じ応答かを表せない。そのため index.html は
 * 条件付きリクエストのヘッダーを付けずに取り、ETag を外して返す。ASSETS の 304 を通すと、一覧の古い応答が使われ続ける。
 */
async function rootHtml(env: Bindings, url: URL): Promise<Response> {
  const lookup = settle<PublicPageEntry[]>(
    listPublicPages(env.DB, { limit: ROOT_PAGE_LIST_LIMIT }),
    "spa.root_list_failed",
  );
  const index = await env.ASSETS.fetch(new URL("/", url));
  if (!index.ok) return withHtmlHeaders(index);
  const result = await lookup;
  if (!result.ok) return unavailable(index);
  const res = withHtmlHeaders(
    rewriteRootHtml(index, { siteName: siteNameOf(env), pages: result.value, origin: url.origin }),
    { indexable: true },
  );
  res.headers.delete("ETag");
  res.headers.delete("Content-Length");
  return res;
}

/**
 * Static Assets のファイルと、SPA の index.html を返す catch-all。他のルートより後ろに登録する。
 *
 * wrangler.jsonc の run_worker_first で `/assets/*` 以外は Worker が先に受ける。
 * 1. Worker のパス（paths.ts）はレスポンスを作らずに next() へ回す。後から登録した API のルートも隠さず、
 *    何もレスポンスを返さなければ notFound の JSON の 404 になる
 * 2. クエリの無い `/` は、public のページの一覧を差し込んだ index.html を返す（rootHtml）
 * 3. ASSETS に実際のファイル（`apps/web/public` のうち run_worker_first から除いていないもの）があれば
 *    それを返す。クエリ付きの `/` もここで ASSETS が index.html を返すので、4 には来ない
 * 4. 無ければ、HTML を受け付けるナビゲーションにだけ index.html を返す。fetch や画像の読み込みに
 *    200 の HTML を返すと、呼び出し元が中身を取り違えるので、それ以外は JSON の 404 にする。
 *    例外として、Accept が無いか任意の型だけ（acceptKindOf の any）のリクエストには、読めるページがあるときに
 *    限って HTML を返す（リンクプレビューのクローラー向け）。ページが無ければ JSON の 404 のままにする
 *
 * index.html は `/` で取る。`/index.html` を取ると Static Assets の既定の html_handling が `/` への
 * 307 を返すため。
 *
 * 4 の index.html は、ページの URL ならメタ情報を差し込み、ページが無ければ 404 にする（page-html.ts）。
 * - 404 は書き換えずに返す。匿名から見た draft の title と存在しない title を、ステータス、ヘッダー、
 *   本文のどれでも区別させないため。draft の title で引けたかどうかで分岐する処理をここに足さない
 * - noindex を外すのは、トップと public のページだけ。draft は id で開けても検索エンジンに載せない
 * - draft の HTML は title と抜粋を含むので、id で取った draft の JSON と同じく no-store にする
 * - 書き換えたレスポンスと 404 は index.html と中身が違うので、ASSETS の ETag と Content-Length を外す
 * - D1 の検索が失敗したら、書き換えない index.html を 503 で返す。500 にすると SPA が起動できず、
 *   200 にするとメタ情報の無いページがインデックスに載る。2 の一覧の失敗も 503 にする。一覧の無い 200 だと、
 *   JS を実行しない読み手は public のページが 1 つも無いと読み、検索エンジンもその版を覚える
 */
export function registerSpaRoutes(app: Hono<AppEnv>) {
  return app.get("*", allowAnonymous(), async (c, next) => {
    if (isWorkerPath(c.req.path)) return next();
    const url = new URL(c.req.url);
    if (url.pathname === "/" && url.search === "") return rootHtml(c.env, url);
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    if (asset.status !== 404) return withHtmlHeaders(asset);
    await asset.body?.cancel();
    const accept = acceptKindOf(c.req.header("Accept"));
    if (accept === "other") return next();

    const lookup = settle<PageMeta | null>(
      findPageForPath(c.env.DB, url.pathname, c.get("principal")),
      "spa.page_lookup_failed",
    );
    const index = await c.env.ASSETS.fetch(new URL("/", url));
    if (!index.ok) return withHtmlHeaders(index);
    const result = await lookup;

    if (!result.ok) return unavailable(index);
    const page = result.value;
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
