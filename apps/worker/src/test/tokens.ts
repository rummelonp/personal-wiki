import { env } from "cloudflare:workers";
import { hashApiToken } from "../auth/token";

/** 発行スクリプトと同じ形式（32 バイトの乱数の base64url）のトークンを作る。 */
export function generateTestToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export interface InsertTokenOptions {
  name: string;
  scopes: "read" | "read write";
  revokedAt?: number;
  lastUsedAt?: number;
}

/** api_tokens に行を作り、平文のトークンを返す。 */
export async function insertToken(options: InsertTokenOptions): Promise<string> {
  const token = generateTestToken();
  await env.DB.prepare(
    "INSERT INTO api_tokens (name, token_hash, scopes, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      options.name,
      await hashApiToken(token),
      options.scopes,
      0,
      options.lastUsedAt ?? null,
      options.revokedAt ?? null,
    )
    .run();
  return token;
}

export async function lastUsedAt(name: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT last_used_at FROM api_tokens WHERE name = ?")
    .bind(name)
    .first<{ last_used_at: number | null }>();
  if (row === null) throw new Error(`token not found: ${name}`);
  return row.last_used_at;
}
