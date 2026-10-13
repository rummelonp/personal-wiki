import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PageEditor } from "./PageEditor";
import {
  type ApiResult,
  createPage,
  findPageByTitle,
  getPage,
  listBacklinks,
  listPageTitles,
  type Page,
  resolvePages,
  updatePage,
} from "./pages-api";

vi.mock("./pages-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pages-api")>();
  return {
    ...actual,
    getPage: vi.fn(),
    updatePage: vi.fn(),
    setVisibility: vi.fn(),
    deletePage: vi.fn(),
    findPageByTitle: vi.fn(),
    listBacklinks: vi.fn(),
    listPageTitles: vi.fn(),
    resolvePages: vi.fn(),
    createPage: vi.fn(),
  };
});

const ID = "AAAAAAAAAAAAAAAAAAAAAA";
const PAGE: Page = {
  id: ID,
  title: "題",
  body: "本文",
  visibility: "draft",
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};
const BACKUP_KEY = `personal-wiki:draft:${ID}`;

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// vitest の iframe は URL の query で orchestrator と結ばれているので、遷移の試験の後に元へ戻す
const startUrl = location.href;

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  localStorage.clear();
  vi.mocked(updatePage).mockImplementation(async (_id, version, input) =>
    ok({ ...PAGE, ...input, version: version + 1 }),
  );
  vi.mocked(getPage).mockResolvedValue(ok(PAGE));
  vi.mocked(findPageByTitle).mockResolvedValue({ ok: false, reason: "not_found" });
  vi.mocked(listBacklinks).mockResolvedValue(ok({ pages: [], nextCursor: null }));
  vi.mocked(listPageTitles).mockResolvedValue(ok({ pages: [], nextCursor: null }));
  // 既定では、どの link も存在することにして印を付けない
  vi.mocked(resolvePages).mockImplementation(async (titles) =>
    ok(titles.map((title) => ({ id: "B", title, visibility: "draft" as const }))),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  history.replaceState(null, "", startUrl);
});

function renderPage(page: Page = PAGE) {
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  act(() => mounted.render(<PageEditor page={page} />));
  const view = () => {
    // `.cm-content` から探すと、展開した embed の中の view に当たることがある
    const editor = container?.querySelector<HTMLElement>(".cm-editor");
    const found = editor ? EditorView.findFromDOM(editor) : null;
    if (!found) throw new Error("エディタが無い");
    return found;
  };
  const button = (name: string) => {
    const found = [...(container?.querySelectorAll("button") ?? [])].find((b) =>
      b.textContent?.includes(name),
    );
    if (!found) throw new Error(`${name} のボタンが無い`);
    return found;
  };
  return { view, button };
}

function typeAtEnd(view: EditorView, text: string, userEvent = "input.type"): void {
  const end = view.state.doc.length;
  view.dispatch({
    changes: { from: end, insert: text },
    selection: { anchor: end + text.length },
    userEvent,
  });
}

/** React の再描画（useSyncExternalStore の通知は microtask で描く）と、保存の Promise を待つ */
const flushAsync = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

