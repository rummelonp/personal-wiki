// 発行は scripts/api-token.mjs が行い、Worker は照合だけを行う。
// 形式（32 バイトの乱数を base64url で符号化）と hash の計算は、発行側と揃える。

// 32 byte を base64url（パディング無し）で符号化すると必ず 43 文字になる。
const TOKEN_LENGTH = 43;
const WELL_FORMED_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * DB を引く前に形式だけで弾く。発行しうる形（長さと文字種）から外れた入力は、
 * 登録済みトークンとの偶然の一致がありえないので、クエリを発行するまでもない。
 */
export function isWellFormedApiToken(token: string): boolean {
  return token.length === TOKEN_LENGTH && WELL_FORMED_TOKEN_PATTERN.test(token);
}

/** `api_tokens.token_hash` と照合する SHA-256 の hex（小文字）。 */
export async function hashApiToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
