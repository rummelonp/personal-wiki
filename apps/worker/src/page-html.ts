import { normalizeTitleKey, parsePagePath } from "@personal-wiki/domain";
import { type Principal, readableVisibilityOf } from "./auth/principal";
import { publicOnlyFlag, type Visibility } from "./pages/store";
import { pageUrls } from "./pages/urls";

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

/** SPA の初回の表示に使うページの JSON を入れる要素の id。apps/web/src/initial-page.ts と合わせる。 */
export const INITIAL_PAGE_ELEMENT_ID = "initial-page";

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
 * public のページは、SPA が `/api/pages/:id` を引かずに初回の表示を出せるよう、同じ形の JSON を head の
 * 実行されない script にも入れる。version は保存の衝突の検出に使うので、本文と同じ行から読んだ値を組にする。
 * `<pre>` の本文を使い回さないのは、HTML の parser が改行の `\r` を畳み、保存されている本文と一致しないため。
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
    structure.on("#root", {
      element(element) {
        element.setInnerContent('<article class="page-text"><h1></h1><pre></pre></article>', {
          html: true,
        });
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
    const initial = {
      id: page.id,
      title: page.title,
      body,
      visibility: page.visibility,
      version: page.version,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    };
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
  }
  return values.transform(structure.transform(index));
}
