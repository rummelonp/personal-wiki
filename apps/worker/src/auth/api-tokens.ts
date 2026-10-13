import type { Scope } from "./principal";

/**
 * `last_used_at` を書き直す最短の間隔。毎リクエスト書くと D1 の書き込み行数
 * （無料枠 10 万行/日）を API 呼び出しの回数だけ消費するので、この粒度で間引く。
 */
export const LAST_USED_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

export interface ActiveApiToken {
  id: number;
  name: string;
  scopes: Scope[];
  lastUsedAt: number | null;
}

interface ApiTokenRow {
  id: number;
  name: string;
  scopes: string;
  last_used_at: number | null;
}

/**
 * 失効していないトークンを hash で引く。
 *
 * 照合を UNIQUE 索引の検索に任せても、比較のタイミング差からトークンは推測できない。
 * 比較されるのは攻撃者が送った値の SHA-256 で、送った値を少し変えると hash は全体が
 * 変わるため、一致した先頭のバイト数を時間から測れても、次に送る値を絞り込めない。
 * 失効の判定も同じクエリで行い、未登録と失効済みで処理の経路を変えない。
 */
export async function findActiveApiToken(
  db: D1Database,
  tokenHash: string,
): Promise<ActiveApiToken | null> {
  const row = await db
    .prepare(
      "SELECT id, name, scopes, last_used_at FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL",
    )
    .bind(tokenHash)
    .first<ApiTokenRow>();
  if (row === null) return null;
  return {
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    lastUsedAt: row.last_used_at,
  };
}

/** 未知の値は権限を与えない側に倒して捨てる。 */
function parseScopes(text: string): Scope[] {
  return text.split(" ").filter((s): s is Scope => s === "read" || s === "write");
}

/** 前回の記録から間隔が空いたときだけ `last_used_at` を書く。 */
export async function recordApiTokenUse(
  db: D1Database,
  token: ActiveApiToken,
  now: number,
): Promise<void> {
  const threshold = now - LAST_USED_UPDATE_INTERVAL_MS;
  if (token.lastUsedAt !== null && token.lastUsedAt > threshold) return;
  // 同じトークンの同時リクエストが重なっても、条件付きの UPDATE で書き込みを 1 回に抑える
  await db
    .prepare(
      "UPDATE api_tokens SET last_used_at = ?1 WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at <= ?3)",
    )
    .bind(now, token.id, threshold)
    .run();
}
