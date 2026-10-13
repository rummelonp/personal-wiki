import { useRef } from "react";
import { loginHref, type Me } from "./api";
import { Link } from "./Link";
import { NewPageDialog } from "./NewPageDialog";
import { homeHref } from "./route";
import { SearchBox } from "./SearchBox";

export type SessionState =
  | { status: "loading" }
  | { status: "ready"; me: Me }
  | { status: "error" };

interface HeaderProps {
  session: SessionState;
  /** トップは一覧の上に検索欄があるので、ヘッダーには出さない。 */
  showSearch: boolean;
  loggingOut: boolean;
  onLogout: () => void;
}

export function Header({ session, showSearch, loggingOut, onLogout }: HeaderProps) {
  const isOwner = session.status === "ready" && session.me.kind === "owner";
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <header className="header">
      <Link className="brand" href={homeHref()}>
        personal-wiki
      </Link>
      {isOwner && showSearch && <SearchBox query="" compact />}
      <div className="header-actions">
        {isOwner && (
          <button
            type="button"
            className="button button-primary button-compact"
            onClick={() => dialogRef.current?.showModal()}
          >
            新規作成
          </button>
        )}
        {session.status === "loading" && <span className="muted">確認中…</span>}
        {session.status === "error" && <span className="muted">状態を取得できませんでした</span>}
        {isOwner && (
          <>
            <span className="login-state">
              <span className="dot" aria-hidden="true" />
              ログイン中
            </span>
            <button
              type="button"
              className="button button-quiet button-compact"
              onClick={onLogout}
              disabled={loggingOut}
            >
              ログアウト
            </button>
          </>
        )}
        {session.status === "ready" && !isOwner && (
          <a className="button button-primary button-compact" href={loginHref(window.location)}>
            ログイン
          </a>
        )}
      </div>
      {isOwner && <NewPageDialog dialogRef={dialogRef} />}
    </header>
  );
}
