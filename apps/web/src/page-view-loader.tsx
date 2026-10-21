import { type ComponentProps, type ComponentType, lazy } from "react";
import { Notice } from "./Notice";
import { RailLayout } from "./Rail";
import type { Route } from "./route";

type PageViewProps = ComponentProps<typeof import("./PageView")["PageView"]>;
type PageViewModule = { PageView: ComponentType<PageViewProps> };
type PageViewExport = { default: ComponentType<PageViewProps> };

/**
 * ページの画面（エディタを含む）を読み込むコンポーネントを作る。
 * エディタ（CodeMirror）はページの画面でしか使わないので、トップと検索の初回の読み込みから外す。
 * 読み込みの失敗（デプロイで古い版の chunk が消えた後の遷移など）は、画面全体を壊さず再読み込みを促す。
 * ブラウザは失敗した module の取得をキャッシュしていて、同じ URL を import し直しても取り直さないので、
 * 画面の中で読み込み直す仕組みは持たない。
 * 作っただけでは何も読み込まない。importPageView と scheduleIdle は試験で差し替えられるよう引数にする。
 */
export function createPageViewLoader(
  importPageView: () => Promise<PageViewModule>,
  scheduleIdle: (task: () => void) => void = whenIdle,
) {
  let loaded: PageViewModule | null = null;
  let idleScheduled = false;

  const load = () =>
    importPageView().then((module) => {
      loaded = module;
      return module;
    });

  // 読み込み済みなら、then を同期で呼ぶ thenable を返す。lazy はこれを待たずに描画するので、
  // 新規作成の画面を開く操作（openNewPage の flushSync）の中で editor の mount と focus まで済む。
  // Promise を返すと、読み込み済みでも最初の描画が 1 度 suspend し、iOS でキーボードが出ない
  const PageView = lazy((): Promise<PageViewExport> => {
    const ready = loaded;
    if (ready !== null) {
      const thenable: PromiseLike<PageViewExport> = {
        // biome-ignore lint/suspicious/noThenProperty: 同期に解決する thenable がここでの目的
        then: (resolve) => resolve?.({ default: ready.PageView }) as never,
      };
      // lazy が呼ぶのは then だけ
      return thenable as Promise<PageViewExport>;
    }
    return load().then(
      (module) => ({ default: module.PageView }),
      () => ({ default: PageViewLoadFailed }),
    );
  });

  const preload = () => {
    load().catch(() => {});
  };

  return {
    PageView,
    /** 画面が要る前に読み込みを始める。失敗は、画面を出すときの読み込みでもう一度扱う。 */
    preload,
    /** ページの画面に移る URL なら読み込みを始める。アプリの起動時に、/api/me のレスポンスを待たずに始めるために呼ぶ。 */
    preloadFor(route: Route) {
      if (route.name === "page" || route.name === "title" || route.name === "new") preload();
    },
    /**
     * トップや 404 を描き終えたときに呼び、手が空いたときに読み込みを始める。画面の中でページへ移るときに、
     * chunk の取得とページの取得が順に走らないようにする。描き終える前に始めると、一覧の取得と帯域を取り合い、
     * module の評価で一覧の描画も遅れて、トップの LCP が遅れる。何度呼んでも 1 度だけ予約する。
     */
    preloadWhenIdle() {
      if (idleScheduled) return;
      idleScheduled = true;
      scheduleIdle(preload);
    },
  };
}

// requestIdleCallback の無いブラウザ（WebKit など）では、次のフレームの後に回す。timeout が無いと、
// メインスレッドが空かない間は先読みが始まらず、最初にページへ移るときに chunk を待つ
function whenIdle(task: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(task, { timeout: 2000 });
    return;
  }
  requestAnimationFrame(() => setTimeout(task, 0));
}

function PageViewLoadFailed() {
  return (
    <RailLayout rail={null}>
      <Notice inline tone="error" title="画面を読み込めませんでした">
        <p>再読み込みしてください。</p>
      </Notice>
    </RailLayout>
  );
}

const loader = createPageViewLoader(() => import("./PageView"));

export const PageView = loader.PageView;
export const preloadPageView = loader.preload;
export const preloadPageViewFor = loader.preloadFor;
export const preloadPageViewWhenIdle = loader.preloadWhenIdle;
