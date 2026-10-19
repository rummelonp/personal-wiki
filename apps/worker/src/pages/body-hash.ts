/**
 * 保存されている本文（frontmatter を含む全体）を UTF-8 にしたバイト列の SHA-256 を、小文字の 16 進
 * 64 文字で返す。保存は本文の改行も末尾も変えないので、ローカルのファイルを同じ手順でハッシュすれば、
 * 本文を読み直さずに wiki と一致するかを比べられる。
 * 保存のたびに page_excerpts.body_sha256 へ書く値と、read_page が返す値は、どちらもこの関数で作る。
 */
export async function bodySha256(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
