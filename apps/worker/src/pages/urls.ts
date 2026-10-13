import { titlePath } from "@personal-wiki/domain";
import type { Page } from "./store";

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
