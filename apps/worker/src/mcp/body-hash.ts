/**
 * 保存されている本文（frontmatter を含む全体）を UTF-8 にしたバイト列の SHA-256 を、小文字の 16 進
 * 64 文字で返す。保存は本文の改行も末尾も変えないので、ローカルのファイルを同じ手順でハッシュすれば、
 * 本文を読み直さずに wiki と一致するかを比べられる。
 */
export async function bodySha256(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** bodySha256 を返す tool の description に共通で載せる、計算の手順 */
export const BODY_SHA256_NOTE =
  "bodySha256 は保存されている本文（frontmatter を含む全体。title は含まない）を UTF-8 のバイト列にした SHA-256 で、小文字の 16 進 64 文字。改行の変換、末尾の改行の補い、frontmatter の除去はしない。ローカルの Markdown を UTF-8 のまま `shasum -a 256` などでハッシュした値と比べれば、本文を読み直さずに一致を確かめられる（ローカル側の CRLF や末尾の改行の有無が違うと別の値になる）。";
