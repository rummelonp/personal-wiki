import { foldTitle } from "./title";

/*
 * ページの URL（`/p/<id>` と `/<title>`）の規則。Worker の配信と OGP、SPA のルーティングが
 * 同じ関数で判定し、片方だけを変えて「Worker は 200 を返すのに SPA は開けない」食い違いを作らない。
 */

/**
 * Worker が自分で応答する先頭の segment。SPA の index.html を返さず、未定義のパスは JSON の 404 にする。
 * - `.well-known`: MCP クライアントは 401 の後に OAuth のメタデータを取りに来る。HTML を返すと
 *   JSON の解析に失敗する
 * - `assets`: Static Assets のハッシュ付きファイルの置き場。`/assets/*` は普段 Worker を通らないが、
 *   `/assets` そのものや run_worker_first の設定が変わったときにも HTML を返さない
 */
export const WORKER_PATH_SEGMENTS: readonly string[] = [
  "api",
  "mcp",
  "_auth",
  ".well-known",
  "assets",
];

/**
 * `/<title>` の URL に使わない先頭の segment（foldTitle で畳んだ形）。
 * - Worker の分と、SPA が開く `/p/<id>` の `p`
 * - Static Assets が Worker より先に応答するパス。`/index.html` と `/index` は、Static Assets の
 *   html_handling（auto-trailing-slash）が `/` への 307 にするので、同じ title のページを開けない。
 *   `apps/web/public` にファイルを置くときは、その名前（`.html` なら拡張子を除いた名前も）をここに足す
 */
export const RESERVED_TITLE_SEGMENTS: readonly string[] = [
  ...WORKER_PATH_SEGMENTS,
  "p",
  "index",
  "index.html",
  "robots.txt",
];

const PAGE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** ページの id の形（16 バイトの乱数の base64url）か。 */
export function isPageId(value: string): boolean {
  return PAGE_ID_PATTERN.test(value);
}

export const pageIdPath = (id: string): string => `/p/${id}`;

/**
 * public のページを `/<title>` で開くときのパス。予約語と重なる title は null で、`/p/<id>` だけで開く。
 *
 * パスでは `/` もエンコードするが、プロキシや配信の層が `%2F` を戻しても別のパスに入らないよう、
 * title_key と同じ畳み方（大文字小文字、全角半角を区別しない）をしてから `/` で区切って判定する。
 * 畳んでから区切るのは、NFKC で全角の `／` が `/` になるため。
 * ただし末尾が `/` の title だけは、`%2F` を戻された URL（`/Foo/`）が末尾の `/` を除いた `Foo` を開く。
 * - 先頭が予約語か空（`/api` が `//api` になる）なら使わない。
 * - `.` と `..` の segment は URL の解決で消えたり前の segment を消したりするので、どこにあっても使わない。
 */
export function titlePath(title: string): string | null {
  const segments = foldTitle(title).split("/");
  const head = segments[0] ?? "";
  if (head === "" || RESERVED_TITLE_SEGMENTS.includes(head)) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return `/${encodeURIComponent(title)}`;
}

export type PagePath = { kind: "id"; id: string } | { kind: "title"; title: string };

/**
 * ページの URL のパス（URL の pathname、percent-encoding のまま）を読む。ページの URL の形でなければ null。
 *
 * - `/p/<id>` と `/<title>` は、どちらも末尾の `/` を 1 つまで許す。titlePath は title の `/` を
 *   `%2F` にするので、エンコードされていない末尾の `/` が title の一部になることはない
 * - title は 1 回だけ decode する。エンコードされていない途中の `/` は title の `/` として読む
 *   （配信の層が `%2F` を戻した URL でも同じページを開く）。末尾の `/` だけは区切りとして除くので、
 *   末尾が `/` の title は `%2F` を戻されると別の title（`/Foo/` なら `Foo`）を指す
 * - titlePath が null になる title（予約語、`.` の segment、空）は null。`/P/x` や `/API` も含む
 */
export function parsePagePath(pathname: string): PagePath | null {
  if (!pathname.startsWith("/")) return null;
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const idMatch = /^\/p\/([^/]+)$/.exec(path);
  if (idMatch !== null) {
    const id = idMatch[1] as string;
    return isPageId(id) ? { kind: "id", id } : null;
  }
  let title: string;
  try {
    title = decodeURIComponent(path.slice(1));
  } catch {
    return null;
  }
  return titlePath(title) === null ? null : { kind: "title", title };
}

/** ページを開くときの正の URL のパス。public は `/<title>`、draft と予約語の title は `/p/<id>`。 */
export function canonicalPagePath(page: {
  id: string;
  title: string;
  visibility: "public" | "draft";
}): string {
  return (page.visibility === "public" ? titlePath(page.title) : null) ?? pageIdPath(page.id);
}
