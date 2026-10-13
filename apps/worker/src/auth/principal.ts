export type Scope = "read" | "write";

/** リクエストの呼び出し元。ルートの認可はこの型だけを見る。 */
export type Principal =
  | { kind: "anonymous" }
  | { kind: "owner" }
  | { kind: "token"; name: string; scopes: Scope[] };

/** write は read を含む（作成・更新の前に読み直す流れを 1 つのトークンで済ませるため）。 */
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
