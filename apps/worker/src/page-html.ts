import { normalizeTitleKey, parsePagePath } from "@personal-wiki/domain";
import { type Principal, readableVisibilityOf } from "./auth/principal";
import { publicOnlyFlag, type Visibility } from "./pages/store";
import { pageUrls } from "./pages/urls";

/** SPA の index.html に差し込むページのメタ情報。本文は読まない。 */
export interface PageMeta {
  id: string;
  title: string;
  visibility: Visibility;
  /** page_excerpts の行が無いページは null、本文が空なら空文字列 */
  excerpt: string | null;
}

const META_COLUMNS = "p.id, p.title, p.visibility, e.excerpt";
const META_FROM = "pages AS p LEFT JOIN page_excerpts AS e ON e.page_id = p.id";

/**
 * ページの URL（`/p/<id>` か `/<title>`）のパスから、principal が読めるページを引く。D1 は多くて 1 回引く。
 * 見つからなければ null で、ページが無い、匿名から見た draft の title、ページの URL の形でないパスを区別しない。
 * title の解決は findPageByTitle と同じ条件で、principal が draft を読めなければ draft を返さない。
 * id の解決は visibility で絞らない（draft は id を知っていれば読める）。
 *
 * パスは c.req.path ではなく生の pathname を parsePagePath に渡す（SPA のルーティングと同じ関数）。
 * c.req.path は `%2F` などを残す decodeURI 相当で、title に `/` を含むページの URL を引けないため。
 * 予約語の segment（`/P/...` や `/API` など、大文字小文字を畳むと予約語になるもの）は D1 を引かない。
 */
export async function findPageForPath(
  db: D1Database,
  pathname: string,
  principal: Principal,
): Promise<PageMeta | null> {
  const path = parsePagePath(pathname);
  if (path === null) return null;
  if (path.kind === "id") {
    return db
      .prepare(`SELECT ${META_COLUMNS} FROM ${META_FROM} WHERE p.id = ?1 AND p.deleted_at IS NULL`)
      .bind(path.id)
      .first<PageMeta>();
  }

  const key = normalizeTitleKey(path.title);
  if (!key.ok) return null;
  return db
    .prepare(
      `SELECT ${META_COLUMNS} FROM ${META_FROM}
       WHERE p.title_key = ?1 AND p.deleted_at IS NULL AND (?2 = 0 OR p.visibility = 'public')`,
    )
    .bind(key.value, publicOnlyFlag(readableVisibilityOf(principal)))
    .first<PageMeta>();
}

/**
 * setAttribute は属性値の `"` だけを文字参照にし、`&` をそのまま出す。`&amp;` や `&lt;` を含む
 * title が、読む側で `&` や `<` に化けないよう、`&` だけは先に文字参照にしてから渡す。
 */
function attributeValue(value: string): string {
  return value.replaceAll("&", "&amp;");
}

/**
 * index.html の head にページのメタ情報を差し込む。
 *
 * HTMLRewriter は自分で挿入したマークアップを解析し直さないので、2 段に分ける。1 段目は値を持たない
 * 固定のタグだけを挿入し、2 段目がそのタグに setAttribute で値を入れる。ページの title や抜粋を
 * HTML の文字列に連結せず、エスケープを HTMLRewriter に任せるため（`&` だけは attributeValue）。
 * og:image は既定の画像を持たないので出さない。
 */
export function rewritePageHtml(index: Response, page: PageMeta, origin: string): Response {
  const urls = pageUrls(origin, page);
  const canonical = urls.titleUrl ?? urls.url;
  const description = page.excerpt === null || page.excerpt === "" ? null : page.excerpt;

  const tags = [
    '<meta property="og:title">',
    '<meta property="og:type" content="article">',
    '<meta property="og:url">',
    '<link rel="canonical">',
    '<meta name="twitter:card" content="summary">',
  ];
  if (description !== null) tags.push('<meta property="og:description">');
  if (page.visibility === "draft") tags.push('<meta name="robots" content="noindex">');

  const structure = new HTMLRewriter()
    .on("head", {
      element(element) {
        element.append(tags.join(""), { html: true });
      },
    })
    .on("title", {
      element(element) {
        element.prepend(`${page.title} - `);
      },
    });
  const values = new HTMLRewriter()
    .on('meta[property="og:title"]', {
      element(element) {
        element.setAttribute("content", attributeValue(page.title));
      },
    })
    .on('meta[property="og:url"]', {
      element(element) {
        element.setAttribute("content", attributeValue(canonical));
      },
    })
    .on('link[rel="canonical"]', {
      element(element) {
        element.setAttribute("href", attributeValue(canonical));
      },
    });
  if (description !== null) {
    values.on('meta[property="og:description"]', {
      element(element) {
        element.setAttribute("content", attributeValue(description));
      },
    });
  }
  return values.transform(structure.transform(index));
}