describe("PageEditor と本文のエディタ", () => {
  it("フォーカスが外れたら、入力した本文を保存する", async () => {
    const { view } = renderPage();
    view().focus();
    typeAtEnd(view(), "を書き足す");
    act(() => view().contentDOM.blur());
    await flushAsync();
    expect(updatePage).toHaveBeenCalledWith(
      ID,
      1,
      { title: "題", body: "本文を書き足す" },
      expect.anything(),
    );
  });

  it("変換中にページを離れても、未確定文字まで退避に残す", async () => {
    vi.mocked(updatePage).mockResolvedValue({ ok: false, reason: "error", message: "失敗" });
    const { view } = renderPage();
    const v = view();
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    typeAtEnd(v, "へんかんちゅう", "input.type.compose");
    await flushAsync();

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    const saved = JSON.parse(localStorage.getItem(BACKUP_KEY) ?? "null");
    expect(saved).toMatchObject({ body: "本文へんかんちゅう", baseVersion: 1 });
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await flushAsync();
  });

  it("保存が衝突したら読み取り専用にし、サーバーの版を取り込むと replaceDoc で差し替えて編集に戻す", async () => {
    const server: Page = { ...PAGE, body: "サーバーの本文", version: 2 };
    vi.mocked(updatePage).mockResolvedValue({
      ok: false,
      reason: "version_conflict",
      currentVersion: 2,
    });
    vi.mocked(getPage).mockResolvedValue(ok(server));
    const { view, button } = renderPage();
    const v = view();
    v.focus();
    typeAtEnd(v, "の手元の変更");
    act(() => v.contentDOM.blur());
    await flushAsync();

    expect(v.state.readOnly).toBe(true);
    expect(v.state.doc.toString()).toBe("本文の手元の変更");

    act(() => button("サーバーの版を取り込む").click());
    await flushAsync();
    expect(view()).toBe(v);
    expect(v.state.doc.toString()).toBe("サーバーの本文");
    expect(v.state.readOnly).toBe(false);
  });

  it("サーバーの版を取り込んだ後の undo で、取り込む前の手元の編集を新しい本文から取り消さない", async () => {
    // 別のタブで同じ編集に続けて書き足した版。手元の編集が新しい本文にも残る
    const server: Page = { ...PAGE, body: "本文の手元の変更と別のタブの追記", version: 2 };
    vi.mocked(updatePage).mockResolvedValue({
      ok: false,
      reason: "version_conflict",
      currentVersion: 2,
    });
    vi.mocked(getPage).mockResolvedValue(ok(server));
    const { view, button } = renderPage();
    const v = view();
    v.focus();
    typeAtEnd(v, "の手元の変更");
    act(() => v.contentDOM.blur());
    await flushAsync();
    act(() => button("サーバーの版を取り込む").click());
    await flushAsync();
    expect(v.state.doc.toString()).toBe(server.body);

    const undo = async () => {
      act(() => {
        v.contentDOM.dispatchEvent(
          new InputEvent("beforeinput", { inputType: "historyUndo", cancelable: true }),
        );
      });
      await flushAsync();
    };
    await undo();
    expect(v.state.doc.toString()).toBe(server.body);

    // 取り込んだ後の編集は、同じ操作で取り消せる（undo の操作が届いていることの確認）
    typeAtEnd(v, "!");
    expect(v.state.doc.toString()).toBe(`${server.body}!`);
    await undo();
    expect(v.state.doc.toString()).toBe(server.body);
  });

  it("退避が未決の間は読み取り専用にし、復元すると退避の本文に差し替える", async () => {
    localStorage.setItem(
      BACKUP_KEY,
      JSON.stringify({ title: "題", body: "退避した本文", baseVersion: 1, savedAt: 0 }),
    );
    const { view, button } = renderPage();
    const v = view();
    expect(v.state.readOnly).toBe(true);
    expect(v.state.doc.toString()).toBe("本文");

    act(() => button("復元する").click());
    await flushAsync();
    expect(v.state.doc.toString()).toBe("退避した本文");
    expect(v.state.readOnly).toBe(false);
  });

  it("[[ の title の候補に title の一覧を使う", async () => {
    vi.mocked(listPageTitles).mockResolvedValue(
      ok({
        pages: [{ id: "B", title: "別のページ", visibility: "draft", updatedAt: 0 }],
        nextCursor: null,
      }),
    );
    const { view } = renderPage();
    await flushAsync();
    expect(listPageTitles).toHaveBeenCalledWith(null);

    view().focus();
    typeAtEnd(view(), "\n[[別");
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll(".cm-tooltip-autocomplete li")].map((li) => li.textContent),
      ).toContain("別のページ"),
    );
  });
});

