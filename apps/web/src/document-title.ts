import { SITE_NAME } from "./site-name";

/** Worker が HTML に差し込むのと同じ形にする（`ページの title - サイト名`）。 */
export function setDocumentTitle(pageTitle: string | null): void {
  document.title = pageTitle === null ? SITE_NAME : `${pageTitle} - ${SITE_NAME}`;
}
