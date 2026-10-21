export { isPageId } from "@personal-wiki/domain";

/**
 * 16 バイトの乱数の base64url（22 文字）。連番や時刻由来の値にすると、匿名に見える public のページの
 * id の並びの隙間から、draft の数や作った時期を推し量れてしまう。
 */
export function generatePageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
