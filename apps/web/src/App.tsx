import { useEffect, useState } from "react";
import { fetchMe, logout } from "./api";
import { setDocumentTitle } from "./document-title";
import { saveAllEditors } from "./editor-lifecycle";
import { Header, type SessionState } from "./Header";
import { HomeView } from "./HomeView";
import { NotFound } from "./NotFound";
import { PageView } from "./PageView";
import { useRoute } from "./route";

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

  // ページの title はページの画面が決める
  useEffect(() => {
    if (route.name === "home") setDocumentTitle(null);
  }, [route.name]);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await saveAllEditors();
      await logout();
      setSession({ status: "ready", me: { kind: "anonymous" } });
    } catch {
      setSession({ status: "error" });
    } finally {
      setLoggingOut(false);
    }
  }

  // 画面は /api/me の応答を待ってから出す。/api/me は検証できない cookie を消すので、その後の
  // 匿名の読み取りが期限切れの cookie で 401 にならない
  const ready = session.status === "ready";
  const isOwner = ready && session.me.kind === "owner";

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
        {ready && route.name === "home" && <HomeView query={route.query} tag={route.tag} />}
        {ready && (route.name === "page" || route.name === "title") && (
          <PageView
            // owner と匿名では読めるページも画面も違うので、ログイン状態が変わったら取り直す
            key={isOwner ? "owner" : "reader"}
            target={
              route.name === "page"
                ? { by: "id", id: route.id }
                : { by: "title", title: route.title }
            }
            owner={isOwner}
          />
        )}
        {ready && route.name === "unknown" && <NotFound />}
      </main>
    </div>
  );
}
