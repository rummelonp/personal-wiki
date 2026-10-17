import { Suspense, useEffect, useState } from "react";
import { fetchMe, logout, NO_FEATURES } from "./api";
import { setDocumentTitle } from "./document-title";
import { saveAllEditors } from "./editor-lifecycle";
import { Header, type SessionState } from "./Header";
import { HomeView } from "./HomeView";
import { LinkRewriteStatus } from "./LinkRewriteStatus";
import { RouteSkeleton } from "./Loading";
import { linkRewrites } from "./link-rewrites";
import { NotFound } from "./NotFound";
import { Notice, NoticeDockProvider } from "./Notice";
import { useNewPageRequest } from "./new-page";
import { forgetTitles } from "./page-titles";
import { PageView, preloadPageView } from "./page-view-loader";
import { QuickSwitcher } from "./QuickSwitcher";
import { RailLayout } from "./Rail";
import { useRoute } from "./route";
import { isSwitcherShortcut } from "./shortcut";

export function App() {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [loggingOut, setLoggingOut] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const route = useRoute();
  const newPage = useNewPageRequest();
  const searchQuery = route.name === "home" ? route.query.trim() : "";

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

  // ログイン状態を取れなかったままだと、通信が戻っても再読み込みまで画面も書き換えのループも戻らない。
  // 通信の復帰と画面の再表示で取り直す（ポーリングはしない）
  const sessionFailed = session.status === "error";
  useEffect(() => {
    if (!sessionFailed) return;
    let cancelled = false;
    let fetching = false;
    function recover() {
      if (fetching || document.visibilityState === "hidden") return;
      fetching = true;
      fetchMe()
        .then((me) => {
          if (cancelled) return;
          if (me.kind === "anonymous") {
            // 取れなかった間にログアウトが済んでいたか、初めから匿名だった。書き換えが止まって
            // 残っていれば捨て、匿名の画面に移る
            linkRewrites.stop();
            forgetTitles();
          }
          setSession({ status: "ready", me });
        })
        .catch(() => {})
        .finally(() => {
          fetching = false;
        });
    }
    window.addEventListener("online", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      cancelled = true;
      window.removeEventListener("online", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [sessionFailed]);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await saveAllEditors();
      linkRewrites.suspend();
      try {
        await logout();
      } catch {
        // 失敗のレスポンスでも、サーバーでは済んでいることがある。ログイン状態を確かめ、続いていれば
        // 止めた書き換えを再開する（匿名ならそのまま匿名の画面に移る）。確かめられなければ
        // エラーの画面にし、ログイン状態が分かるまで書き換えは止めたままにする
        const me = await fetchMe();
        if (me.kind === "anonymous") {
          linkRewrites.stop();
          forgetTitles();
        }
        setSession({ status: "ready", me });
        if (me.kind === "owner" && me.features.linkRewrites) linkRewrites.resume();
        return;
      }
      linkRewrites.stop();
      forgetTitles();
      // features は環境の性質で、ログアウトでは変わらない
      setSession((current) => ({
        status: "ready",
        me: {
          kind: "anonymous",
          features: current.status === "ready" ? current.me.features : NO_FEATURES,
        },
      }));
    } catch {
      setSession({ status: "error" });
    } finally {
      setLoggingOut(false);
    }
  }

  // 画面は /api/me のレスポンスを待ってから出す。/api/me は検証できない cookie を消すので、その後の
  // 匿名の読み取りが期限切れの cookie で 401 にならない
  const ready = session.status === "ready";
  const isOwner = ready && session.me.kind === "owner";
  const canRewriteLinks = isOwner && session.me.features.linkRewrites;

  // 前の起動やエージェントの改名で残った書き換えを、owner が開いたときに進める。止めるのはログアウトだけで、
  // effect の後片付けでは止めない（StrictMode の 2 回目の実行で step を 2 本走らせない）
  useEffect(() => {
    if (!canRewriteLinks) return;
    // ログアウトの結果が分からなかったあとに owner と分かったときは、止めた書き換えを続きから走らせる。
    // start は見せている結果を消して最初から始めるので、結果が残っている間は呼ばない
    linkRewrites.resume();
    if (linkRewrites.getState().status === "idle") linkRewrites.start();
  }, [canRewriteLinks]);

  // owner の + で開く新規作成の画面が suspend しないよう、owner と分かった時点で読み込んでおく
  useEffect(() => {
    if (isOwner) preloadPageView();
  }, [isOwner]);

  // ⌘K（Mac）/ Ctrl+K で quick switcher を開閉する。ほかのダイアログが開いている間は奪わない
  useEffect(() => {
    if (!ready) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (!isSwitcherShortcut(event)) return;
      if (!switcherOpen && document.querySelector("dialog[open]") !== null) return;
      event.preventDefault();
      setSwitcherOpen(!switcherOpen);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [ready, switcherOpen]);

  return (
    <NoticeDockProvider>
      <div className="app">
        <Header
          session={session}
          query={searchQuery}
          onOpenSearch={() => setSwitcherOpen(true)}
          loggingOut={loggingOut}
          onLogout={() => void handleLogout()}
        />
        <main className="main">
          {isOwner && <LinkRewriteStatus />}
          {session.status === "loading" && <RouteSkeleton route={route} />}
          {session.status === "error" && (
            <RailLayout rail={null}>
              <Notice inline tone="error" title="ログインの状態を取得できませんでした">
                <p>
                  通信が戻ると自動で取り直します。戻らないときは、ページを再読み込みしてください。
                </p>
              </Notice>
            </RailLayout>
          )}
          {ready && route.name === "home" && (
            <HomeView
              // 一覧とタグは owner なら draft を含む。ログアウトの後に残さないよう取り直す
              key={isOwner ? "owner" : "reader"}
              query={route.query}
              tag={route.tag}
              visibility={route.visibility}
              owner={isOwner}
            />
          )}
          {ready && (route.name === "page" || route.name === "title" || route.name === "new") && (
            <Suspense fallback={<RouteSkeleton route={route} owner={isOwner} />}>
              <PageView
                // owner と匿名では読めるページも画面も違うので、ログイン状態が変わったら取り直す。
                // `/?new` も同じ位置と key に置き、作れた後の `/p/<id>` で作り直さない
                key={isOwner ? "owner" : "reader"}
                target={
                  route.name === "page"
                    ? { by: "id", id: route.id }
                    : route.name === "title"
                      ? { by: "title", title: route.title }
                      : { by: "new", ...newPage }
                }
                owner={isOwner}
                attachments={session.me.features.attachments}
              />
            </Suspense>
          )}
          {ready && route.name === "unknown" && <NotFound />}
        </main>
        {ready && (
          // 候補の一覧は owner と匿名で違う（draft を含むか）ので、ログイン状態が変わったら作り直す
          <QuickSwitcher
            key={isOwner ? "owner" : "reader"}
            open={switcherOpen}
            onOpenChange={setSwitcherOpen}
            owner={isOwner}
            initialQuery={searchQuery}
          />
        )}
      </div>
    </NoticeDockProvider>
  );
}
