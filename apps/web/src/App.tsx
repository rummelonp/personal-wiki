import {
  type ComponentProps,
  type ComponentType,
  lazy,
  Suspense,
  useEffect,
  useState,
} from "react";
import { fetchMe, logout, NO_FEATURES } from "./api";
import { setDocumentTitle } from "./document-title";
import { saveAllEditors } from "./editor-lifecycle";
import { Header, type SessionState } from "./Header";
import { HomeView } from "./HomeView";
import { LinkRewriteStatus } from "./LinkRewriteStatus";
import { linkRewrites } from "./link-rewrites";
import { NotFound } from "./NotFound";
import { useNewPageRequest } from "./new-page";
import { QuickSwitcher } from "./QuickSwitcher";
import { parseRoute, useRoute } from "./route";
import { isSwitcherShortcut } from "./shortcut";

type PageViewModule = typeof import("./PageView");
type PageViewProps = ComponentProps<PageViewModule["PageView"]>;

let loadedPageView: PageViewModule | null = null;

// エディタ（CodeMirror）はページの画面でしか使わないので、トップと検索の初回の読み込みから外す。
// 読み込みの失敗（デプロイで古い版の chunk が消えた後の遷移など）は、画面全体を壊さず再読み込みを促す
const loadPageView = () =>
  import("./PageView").then((module) => {
    loadedPageView = module;
    return module;
  });

// 読み込み済みなら、then を同期で呼ぶ thenable を返す。lazy はこれを待たずに描画するので、
// 新規作成の画面を開く操作（openNewPage の flushSync）の中で editor の mount と focus まで済む。
// Promise を返すと、読み込み済みでも最初の描画が 1 度 suspend し、iOS でキーボードが出ない
type PageViewExport = { default: ComponentType<PageViewProps> };
const PageView = lazy((): Promise<PageViewExport> => {
  const loaded = loadedPageView;
  if (loaded !== null) {
    const ready: PromiseLike<PageViewExport> = {
      // biome-ignore lint/suspicious/noThenProperty: 同期に解決する thenable がここでの目的
      then: (resolve) => resolve?.({ default: loaded.PageView }) as never,
    };
    // lazy が呼ぶのは then だけ
    return ready as Promise<PageViewExport>;
  }
  return loadPageView().then(
    (module) => ({ default: module.PageView }),
    () => ({ default: PageViewLoadFailed }),
  );
});

// ページの URL で開いたときは、/api/me の応答を待つ間にエディタも読み込んでおく
const initialRoute = parseRoute(window.location.pathname, window.location.search);
if (initialRoute.name === "page" || initialRoute.name === "title" || initialRoute.name === "new") {
  loadPageView().catch(() => {});
}

function PageViewLoadFailed() {
  return (
    <p className="message message-error" role="alert">
      画面を読み込めませんでした。再読み込みしてください。
    </p>
  );
}

export function App() {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [loggingOut, setLoggingOut] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const route = useRoute();
  const newPage = useNewPageRequest();

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
      linkRewrites.stop();
      try {
        await logout();
      } catch {
        // 失敗の応答でも、サーバーでは済んでいることがある。ログイン状態を確かめ、続いていれば
        // 止めた書き換えを再開する（匿名ならそのまま匿名の画面に移る）
        const me = await fetchMe();
        setSession({ status: "ready", me });
        if (me.kind === "owner" && me.features.linkRewrites) linkRewrites.start();
        return;
      }
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

  // 画面は /api/me の応答を待ってから出す。/api/me は検証できない cookie を消すので、その後の
  // 匿名の読み取りが期限切れの cookie で 401 にならない
  const ready = session.status === "ready";
  const isOwner = ready && session.me.kind === "owner";
  const canRewriteLinks = isOwner && session.me.features.linkRewrites;

  // 前の起動やエージェントの改名で残った書き換えを、owner が開いたときに進める。止めるのはログアウトだけで、
  // effect の後片付けでは止めない（StrictMode の 2 回目の実行で step を 2 本走らせない）
  useEffect(() => {
    if (canRewriteLinks) linkRewrites.start();
  }, [canRewriteLinks]);

  // owner の + で開く新規作成の画面が suspend しないよう、owner と分かった時点で読み込んでおく
  useEffect(() => {
    if (isOwner) loadPageView().catch(() => {});
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
    <div className="app">
      <Header
        session={session}
        onOpenSearch={() => setSwitcherOpen(true)}
        loggingOut={loggingOut}
        onLogout={() => void handleLogout()}
      />
      <main className="main">
        {isOwner && <LinkRewriteStatus />}
        {session.status === "loading" && <p className="narrow muted">読み込み中…</p>}
        {session.status === "error" && (
          <p className="narrow message message-error" role="alert">
            ログインの状態を取得できませんでした。再読み込みしてください。
          </p>
        )}
        {ready && route.name === "home" && (
          <HomeView
            // 一覧とタグは owner なら draft を含む。ログアウトの後に残さないよう取り直す
            key={isOwner ? "owner" : "reader"}
            query={route.query}
            tag={route.tag}
            owner={isOwner}
          />
        )}
        {ready && (route.name === "page" || route.name === "title" || route.name === "new") && (
          <Suspense fallback={<p className="narrow muted">読み込み中…</p>}>
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
        />
      )}
    </div>
  );
}