describe("PageEditor の wikilink", () => {
  const clickLink = (text: string) => {
    const link = [...(container?.querySelectorAll(".cm-wikilink") ?? [])].find(
      (e) => e.textContent === text,
    );
    if (!link) throw new Error(`${text} の link が無い`);
    act(() => {
      link.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
  };

  it("存在するページへの link は、クリックでそのページへ SPA 遷移する", async () => {
    vi.mocked(resolvePages).mockImplementation(async (titles) =>
      ok(
        titles.map((title) => ({
          id: "BBBBBBBBBBBBBBBBBBBBBB",
          title,
          visibility: "draft" as const,
        })),
      ),
    );
    renderPage({ ...PAGE, body: "[[別]]" });
    clickLink("別");
    await vi.waitFor(() => expect(location.pathname).toBe("/p/BBBBBBBBBBBBBBBBBBBBBB"));
  });

  it("存在しない title だけに未解決の印を付ける", async () => {
    vi.mocked(resolvePages).mockImplementation(async (titles) =>
      ok(
        titles.map((title) =>
          title === "有る" ? { id: "B", title, visibility: "draft" as const } : null,
        ),
      ),
    );
    renderPage({ ...PAGE, body: "[[有る]] [[無い]]" });
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll(".cm-wikilink-unresolved")].map((e) => e.textContent),
      ).toEqual(["無い"]),
    );
    expect(resolvePages).toHaveBeenCalledTimes(1);
  });

  it("存在の確認が失敗しても、どの link にも印を付けない", async () => {
    vi.mocked(resolvePages).mockResolvedValue({ ok: false, reason: "error", message: "500" });
    renderPage({ ...PAGE, body: "[[無い]]" });
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalled());
    await flushAsync();
    expect(document.querySelectorAll(".cm-wikilink-unresolved")).toHaveLength(0);
  });

  it("無いページの link をクリックすると、作成の案内を出して遷移しない", async () => {
    vi.mocked(resolvePages).mockImplementation(async (titles) => ok(titles.map(() => null)));
    const { button } = renderPage({ ...PAGE, body: "[[無い]]" });
    clickLink("無い");
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("「無い」のページはまだありません"),
    );
    expect(location.pathname).toBe(new URL(startUrl).pathname);

    vi.mocked(createPage).mockResolvedValue(
      ok({ ...PAGE, id: "CCCCCCCCCCCCCCCCCCCCCC", title: "無い", body: "" }),
    );
    act(() => button("作成して開く").click());
    await vi.waitFor(() => expect(location.pathname).toBe("/p/CCCCCCCCCCCCCCCCCCCCCC"));
    expect(createPage).toHaveBeenCalledWith({ title: "無い", body: "" });
  });

  it("作成が title の衝突で失敗したら、できていたページを開く", async () => {
    vi.mocked(resolvePages).mockImplementation(async (titles) => ok(titles.map(() => null)));
    const { button } = renderPage({ ...PAGE, body: "[[無い]]" });
    clickLink("無い");
    await vi.waitFor(() => expect(container?.textContent).toContain("まだありません"));

    vi.mocked(createPage).mockResolvedValue({
      ok: false,
      reason: "title_conflict",
      message: "同じ title のページがすでにある",
    });
    // 衝突の後の再確認は、キャッシュに頼らず取り直した結果を使う
    vi.mocked(resolvePages).mockImplementation(async (titles) =>
      ok(
        titles.map((title) => ({
          id: "DDDDDDDDDDDDDDDDDDDDDD",
          title,
          visibility: "draft" as const,
        })),
      ),
    );
    act(() => button("作成して開く").click());
    await vi.waitFor(() => expect(location.pathname).toBe("/p/DDDDDDDDDDDDDDDDDDDDDD"));
  });

  it("リンク先を調べられなかったときは、無いと言わずに再試行を促す", async () => {
    vi.mocked(resolvePages).mockResolvedValue({ ok: false, reason: "error", message: "500" });
    renderPage({ ...PAGE, body: "[[別]]" });
    clickLink("別");
    await vi.waitFor(() => expect(container?.textContent).toContain("調べられませんでした"));
    expect(container?.textContent).not.toContain("まだありません");
    expect(location.pathname).toBe(new URL(startUrl).pathname);
  });

  it("![[ページ]] を取得した本文で展開する", async () => {
    vi.mocked(findPageByTitle).mockResolvedValue(
      ok({ ...PAGE, id: "BBBBBBBBBBBBBBBBBBBBBB", title: "別", body: "埋め込まれた本文" }),
    );
    renderPage({ ...PAGE, body: "![[別]]" });
    await vi.waitFor(() =>
      expect(container?.querySelector(".cm-embed-page")?.textContent).toContain("埋め込まれた本文"),
    );
  });

  it("![[ページ#見出し]] は取得した本文のうち、その見出しの節だけを展開する", async () => {
    vi.mocked(findPageByTitle).mockResolvedValue(
      ok({
        ...PAGE,
        id: "BBBBBBBBBBBBBBBBBBBBBB",
        title: "別",
        body: "# 一\n\n一の本文\n\n# 二\n\n二の本文\n",
      }),
    );
    renderPage({ ...PAGE, body: "![[別#二]]" });
    await vi.waitFor(() =>
      expect(container?.querySelector(".cm-embed-page")?.textContent).toContain("二の本文"),
    );
    expect(container?.querySelector(".cm-embed-page")?.textContent).not.toContain("一の本文");
    expect(findPageByTitle).toHaveBeenCalledWith("別", expect.anything());
  });

  it("[[ページ#見出し]] のクリックでは、# を切らずに editor が分けた target で引く", async () => {
    vi.mocked(resolvePages).mockImplementation(async (titles) =>
      ok(
        titles.map((title) => ({
          id: "BBBBBBBBBBBBBBBBBBBBBB",
          title,
          visibility: "draft" as const,
        })),
      ),
    );
    renderPage({ ...PAGE, body: "[[別#二]]" });
    clickLink("別#二");
    await vi.waitFor(() => expect(location.pathname).toBe("/p/BBBBBBBBBBBBBBBBBBBBBB"));
    for (const [titles] of vi.mocked(resolvePages).mock.calls) {
      expect(titles).not.toContain("別#二");
      expect(titles).toContain("別");
    }
  });

  it("本文だけの保存では、存在の確認も embed の本文も取り直さない", async () => {
    vi.mocked(findPageByTitle).mockResolvedValue(
      ok({ ...PAGE, id: "BBBBBBBBBBBBBBBBBBBBBB", title: "別", body: "埋め込まれた本文" }),
    );
    const { view } = renderPage({ ...PAGE, body: "[[無い]]\n![[別]]" });
    await vi.waitFor(() => expect(container?.querySelector(".cm-embed-page")).not.toBeNull());
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalledTimes(1));
    expect(findPageByTitle).toHaveBeenCalledTimes(1);

    // autosave は 2 秒ごとに走るので、保存のたびに取り直すと無駄が大きい
    view().focus();
    typeAtEnd(view(), "\n追記");
    act(() => view().contentDOM.blur());
    await vi.waitFor(() => expect(updatePage).toHaveBeenCalledTimes(1));
    // 取り直すなら debounce の後に要求が出る
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(resolvePages).toHaveBeenCalledTimes(1);
    expect(findPageByTitle).toHaveBeenCalledTimes(1);
  });

  it("title を変えて保存したら、存在の確認だけを取り直す", async () => {
    vi.mocked(findPageByTitle).mockResolvedValue(
      ok({ ...PAGE, id: "BBBBBBBBBBBBBBBBBBBBBB", title: "別", body: "埋め込まれた本文" }),
    );
    renderPage({ ...PAGE, body: "[[無い]]\n![[別]]" });
    await vi.waitFor(() => expect(container?.querySelector(".cm-embed-page")).not.toBeNull());
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalledTimes(1));

    const input = container?.querySelector<HTMLInputElement>("input.title-input");
    if (!input) throw new Error("title の入力が無い");
    act(() => input.focus());
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "新しい題",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => input.blur());
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalledTimes(2));
    expect(findPageByTitle).toHaveBeenCalledTimes(1);
  });
});

