export type Scope = "read" | "write";

/**
 * リクエストの呼び出し元。ルートの認可はこの型だけを見る。
 * owner はまだ解決しない（セッション cookie の検証は別の Work Item で足す）。
 */
export type Principal =
  | { kind: "anonymous" }
  | { kind: "owner" }
  | { kind: "token"; name: string; scopes: Scope[] };

/** write は read を含む（作成・更新の前に読み直す流れを 1 つのトークンで済ませるため）。 */
export function hasScope(granted: readonly Scope[], required: Scope): boolean {
  if (required === "read") return granted.includes("read") || granted.includes("write");
  return granted.includes("write");
}
