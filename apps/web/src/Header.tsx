import { DEFAULT_SITE_NAME } from "@personal-wiki/domain";
import { type RefObject, useEffect, useRef, useState } from "react";
import { loginHref, type Me } from "./api";
import { followVisualViewportTop } from "./header-viewport";
import { ConnectionIcon, LogoutIcon, PlusIcon, SearchIcon } from "./icons";
import { Link } from "./Link";
import { useSkeletonPainted } from "./Loading";
import { openNewPage } from "./new-page";
import { homeHref } from "./route";
import { switcherShortcutKeys, switcherShortcutLabel } from "./shortcut";
import { SITE_NAME } from "./site-name";

/** 既定のサイト名のときだけ、狭い幅でロゴに出す短い文字 */
const SHORT_SITE_NAME = "wiki";

/** 許可した接続の一覧。Worker が owner にだけ返す画面。 */
const OAUTH_GRANTS_HREF = "/_auth/oauth/grants";

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

/** ログイン状態が分かるまで、右の操作の場所を空ける。owner と匿名のどちらかは分からないので、owner の 3 つ分の幅を取る。OAuth の無い環境では 2 つになるが、分かる前は区別できない。 */
function ActionsPlaceholder() {
  const painted = useSkeletonPainted();
  return (
    <span
      className={painted ? "header-pending skeleton-painted" : "header-pending"}
      aria-hidden="true"
    >
      <span className="skeleton header-skeleton" />
      <span className="skeleton header-skeleton" />
      <span className="skeleton header-skeleton" />
    </span>
  );
}

/**
 * ヘッダーのサイト名が省略されている間だけ true。幅の変化と検索語の出入りで省略の有無が変わるので、
 * 名前の箱の大きさを観測して測り直す。
 */
function useClipped(ref: RefObject<HTMLElement | null>): boolean {
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const measure = () => setClipped(element.scrollWidth > element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return clipped;
}

/**
 * 狭い幅でも 1 行に収める。検索は欄でなく開くだけのボタンにし（変換中の文字を別の入力欄へ
 * 移さないため）、狭い幅では虫眼鏡だけにする。ただし検索語があるときは、語が分かるよう
 * 狭い幅でも語を出し、長い語は省略する。ラベルを隠す幅の切り替えは CSS が持つ。
 * 省略したサイト名の全文は hover の tooltip（title）で見せる。title はリンクでなく中の文字に付ける。
 * リンクの title は説明として公開され、読み上げが名前の後に同じ文字をもう一度読む実装があり得る。
 * 既定のサイト名を狭い幅で短い表示（「wiki」）に替えたときは、tooltip を出さない。短い表示は省略でなく
 * 置き換えで、正式な名前は既定値なので hover で得る情報が少なく、リンクの名前（aria-label）が持つ。
 * タッチ端末には hover が無いが、ロゴのタップはホームへの移動で、全文は tab の title にも出るので、
 * 全文を見る別の手段は置かない。
 * 「接続」は Worker が返す画面なので、SPA の遷移にせず素のリンクで開く。
 * Worker は OAuth を設定していない環境で 404 を返すので、`/api/me` の features.oauth が true のときだけ出す。
 * 匿名の「ログイン」は塗らない。塗りの差し色は、読者が読むページより目立つ。
 */
export function Header({ session, loggingOut, onLogout, query, onOpenSearch }: HeaderProps) {
  const isOwner = session.status === "ready" && session.me.kind === "owner";
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current === null ? undefined : followVisualViewportTop(ref.current)), []);
  const brandTextRef = useRef<HTMLSpanElement>(null);
  const brandClipped = useClipped(brandTextRef);
  const shortened = SITE_NAME === DEFAULT_SITE_NAME;

  return (
    <header className="header" ref={ref}>
      <Link
        className="brand"
        href={homeHref()}
        // 短い表示に替わる幅でも、リンクの名前は正式な名前にする
        aria-label={shortened ? SITE_NAME : undefined}
      >
        <span
          className={shortened ? "brand-text brand-text-full" : "brand-text"}
          ref={brandTextRef}
          title={brandClipped ? SITE_NAME : undefined}
        >
          {SITE_NAME}
        </span>
        {shortened && (
          <span className="brand-text brand-text-short" aria-hidden="true">
            {SHORT_SITE_NAME}
          </span>
        )}
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
        {isOwner && session.me.features.oauth && (
          <a
            className="button button-quiet button-compact header-grants"
            href={OAUTH_GRANTS_HREF}
            aria-label="許可した接続"
          >
            <span className="header-grants-icon">
              <ConnectionIcon />
            </span>
            <span className="header-grants-label">接続</span>
          </a>
        )}
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
