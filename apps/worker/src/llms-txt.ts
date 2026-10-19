import { markdownLink } from "@personal-wiki/markdown";
import type { Hono } from "hono";
import { allowAnonymous } from "./auth/middleware";
import type { AppEnv } from "./env";
import { ROOT_PAGE_LIST_LIMIT } from "./page-html";
import { listPublicPages, type PublicPageEntry } from "./pages/search";
import { publicPageUrl } from "./pages/urls";
import { siteDescriptionOf, siteNameOf } from "./site-name";
import { SITEMAP_XML_PATH } from "./sitemap-xml";

export const LLMS_TXT_PATH = "/llms.txt";

const LLMS_TXT_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "X-Robots-Tag": "noindex",
};

/**
 * llms.txt（llmstxt.org）の本文。H1 にサイト名、説明文があれば blockquote、`## Pages` の下に public の
 * ページへのリンクを並べる。サイト名と説明文は deploy の検査を通った 1 行の設定値で、owner が Markdown を
 * 書けるよう escape しない。
 * `## Pages` は ROOT_PAGE_LIST_LIMIT で切るので、続く `## Optional` に sitemap.xml へのリンクを置き、残りの
 * ページへもたどらせる。llmstxt.org で `Optional` は、短い文脈で足りるなら読み飛ばしてよい節である。
 * public のページが無ければ、sitemap.xml も空なので、どちらの節も出さない。
 */
export function renderLlmsTxt({
  siteName,
  description,
  pages,
  origin,
}: {
  siteName: string;
  description: string | null;
  pages: PublicPageEntry[];
  origin: string;
}): string {
  const lines = [`# ${siteName}`, ""];
  if (description !== null) lines.push(`> ${description}`, "");
  if (pages.length > 0) {
    lines.push("## Pages", "");
    for (const page of pages) {
      lines.push(`- ${markdownLink(page.title, publicPageUrl(origin, page))}`);
    }
    lines.push("", "## Optional", "");
    lines.push(
      `- ${markdownLink("sitemap.xml", `${origin}${SITEMAP_XML_PATH}`)}: all public pages with their last-modified times`,
      "",
    );
  }
  return lines.join("\n");
}

/**
 * `/llms.txt` を返す。一覧はトップの HTML（spa.ts の rootHtml）と同じ引き方、同じ件数にする。
 * - principal で中身を変えない。owner や token が取っても draft は入れない（listPublicPages）
 * - Content-Type は text/plain にする。llmstxt.org の書式は Markdown だが、ブラウザで開いたときに
 *   ダウンロードにせずその場で読めることを優先する
 * - クエリは見ない。トップの `/?tag=` のような絞り込みの意味を持たないので、同じ本文を返す
 * - Cache-Control を付けず、resolvePrincipal に匿名でも no-store を付けさせる。draft に戻したページを
 *   次の取得で一覧から消すため。HTML の no-cache は古い JS のハッシュを指させないためのもので、ここには当たらない
 * - D1 の失敗は 503 にする。空の一覧の 200 だと、読み手は public のページが 1 つも無いと受け取る
 * - X-Robots-Tag: noindex を付ける。中身はトップの HTML の一覧と同じで、検索の結果からは各ページの
 *   HTML に入らせる
 */
export function registerLlmsTxtRoutes(app: Hono<AppEnv>) {
  return app.get(LLMS_TXT_PATH, allowAnonymous(), async (c) => {
    let pages: PublicPageEntry[];
    try {
      pages = await listPublicPages(c.env.DB, { limit: ROOT_PAGE_LIST_LIMIT });
    } catch (error) {
      console.error(JSON.stringify({ event: "llms_txt.list_failed", error: String(error) }));
      return c.body("Service Unavailable\n", 503, LLMS_TXT_HEADERS);
    }
    const body = renderLlmsTxt({
      siteName: siteNameOf(c.env),
      description: siteDescriptionOf(c.env),
      pages,
      origin: new URL(c.req.url).origin,
    });
    return c.body(body, 200, LLMS_TXT_HEADERS);
  });
}
