import { INITIAL_PAGE_ELEMENT_ID, normalizeTitleKey, parsePagePath } from "@personal-wiki/domain";
import { type Principal, readableVisibilityOf } from "./auth/principal";
import type { LinkTarget } from "./pages/link-targets";
import { pageJson } from "./pages/page-json";
import type { PublicPageEntry } from "./pages/search";
import { publicOnlyFlag, type Visibility } from "./pages/store";
import { pageUrls, publicPageUrl } from "./pages/urls";
import { SITEMAP_XML_PATH } from "./sitemap-xml";

/** SPA の index.html に差し込むページのメタ情報と本文。 */
export interface PageMeta {
  id: string;
  title: string;
  visibility: Visibility;
  /** page_excerpts の行が無いページは null、本文が空なら空文字列 */
  excerpt: string | null;
  /** public のページの本文（Markdown）。draft は D1 から読まずに null にする */
  body: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

const META_COLUMNS =
  "p.id, p.title, p.visibility, e.excerpt, CASE WHEN p.visibility = 'public' THEN p.body END AS body, " +
  "p.version, p.created_at AS createdAt, p.updated_at AS updatedAt";
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
 * `<script>` の中身にする JSON。script の中で終わり（`</script>`）や escaped の状態（`<!--`）を作れるのは
 * `<` だけで、文字参照は解かれないので、HTML のエスケープではなく JSON の `\u003c` で書く。
 * `>`、`&`、U+2028、U+2029 も `\uXXXX` にするが、JSON.parse で読む値は変わらない。
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/**
 * index.html の head にページのメタ情報を、public のページなら `#root` に title と本文を差し込む。
 *
 * HTMLRewriter は自分で挿入したマークアップを解析し直さないので、2 段に分ける。1 段目は値を持たない
 * 固定のタグだけを挿入し、2 段目がそのタグに setAttribute や setInnerContent で値を入れる。ページの
 * title や抜粋、本文を HTML の文字列に連結せず、エスケープを HTMLRewriter に任せるため（属性値の `&`
 * だけは attributeValue、script の中身は scriptJson）。og:image は既定の画像を持たないので出さない。
 *
 * 本文は JS を実行しない読み手（AI のエージェントやクローラー）向けで、Markdown を変換せずにテキストのまま
 * `<pre>` に入れる。Markdown の解析は本文の大きさに比例して CPU を使い、大きな本文では Workers Free の
 * 10ms を超えうる（MAX_BODY_BYTES の測定）ので、表示のたびには行わない。
 * ブラウザでは styles.css が隠し、SPA の createRoot が `#root` の中身を置き換える。
 *
 * public のページは、SPA が `/api/pages/:id` を引かずに初回の表示を出せるよう、同じ pageJson で作った JSON を
 * head の実行されない script にも入れる。version は保存の衝突の検出に使うので、本文と同じ行から読んだ値を組にする。
 * `<pre>` の本文を使い回さないのは、HTML の parser が改行の `\r` を畳み、保存されている本文と一致しないため。
 *
 * links は本文がリンクする public のページで、本文の下に正規の URL（絶対 URL）の `<a>` の一覧にして入れる。
 * `<pre>` の中の `[[...]]` は、HTML を Markdown にして読む取得でもリンクにならないので、行き先をたどれるようにする。
 * 本文を入れないページ（draft）には、links を渡されても入れない。0 件なら `<ul>` を出さない。
 */
export function rewritePageHtml(
  index: Response,
  page: PageMeta,
  origin: string,
  links: LinkTarget[],
): Response {
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
  const body = page.visibility === "public" ? page.body : null;
  if (body !== null) {
    tags.push(`<script type="application/json" id="${INITIAL_PAGE_ELEMENT_ID}"></script>`);
  }

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
  if (body !== null) {
    const list = linkListHtml(links.length);
    structure.on("#root", {
      element(element) {
        element.setInnerContent(
          `<article class="page-text"><h1></h1><pre></pre>${list}</article>`,
          {
            html: true,
          },
        );
      },
    });
  }
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
  if (body !== null) {
    const initial = pageJson({ ...page, body });
    values
      .on(`head > script#${INITIAL_PAGE_ELEMENT_ID}`, {
        element(element) {
          element.setInnerContent(scriptJson(initial), { html: true });
        },
      })
      .on("#root > article.page-text > h1", {
        element(element) {
          element.setInnerContent(page.title);
        },
      })
      .on("#root > article.page-text > pre", {
        element(element) {
          // HTML の parser は <pre> の開始タグの直後の改行を 1 つ捨てるので、本文の先頭の改行が残るよう 1 つ足す
          element.setInnerContent(`\n${body}`);
        },
      });
    fillLinkList(values, links, origin);
  }
  return values.transform(structure.transform(index));
}

/**
 * ページの HTML に入れるリンク先の件数。本文のリンクの数は本文の上限でしか抑えられない（64KiB で 1 万件を超えうる）
 * ので、HTML の大きさと書き換えの CPU を抑える。超えた分は title_key の順の後ろから外す。
 */
export const PAGE_LINK_LIST_LIMIT = 100;

/** 件数分の値を持たない `<li><a></a></li>`。0 件なら空文字列で、`<ul>` を出さない。 */
function linkListHtml(count: number): string {
  return count === 0 ? "" : `<ul>${"<li><a></a></li>".repeat(count)}</ul>`;
}

/** linkListHtml で挿入した `<a>` に、文書の順に正規の URL と title を入れる。 */
function fillLinkList(rewriter: HTMLRewriter, pages: LinkTarget[], origin: string): void {
  let next = 0;
  rewriter.on("#root > article.page-text > ul > li > a", {
    element(element) {
      const page = pages[next++];
      if (page === undefined) return;
      element.setAttribute("href", attributeValue(publicPageUrl(origin, page)));
      element.setInnerContent(page.title);
    },
  });
}

/** `/` の HTML と `/llms.txt` に入れる public のページの件数。ページ送りは作らない。 */
export const ROOT_PAGE_LIST_LIMIT = 100;

/**
 * トップの index.html の `#root` に、サイト名と public のページへのリンクの一覧を差し込む。
 * JS を実行しない読み手が、最初の 1 ページへたどれるようにするため。リンクは各ページの正規の URL にする。
 * 一覧の後ろに sitemap.xml へのリンクを置き、ROOT_PAGE_LIST_LIMIT で切った残りのページへもたどらせる。
 * public のページが無ければ sitemap.xml も空なので、リンクを置かない。
 *
 * rewritePageHtml と同じく 2 段に分け、1 段目は値を持たない固定のタグだけを件数分挿入し、2 段目が
 * 文書の順にリンクを埋める。title を HTML の文字列に連結しない。
 * ブラウザでは styles.css が隠し、SPA の createRoot が `#root` の中身を置き換える。
 */
export function rewriteRootHtml(
  index: Response,
  { siteName, pages, origin }: { siteName: string; pages: PublicPageEntry[]; origin: string },
): Response {
  const list = linkListHtml(pages.length);
  const sitemap = pages.length === 0 ? "" : "<p><a>sitemap.xml</a></p>";
  const structure = new HTMLRewriter().on("#root", {
    element(element) {
      element.setInnerContent(`<article class="page-text"><h1></h1>${list}${sitemap}</article>`, {
        html: true,
      });
    },
  });
  const values = new HTMLRewriter()
    .on("#root > article.page-text > h1", {
      element(element) {
        element.setInnerContent(siteName);
      },
    })
    .on("#root > article.page-text > p > a", {
      element(element) {
        element.setAttribute("href", attributeValue(`${origin}${SITEMAP_XML_PATH}`));
      },
    });
  fillLinkList(values, pages, origin);
  return values.transform(structure.transform(index));
}
