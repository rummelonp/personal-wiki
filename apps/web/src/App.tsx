import { useEffect, useState } from "react";
import { fetchMe, logout } from "./api";
import { Header, type SessionState } from "./Header";
import { HomeView } from "./HomeView";
import { Link } from "./Link";
import { PageView } from "./PageView";
import { homeHref, useRoute } from "./route";
import { SignInNotice } from "./SignInNotice";

export function App() {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [loggingOut, setLoggingOut] = useState(false);
  const route = useRoute();

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((me) => {
        if (!cancelled) setSession({ status: "ready", me });
      })
      .catch(() => {
        if (!cancelled) setSession({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
      setSession({ status: "ready", me: { kind: "anonymous" } });
    } catch {
      setSession({ status: "error" });
    } finally {
      setLoggingOut(false);
    }
  }

  const isOwner = session.status === "ready" && session.me.kind === "owner";

  return (
    <div className="app">
      <Header
        session={session}
        showSearch={route.name !== "home"}
        loggingOut={loggingOut}
        onLogout={() => void handleLogout()}
      />
      <main className="main">
        {session.status === "loading" && <p className="narrow muted">読み込み中…</p>}
        {session.status === "error" && (
          <p className="narrow message message-error" role="alert">
            ログインの状態を取得できませんでした。再読み込みしてください。
          </p>
        )}
        {session.status === "ready" && !isOwner && <SignInNotice />}
        {isOwner && route.name === "home" && <HomeView query={route.query} tag={route.tag} />}
        {isOwner && route.name === "page" && <PageView id={route.id} />}
        {isOwner && route.name === "unknown" && (
          <section className="notice">
            <h1 className="notice-title">このパスのページはありません</h1>
            <p>
              <Link href={homeHref()}>最近の更新へ戻る</Link>
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
