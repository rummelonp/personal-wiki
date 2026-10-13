export { isPageId } from "@personal-wiki/domain";

/**
 * 16 バイトの乱数の base64url（22 文字）。draft は id を知っている人だけが読める前提なので、
 * 連番や時刻由来の値にしない。
 */
export function generatePageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
