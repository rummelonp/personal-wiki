import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page as browserPage } from "vitest/browser";
import { linkRewrites } from "./link-rewrites";
import { PageEditor } from "./PageEditor";
import {
  type ApiResult,
  findPageByTitle,
  getPage,
  listBacklinks,
  listPageTitles,
  listRevisions,
  type Page,
  resolvePages,
  updatePage,
} from "./pages-api";
import "./theme.css";
import "./styles.css";

vi.mock("./link-rewrites-api", () => ({ stepLinkRewrites: vi.fn() }));

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
    listRevisions: vi.fn(),
    listPageTitles: vi.fn(),
    resolvePages: vi.fn(),
    createPage: vi.fn(),
  };
});

const PAGE: Page = {
  id: "AAAAAAAAAAAAAAAAAAAAAA",
  title: "題",
  body: "本文",
  visibility: "draft",
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};

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
  vi.mocked(findPageByTitle).mockResolvedValue({ ok: false, reason: "not_found" });
  vi.mocked(listBacklinks).mockResolvedValue(ok({ pages: [], nextCursor: null }));
  vi.mocked(listRevisions).mockResolvedValue(ok({ revisions: [], nextCursor: null }));
  vi.mocked(listPageTitles).mockResolvedValue(ok({ pages: [], nextCursor: null }));
  vi.mocked(resolvePages).mockImplementation(async (titles) =>
    ok(titles.map((title) => ({ id: "B", title, visibility: "draft" as const }))),
  );
});

afterEach(() => {
  linkRewrites.stop();
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

const flushAsync = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

function mountEditor() {
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  act(() => mounted.render(<PageEditor page={PAGE} attachments={false} />));
  const query = (selector: string) => {
    const found = container?.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`${selector} が無い`);
    return found;
  };
  const body = () => {
    const found = EditorView.findFromDOM(query(".body-editor .cm-editor"));
    if (!found) throw new Error("本文の view が無い");
    return found;
  };
  return { query, body };
}

describe.each([375, 1024])("保存の状態の置き場所（%dpx）", (width) => {
  it("title を下げる行を取らず、ノートの上の余白に収まる", async () => {
    await browserPage.viewport(width, 800);
    const { query } = mountEditor();
    await flushAsync();
    const main = query(".rail-main").getBoundingClientRect();
    const padTop = Number.parseFloat(getComputedStyle(query(".rail-main")).paddingTop);
    const note = query(".note").getBoundingClientRect();
    const state = query(".save-state").getBoundingClientRect();
    const title = query(".title-input").getBoundingClientRect();

    // title はノートの先頭に来る（保存の状態の行が上に挟まらない）
    expect(title.top).toBeLessThanOrEqual(note.top + 1);
    expect(note.top).toBeCloseTo(main.top + padTop, 0);
    // 保存の状態は、ノートの上の余白の中で右端に寄る
    expect(state.top).toBeGreaterThanOrEqual(main.top - 0.5);
    expect(state.bottom).toBeLessThanOrEqual(note.top + 0.5);
    expect(state.right).toBeLessThanOrEqual(note.right + 0.5);
    expect(state.right).toBeGreaterThan(note.right - 160);
  });

  it("未保存、保存中、失敗のどれでも、余白の中で読める大きさのまま出る", async () => {
    await browserPage.viewport(width, 800);
    let finish: (value: ApiResult<Page>) => void = () => {};
    vi.mocked(updatePage).mockImplementationOnce(
      () => new Promise<ApiResult<Page>>((resolve) => (finish = resolve)),
    );
    const { query, body } = mountEditor();
    await flushAsync();

    const within = () => {
      const note = query(".note").getBoundingClientRect();
      const state = query(".save-state").getBoundingClientRect();
      expect(state.width).toBeGreaterThan(0);
      expect(state.top).toBeLessThan(note.top);
      expect(state.bottom).toBeLessThanOrEqual(note.top + 0.5);
      // 文字が余白からはみ出して切れない
      const text = query(".save-state");
      expect(text.scrollHeight).toBeLessThanOrEqual(text.clientHeight + 1);
    };

    body().focus();
    const end = body().state.doc.length;
    body().dispatch({
      changes: { from: end, insert: "追記" },
      selection: { anchor: end + 2 },
      userEvent: "input.type",
    });
    await flushAsync();
    expect(query(".save-state").className).toContain("save-state-unsaved");
    within();

    act(() => body().contentDOM.blur());
    await flushAsync();
    expect(query(".save-state").className).toContain("save-state-saving");
    within();

    await act(async () => finish({ ok: false, reason: "error", message: "失敗" }));
    await flushAsync();
    expect(query(".save-state").className).toContain("save-state-error");
    expect(query(".save-state").textContent).toContain("保存に失敗");
    within();
    // 失敗は、余白の文字だけでなく、本文の上の通知でも伝える
    expect(query(".notice-error, .notice-warn")).toBeTruthy();
    const probe = document.createElement("span");
    probe.style.color = "var(--color-danger)";
    query(".note").append(probe);
    expect(getComputedStyle(query(".save-state")).color).toBe(getComputedStyle(probe).color);
    probe.remove();
  });

  it("最も長い文言（衝突）でも、ノートの幅と画面の幅からはみ出さず、同時に出る通知の注意の色にそろう", async () => {
    await browserPage.viewport(width, 800);
    vi.mocked(updatePage).mockResolvedValue({
      ok: false,
      reason: "version_conflict",
      currentVersion: 2,
    });
    vi.mocked(getPage).mockResolvedValue(ok({ ...PAGE, body: "サーバーの本文", version: 2 }));
    const { query, body } = mountEditor();
    await flushAsync();
    body().focus();
    const end = body().state.doc.length;
    body().dispatch({
      changes: { from: end, insert: "追記" },
      selection: { anchor: end + 2 },
      userEvent: "input.type",
    });
    act(() => body().contentDOM.blur());
    await flushAsync();

    const state = query(".save-state");
    expect(state.className).toContain("save-state-conflict");
    expect(state.textContent).toContain("別の場所でも更新あり");
    const note = query(".note").getBoundingClientRect();
    const rect = state.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(note.left - 0.5);
    expect(rect.right).toBeLessThanOrEqual(note.right + 0.5);
    expect(state.scrollWidth).toBeLessThanOrEqual(state.clientWidth + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

    // 同時に出る通知は warn。状態の行も赤にせず、点だけを通知の枠と同じ注意の色にする
    const notice = query(".notice-warn");
    expect(getComputedStyle(query(".save-state-conflict .dot")).backgroundColor).toBe(
      getComputedStyle(notice).borderTopColor,
    );
    const probe = document.createElement("span");
    probe.style.color = "var(--color-fg)";
    query(".note").append(probe);
    expect(getComputedStyle(state).color).toBe(getComputedStyle(probe).color);
    probe.remove();
  });
});
