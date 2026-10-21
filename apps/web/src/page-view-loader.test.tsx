import { act, type ComponentProps, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPageViewLoader } from "./page-view-loader";
import { parseRoute } from "./route";

type Loader = ReturnType<typeof createPageViewLoader>;
type PageViewProps = ComponentProps<Loader["PageView"]>;

const PROPS: PageViewProps = { target: { by: "id", id: "A" }, owner: false, attachments: false };

const stubModule = {
  PageView: ({ owner }: PageViewProps) => <p>ページの画面 {owner ? "owner" : "reader"}</p>,
};

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const text = () => container?.textContent ?? "";
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

function mount(loader: Loader, props: PageViewProps = PROPS) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  show(loader, props);
}

function show(loader: Loader, props: PageViewProps = PROPS) {
  act(() =>
    root?.render(
      <Suspense fallback={<p>読み込み中</p>}>
        <loader.PageView {...props} />
      </Suspense>,
    ),
  );
}

describe("読み込みの開始", () => {
  it("作っただけでは読み込まず、ページの画面に移る URL なら preloadFor ですぐ始める", () => {
    const importPageView = vi.fn(async () => stubModule);
    const scheduleIdle = vi.fn();
    const loader = createPageViewLoader(importPageView, scheduleIdle);
    expect(importPageView).not.toHaveBeenCalled();

    for (const [pathname, search] of [
      ["/p/AAAAAAAAAAAAAAAAAAAAAA", ""],
      ["/タイトル", ""],
      ["/", "?new"],
    ]) {
      importPageView.mockClear();
      loader.preloadFor(parseRoute(pathname ?? "", search ?? ""));
      expect(importPageView).toHaveBeenCalledTimes(1);
    }
    expect(scheduleIdle).not.toHaveBeenCalled();
  });

  it("トップと 404 では preloadFor が読み込まず、preloadWhenIdle が手が空いたときの読み込みを 1 度だけ予約する", () => {
    const importPageView = vi.fn(async () => stubModule);
    const idleTasks: (() => void)[] = [];
    const loader = createPageViewLoader(importPageView, (task) => idleTasks.push(task));

    loader.preloadFor(parseRoute("/", ""));
    loader.preloadFor(parseRoute("/p/short", ""));
    expect(idleTasks).toHaveLength(0);

    loader.preloadWhenIdle();
    loader.preloadWhenIdle();
    expect(importPageView).not.toHaveBeenCalled();
    expect(idleTasks).toHaveLength(1);

    idleTasks[0]?.();
    expect(importPageView).toHaveBeenCalledTimes(1);
  });

  it("読み込み済みなら、最初の描画で suspend せずに画面を出す", async () => {
    const loader = createPageViewLoader(async () => stubModule);
    loader.preload();
    await settle();
    mount(loader);
    expect(text()).toBe("ページの画面 reader");
  });
});

describe("読み込みの失敗", () => {
  function failingOnce() {
    const importPageView = vi.fn(async (): Promise<typeof stubModule> => {
      throw new Error("chunk を取得できなかった");
    });
    return {
      loader: createPageViewLoader(importPageView),
      importPageView,
    };
  }

  it("失敗したら、再読み込みを促す通知を出す", async () => {
    const { loader } = failingOnce();
    mount(loader);
    await settle();
    expect(text()).toContain("画面を読み込めませんでした");
  });

  it("失敗の通知が出ている間に再描画しても、読み込み直さない", async () => {
    const { loader, importPageView } = failingOnce();
    mount(loader);
    await settle();
    show(loader, { ...PROPS, owner: true });
    await settle();
    expect(importPageView).toHaveBeenCalledTimes(1);
    expect(text()).toContain("画面を読み込めませんでした");
  });
});
