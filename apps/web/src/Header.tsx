import { type FormEvent, useEffect, useRef, useState } from "react";
import { loginHref, type Me } from "./api";
import { Link } from "./Link";
import { NewPageDialog } from "./NewPageDialog";
import { homeHref, navigate } from "./route";

export type SessionState =
  | { status: "loading" }
  | { status: "ready"; me: Me }
  | { status: "error" };

interface HeaderProps {
  session: SessionState;
  /** 現在の検索語。`/?q=` と入力欄をそろえる。 */
  query: string;
  loggingOut: boolean;
  onLogout: () => void;
}

export function Header({ session, query, loggingOut, onLogout }: HeaderProps) {
  const isOwner = session.status === "ready" && session.me.kind === "owner";
  const [text, setText] = useState(query);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    setText(query);
  }, [query]);

  function handleSearch(event: FormEvent) {
    event.preventDefault();
    navigate(homeHref(text));
  }

  return (
    <header className="header">
      <Link className="brand" href={homeHref()}>
        personal-wiki
      </Link>
      {isOwner && (
        <search className="search">
          <form onSubmit={handleSearch}>
            <input
              className="text-input search-input"
              type="search"
              aria-label="検索"
              placeholder="検索"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </form>
        </search>
      )}
      <div className="header-actions">
        {isOwner && (
          <button type="button" className="button" onClick={() => dialogRef.current?.showModal()}>
            新規作成
          </button>
        )}
        {session.status === "loading" && <span className="muted">確認中…</span>}
        {session.status === "error" && <span className="muted">状態を取得できませんでした</span>}
        {isOwner && (
          <>
            <span className="muted">ログイン中</span>
            <button type="button" className="button" onClick={onLogout} disabled={loggingOut}>
              ログアウト
            </button>
          </>
        )}
        {session.status === "ready" && !isOwner && (
          <a className="button" href={loginHref(window.location)}>
            ログイン
          </a>
        )}
      </div>
      {isOwner && <NewPageDialog dialogRef={dialogRef} />}
    </header>
  );
}
