import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PageReader } from "./PageReader";
import {
  type ApiResult,
  createPage,
  findPageByTitle,
  listBacklinks,
  type Page,
  resolvePages,
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

const PAGE: Page = {
  id: "AAAAAAAAAAAAAAAAAAAAAA",
  title: "公開の題",
  body: "本文 #タグ\n\n[[有る]] [[無い]]",
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
  vi.mocked(listBacklinks).mockResolvedValue(ok({ pages: [], nextCursor: null }));
  // 匿名には draft が null で届くので、「無い」は存在しないページと draft のどちらでもありうる
  vi.mocked(resolvePages).mockImplementation(async (titles) =>
    ok(
      titles.map((title) =>
        title === "有る"
          ? { id: "BBBBBBBBBBBBBBBBBBBBBB", title, visibility: "public" as const }
          : null,
      ),
    ),
  );
  vi.mocked(findPageByTitle).mockResolvedValue({ ok: false, reason: "not_found" });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  history.replaceState(null, "", startUrl);
});

function renderReader(page: Page = PAGE, onShown?: Parameters<typeof PageReader>[0]["onShown"]) {
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  act(() => mounted.render(<PageReader page={page} onShown={onShown} />));
  const view = () => {
    const editor = container?.querySelector<HTMLElement>(".cm-editor");
    const found = editor ? EditorView.findFromDOM(editor) : null;
    if (!found) throw new Error("エディタが無い");
    return found;
  };
  return { view };
}

const buttonTexts = () =>
  [...(container?.querySelectorAll("button") ?? [])].map((b) => b.textContent ?? "");

const clickLink = (text: string) => {
  const link = [...(container?.querySelectorAll(".cm-wikilink") ?? [])].find(
    (e) => e.textContent === text,
  );
  if (!link) throw new Error(`${text} の link が無い`);
  act(() => {
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  });
};

const flushAsync = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

describe("PageReader", () => {
  it("本文を読み取り専用で出し、owner の操作を出さない", async () => {
    const { view } = renderReader();
    await flushAsync();
    expect(view().state.readOnly).toBe(true);
    expect(container?.querySelector("input")).toBeNull();
    expect(container?.querySelector("h1")?.textContent).toBe("公開の題");
    for (const label of ["新規", "公開", "下書き", "削除", "保存"]) {
      expect(buttonTexts().some((text) => text.includes(label))).toBe(false);
    }
  });

  it("タグを一覧への link で出す", () => {
    renderReader();
    const tag = [...(container?.querySelectorAll("a.chip-link") ?? [])].find(
      (a) => a.textContent === "タグ",
    );
    expect(tag?.getAttribute("href")).toBe(`/?tag=${encodeURIComponent("タグ")}`);
  });

  it("表示したページを onShown で伝える", () => {
    const onShown = vi.fn();
    renderReader(PAGE, onShown);
    expect(onShown).toHaveBeenCalledWith({
      id: PAGE.id,
      title: PAGE.title,
      visibility: "public",
    });
  });

  it("公開されたページへの link だけを /<title> の <a href> にする", async () => {
    renderReader();
    await vi.waitFor(() =>
      expect(
        [...(container?.querySelectorAll("a[href]") ?? [])]
          .map((a) => a.getAttribute("href"))
          .filter((href) => href !== null && !href.startsWith("/?")),
      ).toEqual([`/${encodeURIComponent("有る")}`]),
    );
    expect(
      [...document.querySelectorAll(".cm-wikilink-unresolved")].map((e) => e.textContent),
    ).toEqual(["無い"]);
  });

  it("公開されたページへの link のクリックで /<title> へ遷移する", async () => {
    renderReader();
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalled());
    await flushAsync();
    clickLink("有る");
    await vi.waitFor(() => expect(location.pathname).toBe(`/${encodeURIComponent("有る")}`));
  });

  it("開けない link は「ページはありません」とだけ出し、作成の操作を出さない", async () => {
    renderReader();
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalled());
    await flushAsync();
    clickLink("無い");
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("「無い」のページはありません"),
    );
    expect(container?.textContent).not.toContain("下書き");
    expect(buttonTexts()).toEqual(["閉じる"]);
    expect(location.pathname).toBe(new URL(startUrl).pathname);
    expect(createPage).not.toHaveBeenCalled();
  });
});
