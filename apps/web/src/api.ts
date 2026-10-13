/** `GET /api/me` の応答。Worker はメールアドレスを返さない。 */
export type Me =
  | { kind: "owner" }
  | { kind: "token"; name: string; scopes: string[] }
  | { kind: "anonymous" };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** 形の合わない応答は anonymous として扱う（ログイン中と誤って表示しない）。 */
export function parseMe(value: unknown): Me {
  if (typeof value !== "object" || value === null) return { kind: "anonymous" };
  const record = value as Record<string, unknown>;
  if (record.kind === "owner") return { kind: "owner" };
  if (
    record.kind === "token" &&
    typeof record.name === "string" &&
    Array.isArray(record.scopes) &&
    record.scopes.every((scope) => typeof scope === "string")
  ) {
    return { kind: "token", name: record.name, scopes: record.scopes };
  }
  return { kind: "anonymous" };
}

export async function fetchMe(fetchFn: Fetch = fetch): Promise<Me> {
  const res = await fetchFn("/api/me", { credentials: "same-origin", cache: "no-store" });
  if (!res.ok) throw new Error(`GET /api/me が ${res.status} を返した`);
  return parseMe(await res.json());
}

/** ログイン後に今のページへ戻るためのリンク。戻り先の検査は Worker が行う。 */
export function loginHref(location: { pathname: string; search: string; hash: string }): string {
  const current = `${location.pathname}${location.search}${location.hash}`;
  return `/_auth/login?return=${encodeURIComponent(current)}`;
}

/**
 * Worker は cookie 付きの変更系の要求に、同一オリジンと JSON の Content-Type を求める（CSRF 対策）。
 * 本文は空でよいが、Content-Type を付けるために `{}` を送る。
 */
export async function logout(fetchFn: Fetch = fetch): Promise<void> {
  const res = await fetchFn("/_auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`POST /_auth/logout が ${res.status} を返した`);
}
