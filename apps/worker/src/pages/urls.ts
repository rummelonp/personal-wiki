import { foldTitle } from "@personal-wiki/domain";
import type { Page } from "./store";

/**
 * `/<title>` の URL に使わない先頭の path segment。Worker の API と配信のパスと重なる。
 * `/<title>` のルーティングもこの一覧で判定し、URL を作る側と開く側で食い違わないようにする。
 */
export const RESERVED_PATH_SEGMENTS: readonly string[] = ["api", "mcp", "assets", "_auth", "p"];

/**
 * public のページを `/<title>` で開くときのパス。予約語と重なる title は null で、`/p/<id>` だけで開く。
 *
 * 判定は title_key と同じ畳み方（大文字小文字、全角半角を区別しない）で、`/` の前の部分を見る。
 * パスでは `/` もエンコードするが、プロキシや配信の層が `%2F` を戻しても予約語のパスに入らないよう、
 * 区切りとして扱ったときの先頭でも判定する。`.` と `..` は URL の解決で消えるので使わない。
 */
export function titlePath(title: string): string | null {
  if (title === "." || title === "..") return null;
  const head = foldTitle(title.split("/", 1)[0] ?? "");
  if (RESERVED_PATH_SEGMENTS.includes(head)) return null;
  return `/${encodeURIComponent(title)}`;
}

export interface PageUrls {
  /** `/p/<id>`。visibility に関係なく開ける */
  url: string;
  /** `/<title>`。public で、title が予約語と重ならないときだけ */
  titleUrl: string | null;
}

/** origin はリクエストの URL から取る（ホスト名は設定値で、コードに持たない）。 */
export function pageUrls(
  origin: string,
  page: Pick<Page, "id" | "title" | "visibility">,
): PageUrls {
  const path = page.visibility === "public" ? titlePath(page.title) : null;
  return {
    url: `${origin}/p/${page.id}`,
    titleUrl: path === null ? null : `${origin}${path}`,
  };
}
