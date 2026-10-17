import { useEffect, useRef } from "react";
import { loginHref, type Me } from "./api";
import { followVisualViewportTop } from "./header-viewport";
import { LogoutIcon, PlusIcon, SearchIcon } from "./icons";
import { Link } from "./Link";
import { useSkeletonPainted } from "./Loading";
import { openNewPage } from "./new-page";
import { homeHref } from "./route";
import { switcherShortcutKeys, switcherShortcutLabel } from "./shortcut";
import { SITE_NAME } from "./site-name";

export type SessionState =
  | { status: "loading" }
  | { status: "ready"; me: Me }
  | { status: "error" };

interface HeaderProps {
  session: SessionState;
  loggingOut: boolean;
  onLogout: () => void;
  /** 検索結果の画面にいる間の検索語。空でなければボタンに出す。 */
  query: string;
  /** quick switcher を開く。検索の入口はこれだけで、検索語はそちらの入力欄で打つ。 */
  onOpenSearch: () => void;
}

/** ログイン状態が分かるまで、右の操作の場所を空ける。owner と匿名のどちらかは分からないので、owner の 2 つ分の幅を取る。 */
function ActionsPlaceholder() {
  const painted = useSkeletonPainted();
  return (
    <span
      className={painted ? "header-pending skeleton-painted" : "header-pending"}
      aria-hidden="true"
    >
      <span className="skeleton header-skeleton" />
      <span className="skeleton header-skeleton" />
    </span>
  );
}

/**
 * 狭い幅でも 1 行に収める。検索は欄でなく開くだけのボタンにし（変換中の文字を別の入力欄へ
 * 移さないため）、狭い幅では虫眼鏡だけにする。ただし検索語があるときは、語が分かるよう
 * 狭い幅でも語を出し、長い語は省略する。ラベルを隠す幅の切り替えは CSS が持つ。
 * 匿名の「ログイン」は塗らない。塗りの差し色は、読者が読むページより目立つ。
 */
export function Header({ session, loggingOut, onLogout, query, onOpenSearch }: HeaderProps) {
  const isOwner = session.status === "ready" && session.me.kind === "owner";
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current === null ? undefined : followVisualViewportTop(ref.current)), []);

  return (
    <header className="header" ref={ref}>
      <Link className="brand" href={homeHref()}>
        <span className="brand-text">{SITE_NAME}</span>
      </Link>
      {session.status !== "error" && (
        <button
          type="button"
          className={query === "" ? "header-search" : "header-search header-search-filled"}
          // ログイン状態が分かる前は、候補の取得も始められない
          disabled={session.status === "loading"}
          aria-label={query === "" ? "ページを検索" : `ページを検索: ${query}`}
          aria-keyshortcuts={switcherShortcutKeys()}
          onClick={onOpenSearch}
        >
          <SearchIcon />
          <span className="header-search-text">{query === "" ? "ページを検索" : query}</span>
          <kbd className="header-search-key">{switcherShortcutLabel()}</kbd>
        </button>
      )}
      <div className="header-actions">
        {isOwner && (
          <button
            type="button"
            className="button button-primary button-compact header-new"
            aria-label="新規作成"
            onClick={() => openNewPage()}
          >
            <PlusIcon />
            <span className="header-new-label">新規作成</span>
          </button>
        )}
        {session.status === "loading" && <ActionsPlaceholder />}
        {isOwner && (
          <button
            type="button"
            className="button button-quiet button-compact header-logout"
            aria-label="ログアウト"
            onClick={onLogout}
            disabled={loggingOut}
          >
            <span className="header-logout-icon">
              <LogoutIcon />
            </span>
            <span className="header-logout-label">ログアウト</span>
          </button>
        )}
        {session.status === "ready" && !isOwner && (
          <a className="button button-compact" href={loginHref(window.location)}>
            ログイン
          </a>
        )}
      </div>
    </header>
  );
}
