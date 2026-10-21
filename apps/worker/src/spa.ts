import type { Hono } from "hono";
import { allowAnonymous } from "./auth/middleware";
import type { Principal } from "./auth/principal";
import type { AppEnv, Bindings } from "./env";
import {
  findPageForPath,
  PAGE_LINK_LIST_LIMIT,
  type PageMeta,
  ROOT_PAGE_LIST_LIMIT,
  rewritePageHtml,
  rewriteRootHtml,
} from "./page-html";
import { type LinkTarget, listPublicLinkTargets } from "./pages/link-targets";
import { listPublicPages, type PublicPageEntry } from "./pages/search";
import { isWorkerPath } from "./paths";
import { withHtmlHeaders } from "./security-headers";
import { siteDescriptionOf, siteNameOf } from "./site-name";

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
 * クエリの無い `/` の index.html に、public のページの一覧とリンクのプレビュー用のメタ情報を差し込む。
 * クエリ付きの `/?tag=` などは絞り込みの画面で、絞らない一覧を入れると読み手が中身を取り違えるので、
 * ASSETS の index.html をそのまま返す（og:url や canonical も付けず、ETag と 304 も ASSETS のままにする）。
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
    rewriteRootHtml(index, {
      siteName: siteNameOf(env),
      description: siteDescriptionOf(env),
      pages: result.value,
      origin: url.origin,
    }),
    { indexable: true },
  );
  res.headers.delete("ETag");
  res.headers.delete("Content-Length");
  return res;
}

/**
 * パスのページと、public ならその本文がリンクする public のページを引く。リンク先はページの行の id で引くので、
 * 2 回の読み取りは順に行う。本文を入れない draft と、見つからないページでは 2 回目を引かない。
 * 失敗はログに残して Lookup で返す。ログのイベント名を読み取りごとに分け、503 の原因がどちらかを見分けられるようにする。
 */
async function findPageWithLinks(
  db: D1Database,
  pathname: string,
  principal: Principal,
): Promise<Lookup<{ page: PageMeta; links: LinkTarget[] } | null>> {
  const found = await settle(findPageForPath(db, pathname, principal), "spa.page_row_failed");
  if (!found.ok) return found;
  const page = found.value;
  if (page === null) return { ok: true, value: null };
  if (page.visibility !== "public") return { ok: true, value: { page, links: [] } };
  const links = await settle(
    listPublicLinkTargets(db, page.id, { limit: PAGE_LINK_LIST_LIMIT }),
    "spa.page_links_failed",
  );
  if (!links.ok) return links;
  return { ok: true, value: { page, links: links.value } };
}

/**
 * Static Assets のファイルと、SPA の index.html を返す catch-all。他のルートより後ろに登録する。
 *
 * wrangler.jsonc の run_worker_first で `/assets/*` 以外は Worker が先に受ける。
 * 1. Worker のパス（paths.ts）はレスポンスを作らずに next() へ回す。後から登録した API のルートも隠さず、
 *    何もレスポンスを返さなければ notFound の JSON の 404 になる
 * 2. クエリの無い `/` は、public のページの一覧とリンクのプレビュー用のメタ情報を差し込んだ index.html を返す（rootHtml）
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
 * - 404 は書き換えずに返す。匿名から見た draft の id と title を、存在しない id と title と、ステータス、
 *   ヘッダー、本文のどれでも区別させないため。draft で引けたかどうかで分岐する処理をここに足さない
 * - noindex を外すのは、トップと public のページだけ。draft の HTML を受け取るのは draft を読める owner と
 *   token だけで、その応答は resolvePrincipal が private, no-store にするが、写しが出回っても索引に載せない
 * - 書き換えたレスポンスと 404 は index.html と中身が違うので、ASSETS の ETag と Content-Length を外す
 * - D1 の検索が失敗したら、書き換えない index.html を 503 で返す。500 にすると SPA が起動できず、
 *   200 にするとメタ情報の無いページがインデックスに載る。2 の一覧の失敗も 503 にする。一覧の無い 200 だと、
 *   JS を実行しない読み手は public のページが 1 つも無いと読み、検索エンジンもその版を覚える。
 *   ページのリンク先の失敗も 503 にする。一覧の無い 200 だと、索引がリンクの欠けた版を覚え、リンク先を
 *   見つけ直すのが次の巡回まで遅れる。D1 の失敗はページの行の読み取りと同時に起きやすいので、本文まで
 *   503 にしても失うものは小さい
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

    const lookup = findPageWithLinks(c.env.DB, url.pathname, c.get("principal"));
    const index = await c.env.ASSETS.fetch(new URL("/", url));
    if (!index.ok) return withHtmlHeaders(index);
    const result = await lookup;

    if (!result.ok) return unavailable(index);
    if (result.value === null) {
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
    const { page, links } = result.value;
    const res = withHtmlHeaders(rewritePageHtml(index, page, url.origin, links), {
      indexable: page.visibility === "public",
    });
    res.headers.delete("ETag");
    res.headers.delete("Content-Length");
    return res;
  });
}
