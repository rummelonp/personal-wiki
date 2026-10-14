import { useRef } from "react";
import { loginHref, type Me } from "./api";
import { PlusIcon, SearchIcon } from "./icons";
import { Link } from "./Link";
import { NewPageDialog } from "./NewPageDialog";
import { homeHref } from "./route";
import { switcherShortcutKeys, switcherShortcutLabel } from "./shortcut";

export type SessionState =
  | { status: "loading" }
  | { status: "ready"; me: Me }
  | { status: "error" };

interface HeaderProps {
  session: SessionState;
  loggingOut: boolean;
  onLogout: () => void;
  /** quick switcher を開く。検索の入口はこれだけで、検索語はそちらの入力欄で打つ。 */
  onOpenSearch: () => void;
}

/**
 * 狭い幅でも 1 行に収める。検索は欄でなく開くだけのボタンにし（変換中の文字を別の入力欄へ
 * 移さないため）、狭い幅では虫眼鏡だけにする。ラベルを隠す幅の切り替えは CSS が持つ。
 */
export function Header({ session, loggingOut, onLogout, onOpenSearch }: HeaderProps) {
  const isOwner = session.status === "ready" && session.me.kind === "owner";
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <header className="header">
      <Link className="brand" href={homeHref()}>
        personal-wiki
      </Link>
      {session.status === "ready" && (
        <button
          type="button"
          className="header-search"
          aria-label="ページを検索"
          aria-keyshortcuts={switcherShortcutKeys()}
          onClick={onOpenSearch}
        >
          <SearchIcon />
          <span className="header-search-text">ページを検索</span>
          <kbd className="header-search-key">{switcherShortcutLabel()}</kbd>
        </button>
      )}
      <div className="header-actions">
        {isOwner && (
          <button
            type="button"
            className="button button-primary button-compact header-new"
            aria-label="新規作成"
            onClick={() => dialogRef.current?.showModal()}
          >
            <PlusIcon />
            <span className="header-new-label">新規作成</span>
          </button>
        )}
        {session.status === "loading" && <span className="muted">確認中…</span>}
        {session.status === "error" && <span className="muted">状態を取得できませんでした</span>}
        {isOwner && (
          <button
            type="button"
            className="button button-quiet button-compact"
            onClick={onLogout}
            disabled={loggingOut}
          >
            ログアウト
          </button>
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
