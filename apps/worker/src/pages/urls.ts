import { titlePath } from "@personal-wiki/domain";
import type { Page } from "./store";

export interface PageUrls {
  /** `/p/<id>`。draft は、draft を読める principal だけが開ける */
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

/**
 * public と分かっているページの正規の URL。title が予約語と重なれば `/p/<id>`。
 * JS を実行しない読み手への一覧が使う。
 */
export function publicPageUrl(origin: string, page: Pick<Page, "id" | "title">): string {
  const urls = pageUrls(origin, { ...page, visibility: "public" });
  return urls.titleUrl ?? urls.url;
}
