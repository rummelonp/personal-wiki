const PAGE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

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

/** 形式が違う id は D1 に問い合わせずに 404 にする。 */
export function isPageId(value: string): boolean {
  return PAGE_ID_PATTERN.test(value);
}
