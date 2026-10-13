/** index.html の `<title>`。Worker はページの URL でこの前に `<title> - ` を差し込む。 */
export const SITE_NAME = "personal-wiki";

/** Worker が HTML に差し込むのと同じ形にする（`ページの title - personal-wiki`）。 */
export function setDocumentTitle(pageTitle: string | null): void {
  document.title = pageTitle === null ? SITE_NAME : `${pageTitle} - ${SITE_NAME}`;
}