describe("PageEditor の見出しと block への移動", () => {
  const BODY = "前 [[#節B]] [[#^blk]] [[別#二]]\n\n# 節A\n\n本文\n\n## 節B\n\n段落 ^blk\n";
  const at = (needle: string) => BODY.indexOf(needle);
  const hashOf = (text: string) => `#${encodeURIComponent(text)}`;

  const clickLink = (text: string) => {
    const link = [...(container?.querySelectorAll(".cm-wikilink") ?? [])].find(
      (e) => e.textContent === text,
    );
    if (!link) throw new Error(`${text} の link が無い`);
    act(() => {
      link.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
  };

  beforeEach(() => {
    vi.mocked(resolvePages).mockImplementation(async (titles) =>
      ok(
        titles.map((title) => ({
          id: "BBBBBBBBBBBBBBBBBBBBBB",
          title,
          visibility: "draft" as const,
        })),
      ),
    );
  });

  it("hash が見出しを指すページを開くと、その見出しにカーソルを置く", () => {
    history.replaceState(null, "", `${location.pathname}${hashOf("節B")}`);
    const { view } = renderPage({ ...PAGE, body: BODY });
    expect(view().state.selection.main.head).toBe(at("## 節B"));
    expect(view().hasFocus).toBe(true);
  });

  it("hash が block を指すページを開くと、その段落にカーソルを置く", () => {
    history.replaceState(null, "", `${location.pathname}#%5Eblk`);
    const { view } = renderPage({ ...PAGE, body: BODY });
    expect(view().state.selection.main.head).toBe(at("段落 ^blk"));
  });

  it("見つからない hash では、先頭のままにする", () => {
    history.replaceState(null, "", `${location.pathname}${hashOf("無い")}`);
    const { view } = renderPage({ ...PAGE, body: BODY });
    expect(view().state.selection.main.head).toBe(0);
    expect(container?.querySelector("[role=alert]")).toBeNull();
  });

  it("移動した後に入力しても、カーソルを見出しへ戻さない", async () => {
    history.replaceState(null, "", `${location.pathname}${hashOf("節B")}`);
    const { view } = renderPage({ ...PAGE, body: BODY });
    view().focus();
    typeAtEnd(view(), "追記");
    await flushAsync();
    expect(view().state.selection.main.head).toBe(BODY.length + 2);
  });

  it("同じページの link は遷移もページの問い合わせもせず、その位置へ移る", async () => {
    const { view } = renderPage({ ...PAGE, body: BODY });
    await flushAsync();
    const pathname = location.pathname;
    clickLink("#節B");
    expect(view().state.selection.main.head).toBe(at("## 節B"));
    expect(location.pathname).toBe(pathname);
    expect(location.hash).toBe(hashOf("節B"));
    clickLink("#^blk");
    expect(view().state.selection.main.head).toBe(at("段落 ^blk"));
    expect(findPageByTitle).not.toHaveBeenCalled();
    for (const [titles] of vi.mocked(resolvePages).mock.calls) expect(titles).not.toContain("");
  });

  it("ほかのページの見出しへの link は、遷移先の URL に fragment を付ける", async () => {
    renderPage({ ...PAGE, body: BODY });
    await flushAsync();
    clickLink("別#二");
    await vi.waitFor(() =>
      expect(`${location.pathname}${location.hash}`).toBe(
        `/p/BBBBBBBBBBBBBBBBBBBBBB${hashOf("二")}`,
      ),
    );
  });

  it("link の href にも fragment を付ける", async () => {
    renderPage({ ...PAGE, body: BODY });
    await vi.waitFor(() =>
      expect(
        [...(container?.querySelectorAll("a[href]") ?? [])]
          .filter((a) => a.classList.contains("cm-wikilink"))
          .map((a) => a.getAttribute("href")),
      ).toEqual([hashOf("節B"), "#%5Eblk", `/p/BBBBBBBBBBBBBBBBBBBBBB${hashOf("二")}`]),
    );
  });

  it("戻る・進むで fragment 付きの URL に戻ると、位置を合わせる", async () => {
    const { view } = renderPage({ ...PAGE, body: BODY });
    await flushAsync();
    clickLink("#節B");
    clickLink("#^blk");
    history.back();
    await vi.waitFor(() => expect(view().state.selection.main.head).toBe(at("## 節B")));
    history.forward();
    await vi.waitFor(() => expect(view().state.selection.main.head).toBe(at("段落 ^blk")));
  });
});

describe("PageEditor の「作成して開く」", () => {
  const missingAll = () =>
    vi.mocked(resolvePages).mockImplementation(async (titles) => ok(titles.map(() => null)));
  const clickLink = (text: string) => {
    const link = [...(container?.querySelectorAll(".cm-wikilink") ?? [])].find(
      (e) => e.textContent === text,
    );
    if (!link) throw new Error(`${text} の link が無い`);
    act(() => {
      link.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
  };
  const pending = () => {
    let resolve: (value: ApiResult<Page>) => void = () => {};
    const promise = new Promise<ApiResult<Page>>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const created = (title: string): ApiResult<Page> =>
    ok({ ...PAGE, id: "CCCCCCCCCCCCCCCCCCCCCC", title, body: "" });
  const startPath = new URL(startUrl).pathname;

  async function openCreating(body: string, title: string) {
    missingAll();
    const rendered = renderPage({ ...PAGE, body });
    clickLink(title);
    await vi.waitFor(() => expect(container?.textContent).toContain("まだありません"));
    return rendered;
  }

  it("作成中に同じ link をもう一度押しても、作成の表示を消さず 2 回目の作成もしない", async () => {
    const create = pending();
    vi.mocked(createPage).mockReturnValue(create.promise);
    const { button } = await openCreating("[[無い]]", "無い");
    act(() => button("作成して開く").click());
    await flushAsync();
    expect(button("作成して開く").disabled).toBe(true);

    clickLink("無い");
    await flushAsync();
    expect(button("作成して開く").disabled).toBe(true);
    expect(createPage).toHaveBeenCalledTimes(1);

    await act(async () => create.resolve(created("無い")));
    await vi.waitFor(() => expect(location.pathname).toBe("/p/CCCCCCCCCCCCCCCCCCCCCC"));
  });

  it("作成中に別の link を押したら、作成の応答が来ても遷移しない", async () => {
    const create = pending();
    vi.mocked(createPage).mockReturnValue(create.promise);
    const { button } = await openCreating("[[無い]] [[他]]", "無い");
    act(() => button("作成して開く").click());
    await flushAsync();

    clickLink("他");
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("「他」のページはまだありません"),
    );
    await act(async () => create.resolve(created("無い")));
    await flushAsync();
    expect(location.pathname).toBe(startPath);
    expect(container?.textContent).toContain("「他」のページはまだありません");
  });

  it("作成中にページを離れたら、作成の応答が来ても遷移しない", async () => {
    const create = pending();
    vi.mocked(createPage).mockReturnValue(create.promise);
    const { button } = await openCreating("[[無い]]", "無い");
    act(() => button("作成して開く").click());
    await flushAsync();

    act(() => root?.unmount());
    root = null;
    await act(async () => create.resolve(created("無い")));
    await flushAsync();
    expect(location.pathname).toBe(startPath);
  });

  it("title の衝突の後の再確認中に別の link を押したら、見つかっても遷移しない", async () => {
    const create = pending();
    vi.mocked(createPage).mockReturnValue(create.promise);
    const { button } = await openCreating("[[無い]] [[他]]", "無い");
    act(() => button("作成して開く").click());
    await flushAsync();
    clickLink("他");
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("「他」のページはまだありません"),
    );

    vi.mocked(resolvePages).mockImplementation(async (titles) =>
      ok(
        titles.map((title) => ({
          id: "DDDDDDDDDDDDDDDDDDDDDD",
          title,
          visibility: "draft" as const,
        })),
      ),
    );
    await act(async () =>
      create.resolve({
        ok: false,
        reason: "title_conflict",
        message: "同じ title のページがすでにある",
      }),
    );
    await flushAsync();
    expect(location.pathname).toBe(startPath);
  });
});
