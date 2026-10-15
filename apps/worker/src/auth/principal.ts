export type Scope = "read" | "write";

/**
 * リクエストの呼び出し元。ルートの認可はこの型だけを見る。
 * anonymous の staleSession は、セッション cookie を送ったが検証できなかったこと（期限切れ、署名の
 * 不一致、OWNER_EMAILS から外れたなど）を表す。権限は cookie が無い anonymous と同じ。
 *
 * token の issuer は資格情報の発行元。`api` は api_tokens のトークンで name はその名前、`oauth` は
 * OAuth のアクセストークンで name は client_id。名前空間が別なので、actor（revisions.ts）でも区別する。
 */
export type Principal =
  | { kind: "anonymous"; staleSession?: true }
  | { kind: "owner" }
  | { kind: "token"; issuer: TokenIssuer; name: string; scopes: Scope[] };

export type TokenIssuer = "api" | "oauth";

/** write は read を含む（作成、更新の前に読み直す流れを 1 つのトークンで済ませるため）。 */
export function hasScope(granted: readonly Scope[], required: Scope): boolean {
  if (required === "read") return granted.includes("read") || granted.includes("write");
  return granted.includes("write");
}

/**
 * principal が scope の操作をしてよいか。REST の宣言と MCP の tool が同じ判定を使う。
 * owner はすべての scope を持ち、token は発行時の scope に従い、anonymous は何も持たない。
 */
export function principalHasScope(principal: Principal, required: Scope): boolean {
  switch (principal.kind) {
    case "owner":
      return true;
    case "token":
      return hasScope(principal.scopes, required);
    case "anonymous":
      return false;
  }
}

/**
 * 読み取りで見せるページの範囲。`public` は title での取得と一覧系（最近の更新、タグ、検索、backlink）を
 * public のページだけに絞る。id での取得は範囲に関係なく draft も返す（id を知っていれば読める）。
 */
export type ReadableVisibility = "all" | "public";

/**
 * read の scope を持つ principal（owner と read の token）は draft も読み、それ以外は public だけ。
 * 宣言の検査を経ないルート（allowAnonymous() など）から呼ばれても、scope の無い token に draft を
 * 見せないよう、ここでも scope を見る。
 */
export function readableVisibilityOf(principal: Principal): ReadableVisibility {
  return principalHasScope(principal, "read") ? "all" : "public";
}
