/** Worker が `/api/me` で知らせる、この環境で使える機能。 */
export interface Features {
  /** 添付（R2）を使える。R2 の bucket を束ねていない環境では false */
  attachments: boolean;
  /** title の変更で積んだリンクの書き換えを進める step（`POST /api/link-rewrites/step`）がある */
  linkRewrites: boolean;
}

export const NO_FEATURES: Features = { attachments: false, linkRewrites: false };

/** `GET /api/me` の応答。Worker はメールアドレスを返さない。 */
export type Me = (
  | { kind: "owner" }
  | { kind: "token"; name: string; scopes: string[] }
  | { kind: "anonymous" }
) & { features: Features };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 項目が無いときは false にする。Worker を前の版に戻すと features を返さなくなるので、
 * 無いことを「使える」と読まない。
 * linkRewrites は features があることで判断する。Worker は step を足したあとに features を
 * 返し始めたので、features を返す Worker には step がある。
 */
function parseFeatures(value: unknown): Features {
  if (typeof value !== "object" || value === null) return NO_FEATURES;
  const features = value as Record<string, unknown>;
  return { attachments: features.attachments === true, linkRewrites: true };
}

/** 形の合わない応答は anonymous として扱う（ログイン中と誤って表示しない）。 */
export function parseMe(value: unknown): Me {
  if (typeof value !== "object" || value === null) {
    return { kind: "anonymous", features: NO_FEATURES };
  }
  const record = value as Record<string, unknown>;
  const features = parseFeatures(record.features);
  if (record.kind === "owner") return { kind: "owner", features };
  if (
    record.kind === "token" &&
    typeof record.name === "string" &&
    Array.isArray(record.scopes) &&
    record.scopes.every((scope) => typeof scope === "string")
  ) {
    return { kind: "token", name: record.name, scopes: record.scopes, features };
  }
  return {
    kind: "anonymous",
    features: record.kind === "anonymous" ? features : NO_FEATURES,
  };
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
