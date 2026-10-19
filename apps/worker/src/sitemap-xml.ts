import type { Hono } from "hono";
import { allowAnonymous } from "./auth/middleware";
import type { AppEnv } from "./env";
import { listPublicPages, type PublicPageEntry } from "./pages/search";
import { publicPageUrl } from "./pages/urls";

export const SITEMAP_XML_PATH = "/sitemap.xml";

/**
 * 1 ファイルに入れる URL の上限（sitemaps.org の 1 ファイルの上限）。sitemap index は作らず、超えた分は
 * 更新日時の古いページから出さない。sitemaps.org の非圧縮 50MB の上限より先に、XML を組み立てる CPU 時間
 * （Free の 10ms）が効き、数千件で超えうる。超えると一部でなく sitemap 全体が返らない。D1 は取得ごとに
 * 全ページの行を読む。
 */
export const SITEMAP_URL_LIMIT = 50_000;

const SITEMAP_XML_HEADERS = {
  "Content-Type": "application/xml; charset=utf-8",
  "X-Robots-Tag": "noindex",
};

const XML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => XML_ENTITIES[c] ?? c);
}

/** UNIX エポックのミリ秒を、W3C Datetime の秒までの UTC の形にする。 */
function w3cDatetime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * sitemap.xml の本文。各ページの正規の URL と、updated_at を lastmod に入れる。
 * public のページが無ければ空の `<urlset>` を返す。sitemaps.org の XSD は `<url>` を 1 つ以上求めるが、
 * 404 や 503 にすると、ルートが無いことや D1 の失敗と読み手が区別できない。
 * `<loc>` は 2,048 文字未満と定められているが、長い title（MAX_TITLE_BYTES の percent-encoding）の URL は
 * それを超えうる。超えた URL は検索エンジンが読み飛ばしうるが、ほかのページの読み取りは妨げないので、
 * 除かずに出す。
 */
export function renderSitemapXml({
  pages,
  origin,
}: {
  pages: PublicPageEntry[];
  origin: string;
}): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const page of pages) {
    const loc = escapeXml(publicPageUrl(origin, page));
    lines.push(`<url><loc>${loc}</loc><lastmod>${w3cDatetime(page.updatedAt)}</lastmod></url>`);
  }
  lines.push("</urlset>", "");
  return lines.join("\n");
}

/**
 * `/sitemap.xml` を返す。キャッシュ、クエリ、D1 の失敗の扱いは `/llms.txt`（llms-txt.ts）と同じにする。
 * - principal で中身を変えない。owner や token が取っても draft は入れない（listPublicPages）
 * - Cache-Control を付けず、匿名にも no-store を付けさせる。draft に戻したページを次の取得で消すため
 * - D1 の失敗は 503 にする。空の `<urlset>` の 200 だと、検索エンジンは public のページが 1 つも無い
 *   sitemap を受け取る。本文は XML でないので text/plain にする
 * - X-Robots-Tag: noindex を付ける。sitemap は巡回の入口で、検索の結果に載せるものではない
 */
export function registerSitemapXmlRoutes(app: Hono<AppEnv>) {
  return app.get(SITEMAP_XML_PATH, allowAnonymous(), async (c) => {
    let pages: PublicPageEntry[];
    try {
      pages = await listPublicPages(c.env.DB, { limit: SITEMAP_URL_LIMIT });
    } catch (error) {
      console.error(JSON.stringify({ event: "sitemap_xml.list_failed", error: String(error) }));
      return c.body("Service Unavailable\n", 503, {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Robots-Tag": "noindex",
      });
    }
    const body = renderSitemapXml({ pages, origin: new URL(c.req.url).origin });
    return c.body(body, 200, SITEMAP_XML_HEADERS);
  });
}
