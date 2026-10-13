import { useEffect, useState } from "react";
import { fetchMe, loginHref, logout, type Me } from "./api";

type State = { status: "loading" } | { status: "ready"; me: Me } | { status: "error" };

export function App() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((me) => {
        if (!cancelled) setState({ status: "ready", me });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
      setState({ status: "ready", me: { kind: "anonymous" } });
    } catch {
      setState({ status: "error" });
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <span className="brand">personal-wiki</span>
        <div className="session">
          {state.status === "loading" && <span className="muted">確認中…</span>}
          {state.status === "error" && <span className="muted">状態を取得できませんでした</span>}
          {state.status === "ready" && state.me.kind === "owner" && (
            <>
              <span>ログイン中</span>
              <button type="button" onClick={handleLogout} disabled={loggingOut}>
                ログアウト
              </button>
            </>
          )}
          {state.status === "ready" && state.me.kind !== "owner" && (
            <a href={loginHref(window.location)}>ログイン</a>
          )}
        </div>
      </header>
    </div>
  );
}
