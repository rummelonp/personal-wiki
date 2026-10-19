import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { discardInitialPage, readInitialPage } from "./initial-page";
import { PageView } from "./PageView";
import { forgetTitles, rememberTitle } from "./page-titles";
import { type ApiResult, findPageByTitle, getPage, type Page } from "./pages-api";

vi.mock("./pages-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pages-api")>();
  return { ...actual, getPage: vi.fn(), findPageByTitle: vi.fn() };
});

type Shown = (page: Pick<Page, "id" | "title" | "visibility">) => void;

/** 表示を伝える時機をテストが決められるよう、onShown を受け取るだけの読み取りの画面にする */
let shown: Shown | null = null;
vi.mock("./PageReader", () => ({
  PageReader: ({ onShown }: { onShown?: Shown }) => {
    shown = onShown ?? null;
    return <p className="reader-stub">本文</p>;
  },
}));

const PAGE: Page = {
  id: "AAAAAAAAAAAAAAAAAAAAAA",
  title: "公開の題",
  body: "本文",
  visibility: "public",
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const startUrl = location.href;

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  shown = null;
  vi.mocked(getPage).mockResolvedValue(ok(PAGE));
  vi.mocked(findPageByTitle).mockResolvedValue(ok(PAGE));
});

afterEach(() => {
  discardInitialPage();
  document.getElementById("initial-page")?.remove();
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  history.replaceState(null, "", startUrl);
  vi.clearAllMocks();
});

async function openById(): Promise<Shown> {
  history.replaceState(null, "", `/p/${PAGE.id}`);
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  await act(async () =>
    mounted.render(
      <PageView target={{ by: "id", id: PAGE.id }} owner={false} attachments={false} />,
    ),
  );
  const onShown = shown;
  if (onShown === null) throw new Error("読み取りの画面が描かれていない");
  return onShown;
}

describe("PageView の URL の置き換え", () => {
  it("開いた URL のままなら、正の URL に置き換える", async () => {
    const onShown = await openById();
    act(() => onShown(PAGE));
    expect(location.pathname).toBe(`/${encodeURIComponent(PAGE.title)}`);
  });

  it("置き換えた後に title が変わったら、新しい正の URL に置き換える", async () => {
    const onShown = await openById();
    act(() => onShown(PAGE));
    // アドレスバーはもう開いた URL（/p/<id>）ではないが、自分が置き換えた URL なので追従する
    act(() => onShown({ ...PAGE, title: "新しい題" }));
    expect(location.pathname).toBe(`/${encodeURIComponent("新しい題")}`);
  });

  it("表示を伝える前に戻るで一覧へ移っていたら、一覧の URL を置き換えない", async () => {
    const onShown = await openById();
    // 戻るの popstate を受けて描き直すより先に、子の effect が届いた状況
    history.replaceState(null, "", "/?tag=x");
    act(() => onShown(PAGE));
    expect(`${location.pathname}${location.search}`).toBe("/?tag=x");
  });
});

describe("PageView が伝える開いているページの id", () => {
  async function renderWith(
    target: Parameters<typeof PageView>[0]["target"],
    onOpenPage: (id: string | null) => void,
  ) {
    container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    await act(async () =>
      mounted.render(
        <PageView target={target} owner={false} attachments={false} onOpenPage={onOpenPage} />,
      ),
    );
  }

  it("表示を伝えられたページの id を伝え、取得中は null のままにする", async () => {
    history.replaceState(null, "", `/p/${PAGE.id}`);
    const onOpenPage = vi.fn();
    await renderWith({ by: "id", id: PAGE.id }, onOpenPage);
    expect(onOpenPage).toHaveBeenLastCalledWith(null);
    act(() => shown?.(PAGE));
    expect(onOpenPage).toHaveBeenLastCalledWith(PAGE.id);
  });

  it("title が変わっても、同じページの id を伝え続ける", async () => {
    history.replaceState(null, "", `/p/${PAGE.id}`);
    const onOpenPage = vi.fn();
    await renderWith({ by: "id", id: PAGE.id }, onOpenPage);
    act(() => shown?.(PAGE));
    act(() => shown?.({ ...PAGE, title: "新しい題" }));
    expect(onOpenPage).toHaveBeenLastCalledWith(PAGE.id);
  });

  it("画面を離れたら null を伝える", async () => {
    history.replaceState(null, "", `/p/${PAGE.id}`);
    const onOpenPage = vi.fn();
    await renderWith({ by: "id", id: PAGE.id }, onOpenPage);
    act(() => shown?.(PAGE));
    act(() => root?.unmount());
    root = null;
    expect(onOpenPage).toHaveBeenLastCalledWith(null);
  });
});

