import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PageEditor } from "./PageEditor";
import {
  type ApiResult,
  findPageByTitle,
  getPage,
  listBacklinks,
  listRecent,
  type Page,
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
    listRecent: vi.fn(),
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
  vi.mocked(listRecent).mockResolvedValue(ok({ pages: [], nextCursor: null }));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

function renderPage(page: Page = PAGE) {
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  act(() => mounted.render(<PageEditor page={page} />));
  const view = () => {
    const content = container?.querySelector<HTMLElement>(".cm-content");
    const found = content ? EditorView.findFromDOM(content) : null;
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

  it("[[ の title の候補に最近の更新の一覧を使う", async () => {
    vi.mocked(listRecent).mockResolvedValue(
      ok({
        pages: [{ id: "B", title: "別のページ", visibility: "draft", updatedAt: 0, tags: [] }],
        nextCursor: null,
      }),
    );
    const { view } = renderPage();
    await flushAsync();
    expect(listRecent).toHaveBeenCalledWith(null, { limit: 100 });

    view().focus();
    typeAtEnd(view(), "\n[[別");
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll(".cm-tooltip-autocomplete li")].map((li) => li.textContent),
      ).toContain("別のページ"),
    );
  });
});
