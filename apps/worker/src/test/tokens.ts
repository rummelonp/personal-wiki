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

export interface InsertedToken {
  /** 平文のトークン */
  token: string;
  id: number;
  /** このトークンで書いたときの actor */
  actor: string;
}

/** api_tokens に行を作る。 */
export async function insertApiToken(options: InsertTokenOptions): Promise<InsertedToken> {
  const token = generateTestToken();
  const row = await env.DB.prepare(
    "INSERT INTO api_tokens (name, token_hash, scopes, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(
      options.name,
      await hashApiToken(token),
      options.scopes,
      0,
      options.lastUsedAt ?? null,
      options.revokedAt ?? null,
    )
    .first<{ id: number }>();
  if (row === null) throw new Error(`token not inserted: ${options.name}`);
  return { token, id: row.id, actor: `token:${row.id}:${options.name}` };
}

/** api_tokens に行を作り、平文のトークンを返す。 */
export async function insertToken(options: InsertTokenOptions): Promise<string> {
  return (await insertApiToken(options)).token;
}

export async function lastUsedAt(id: number): Promise<number | null> {
  const row = await env.DB.prepare("SELECT last_used_at FROM api_tokens WHERE id = ?")
    .bind(id)
    .first<{ last_used_at: number | null }>();
  if (row === null) throw new Error(`token not found: ${id}`);
  return row.last_used_at;
}