describe("PageView の取得中の title", () => {
  const noteTitle = () => container?.querySelector(".note-title")?.textContent;

  async function render(target: Parameters<typeof PageView>[0]["target"]) {
    container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    await act(async () =>
      mounted.render(<PageView target={target} owner={false} attachments={false} />),
    );
  }

  beforeEach(() => {
    forgetTitles();
    // 取得が終わらない間の画面を見る
    vi.mocked(getPage).mockReturnValue(new Promise(() => {}));
  });

  it("id で開くとき、覚えていた title をスケルトンに文字で出す", async () => {
    rememberTitle(PAGE.id, "覚えた題");
    await render({ by: "id", id: PAGE.id });
    expect(noteTitle()).toBe("覚えた題");
    expect(container?.querySelector(".note[aria-busy='true']")).not.toBeNull();
  });

  it("id で開くとき、覚えていなければ title のスケルトンを出す", async () => {
    await render({ by: "id", id: PAGE.id });
    expect(noteTitle()).toBe("");
    expect(container?.querySelector(".note-title .skeleton")).not.toBeNull();
  });

  it("forgetTitles の後は、覚えていた title を出さない", async () => {
    rememberTitle(PAGE.id, "覚えた題");
    forgetTitles();
    await render({ by: "id", id: PAGE.id });
    expect(noteTitle()).toBe("");
  });
});

describe("PageView の取得の失敗", () => {
  it("再読み込みで取り直し、届いたらページを出す", async () => {
    vi.mocked(getPage).mockResolvedValueOnce({
      ok: false,
      reason: "error",
      message: "時間をおいて、もう一度試してください。",
    });
    history.replaceState(null, "", `/p/${PAGE.id}`);
    container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    await act(async () =>
      mounted.render(
        <PageView target={{ by: "id", id: PAGE.id }} owner={false} attachments={false} />,
      ),
    );
    const reload = () =>
      [...(container?.querySelectorAll<HTMLButtonElement>(".notice button") ?? [])].find(
        (b) => b.textContent === "再読み込み",
      );
    await vi.waitFor(() => expect(reload()).toBeDefined());
    expect(container.textContent).toContain("ページを取得できませんでした");
    await act(async () => reload()?.click());
    await vi.waitFor(() => expect(container?.querySelector(".reader-stub")).not.toBeNull());
    expect(getPage).toHaveBeenCalledTimes(2);
  });
});

describe("PageView の HTML に入っていたページ", () => {
  type Target = Parameters<typeof PageView>[0]["target"];

  /** Worker が head に入れる要素を置き、起動時と同じく読み込ませる。 */
  function embed(page: unknown, text = JSON.stringify(page)) {
    const script = document.createElement("script");
    script.type = "application/json";
    script.id = "initial-page";
    script.textContent = text;
    document.head.append(script);
    readInitialPage("navigate");
  }

  async function mount(target: Target, { strict = false } = {}) {
    container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    const view = <PageView target={target} owner={false} attachments={false} />;
    await act(async () => mounted.render(strict ? <StrictMode>{view}</StrictMode> : view));
    return mounted;
  }

  const readerShown = () => container?.querySelector(".reader-stub") !== null;

  it("id でも title でも、URL と同じページなら取得せずに出す", async () => {
    for (const [path, target] of [
      [`/p/${PAGE.id}`, { by: "id", id: PAGE.id }],
      [`/${encodeURIComponent(PAGE.title)}`, { by: "title", title: PAGE.title }],
    ] as const) {
      history.replaceState(null, "", path);
      embed(PAGE);
      await mount(target);
      expect(readerShown(), path).toBe(true);
      act(() => root?.unmount());
      container?.remove();
    }
    expect(getPage).not.toHaveBeenCalled();
    expect(findPageByTitle).not.toHaveBeenCalled();
  });

  it("StrictMode で描画と effect が 2 度動いても取得しない", async () => {
    history.replaceState(null, "", `/p/${PAGE.id}`);
    embed(PAGE);
    await mount({ by: "id", id: PAGE.id }, { strict: true });
    expect(readerShown()).toBe(true);
    expect(getPage).not.toHaveBeenCalled();
  });

  it("別のページのものか、壊れているときは取得する", async () => {
    for (const text of [JSON.stringify({ ...PAGE, id: "BBBBBBBBBBBBBBBBBBBBBB" }), "{"]) {
      history.replaceState(null, "", `/p/${PAGE.id}`);
      embed(null, text);
      await mount({ by: "id", id: PAGE.id });
      await vi.waitFor(() => expect(readerShown(), text).toBe(true));
      expect(getPage, text).toHaveBeenCalledWith(PAGE.id);
      act(() => root?.unmount());
      container?.remove();
      vi.mocked(getPage).mockClear();
    }
  });

  it("使った後に同じページへ戻ったときと、作り直した画面では取得する", async () => {
    history.replaceState(null, "", `/p/${PAGE.id}`);
    embed(PAGE);
    const mounted = await mount({ by: "id", id: PAGE.id });
    expect(getPage).not.toHaveBeenCalled();

    const other = "BBBBBBBBBBBBBBBBBBBBBB";
    history.pushState(null, "", `/p/${other}`);
    const render = (id: string) =>
      act(async () =>
        mounted.render(<PageView target={{ by: "id", id }} owner={false} attachments={false} />),
      );
    await render(other);
    expect(getPage).toHaveBeenLastCalledWith(other);
    history.pushState(null, "", `/p/${PAGE.id}`);
    await render(PAGE.id);
    expect(getPage).toHaveBeenLastCalledWith(PAGE.id);

    // ログイン状態が変わって key で作り直すときも、捨てた後なので取得する
    act(() => mounted.unmount());
    container?.remove();
    vi.mocked(getPage).mockClear();
    await mount({ by: "id", id: PAGE.id });
    expect(getPage).toHaveBeenCalledWith(PAGE.id);
  });
});
