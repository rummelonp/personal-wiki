import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page as browserPage, userEvent } from "vitest/browser";
import { followVisualViewportTop } from "./header-viewport";
import { linkRewrites } from "./link-rewrites";
import { NoticeDockProvider } from "./Notice";
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

function mountEditor({ withDock = false }: { withDock?: boolean } = {}) {
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  const editor = <PageEditor page={PAGE} attachments={false} />;
  act(() => mounted.render(withDock ? <NoticeDockProvider>{editor}</NoticeDockProvider> : editor));
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

describe("キーボードで visual viewport がずれたときの保存の状態", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const run of cleanup.splice(0).reverse()) run();
  });

  it("文書の流れに残り、ヘッダーだけが見える範囲の上端へ動く", async () => {
    await browserPage.viewport(375, 800);
    const viewport = Object.assign(new EventTarget(), {
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
      height: window.innerHeight,
      width: window.innerWidth,
    });
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    cleanup.push(() => {
      if (original) Object.defineProperty(window, "visualViewport", original);
      else Reflect.deleteProperty(window, "visualViewport");
    });
    const header = document.createElement("header");
    header.className = "header";
    document.body.prepend(header);
    cleanup.push(() => header.remove());
    cleanup.push(followVisualViewportTop(header));
    const { query } = mountEditor();
    await flushAsync();

    const offsets = () => {
      const note = query(".note").getBoundingClientRect();
      const state = query(".save-state").getBoundingClientRect();
      return { state: state.top - note.top, bottom: note.top - state.bottom };
    };
    const before = offsets();
    const headerHeight = header.getBoundingClientRect().height;
    expect(header.getBoundingClientRect().top).toBe(0);

    viewport.height = window.innerHeight - 300;
    viewport.offsetTop = 60;
    viewport.dispatchEvent(new Event("scroll"));
    await flushAsync();

    // ヘッダーは見える範囲の上端へ動き、保存の状態は動かない（ヘッダーの裏に回るのは、本文を 60px スクロールしたときと同じ）
    expect(header.getBoundingClientRect().top).toBe(60);
    expect(header.getBoundingClientRect().bottom).toBe(60 + headerHeight);
    expect(offsets().state).toBeCloseTo(before.state, 1);
    expect(offsets().bottom).toBeCloseTo(before.bottom, 1);
  });
});

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

  it("文字が、上のヘッダー（.rail-main の上端）にも下の title にも貼り付かない", async () => {
    await browserPage.viewport(width, 800);
    const { query } = mountEditor();
    await flushAsync();
    const mainTop = query(".rail-main").getBoundingClientRect().top;
    const titleTop = query(".title-input").getBoundingClientRect().top;
    // 箱ではなく、実際に描かれる文字の範囲で測る（箱は余白の高さいっぱいに取る）
    const range = document.createRange();
    range.selectNodeContents(query(".save-state"));
    const glyphs = range.getBoundingClientRect();
    const fontSize = Number.parseFloat(getComputedStyle(query(".save-state")).fontSize);

    // 文字の高さの半分より狭いと、文字が隣の要素に貼り付いて見える
    expect(glyphs.top - mainTop).toBeGreaterThanOrEqual(fontSize / 2);
    expect(titleTop - glyphs.bottom).toBeGreaterThanOrEqual(fontSize / 2);
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

  it("保存の状態の箱は余白の高さに等しく、状態が変わっても title とノートの位置と高さを動かさない", async () => {
    await browserPage.viewport(width, 800);
    let finish: (value: ApiResult<Page>) => void = () => {};
    vi.mocked(updatePage).mockImplementationOnce(
      () => new Promise<ApiResult<Page>>((resolve) => (finish = resolve)),
    );
    const { query, body } = mountEditor({ withDock: true });
    await flushAsync();
    const padTop = Number.parseFloat(getComputedStyle(query(".rail-main")).paddingTop);

    const measure = () => {
      const main = query(".rail-main").getBoundingClientRect();
      const title = query(".title-input").getBoundingClientRect();
      const note = query(".note").getBoundingClientRect();
      const state = query(".save-state").getBoundingClientRect();
      return {
        titleOffset: title.top - note.top,
        titleHeight: title.height,
        noteOffset: note.top - main.top,
        stateOffset: state.top - note.top,
        stateHeight: state.height,
      };
    };
    const saved = measure();
    // 箱は余白の高さいっぱいに取る。文字の高さに合わせると、状態の入れ替わりで箱が伸び縮みする
    expect(saved.stateHeight).toBeCloseTo(padTop, 1);
    expect(saved.stateOffset + saved.stateHeight).toBeCloseTo(0, 1);

    body().focus();
    const end = body().state.doc.length;
    body().dispatch({
      changes: { from: end, insert: "追記" },
      selection: { anchor: end + 2 },
      userEvent: "input.type",
    });
    await flushAsync();
    expect(query(".save-state").className).toContain("save-state-unsaved");
    const unsaved = measure();

    act(() => body().contentDOM.blur());
    await flushAsync();
    expect(query(".save-state").className).toContain("save-state-saving");
    const saving = measure();

    await act(async () => finish({ ok: false, reason: "error", message: "失敗" }));
    await flushAsync();
    expect(query(".save-state").className).toContain("save-state-error");
    const failed = measure();
    // 失敗の通知はドックに出て、ノートの流れに行を足さない
    expect(query(".notice-dock .notice-error")).toBeTruthy();

    // スクロールで画面上の位置は動くので、ノートの上端を基準にした位置で比べる
    for (const state of [unsaved, saving, failed]) {
      expect(state.titleOffset).toBeCloseTo(saved.titleOffset, 1);
      expect(state.titleHeight).toBeCloseTo(saved.titleHeight, 1);
      expect(state.noteOffset).toBeCloseTo(saved.noteOffset, 1);
      expect(state.stateOffset).toBeCloseTo(saved.stateOffset, 1);
      expect(state.stateHeight).toBeCloseTo(saved.stateHeight, 1);
    }
  });

  // ポインタの移動は 1 回ごとに Playwright を往復する。ほかのプロセスが CPU を使っていると長くかかり、
  // 既定の 15 秒では足りない。途中で打ち切られるとポインタが欄の上に残り、次のテストが落ちる
  it("title 欄の下線は欄の内側の下端に文字の左端から引かれ、保存の状態の下にあり、欄の高さを動かさない", async () => {
    await browserPage.viewport(width, 800);
    const { query } = mountEditor();
    await flushAsync();
    const input = query(".title-input");
    const inset = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--editor-line-inset"),
    );
    const borderWidth = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--border-width"),
    );
    // 色は token 経由で解決した値と比べる
    const colorOf = (token: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      input.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const underline = () => getComputedStyle(input, "::after");

    const resting = input.getBoundingClientRect();
    // 下線の分の高さを padding で取り、下線は欄の内側の下端に収まる。外へはみ出すと CodeMirror が
    // 欄をスクロールの箱とみなし、ヘッダーを避ける余白を切り落とす
    expect(Number.parseFloat(getComputedStyle(input).paddingBottom)).toBeCloseTo(borderWidth, 1);
    expect(underline().position).toBe("absolute");
    expect(Number.parseFloat(underline().borderBottomWidth)).toBeCloseTo(borderWidth, 1);
    expect(Number.parseFloat(underline().bottom)).toBe(0);
    expect(Number.parseFloat(underline().left)).toBeCloseTo(inset, 1);
    expect(Number.parseFloat(underline().right)).toBe(0);
    expect(input.scrollHeight).toBeLessThanOrEqual(input.clientHeight);
    // 文字の左端（列の線）から欄の右端まで引く
    expect(Number.parseFloat(underline().width)).toBeCloseTo(resting.width - inset, 1);
    // 下線は、ノートの上の余白にある保存の状態より下にある
    expect(query(".save-state").getBoundingClientRect().bottom).toBeLessThanOrEqual(
      resting.bottom - borderWidth + 0.5,
    );

    // ポインタは前のテストが置いた位置に残る。その下に欄が載ると :hover が付いたまま始まるので、
    // 最初に欄の外へ動かす。unhover は body の中心へ動かす実装で、中心が欄の外にある保証が無いので使わない。
    // 欄の上端は 1px より下にあり、(1, 1) は欄の外になる。body は余白の分だけ内側から始まる場合があり、
    // その隅への hover は hit target の確認で待ち続けるので force で確認を省く
    expect(resting.top).toBeGreaterThan(1);
    const pointerAway = () =>
      userEvent.hover(document.body, { position: { x: 1, y: 1 }, force: true });
    // :hover はポインタが動いた後のフレームで更新されるので、値になるまで待つ
    const underlineColor = () => expect.poll(() => underline().borderBottomColor);

    // 何もしていない間は見えず、hover と focus で区切り線の色になる。どちらでも欄の高さは変わらない
    await pointerAway();
    await underlineColor().toBe("rgba(0, 0, 0, 0)");
    await userEvent.hover(input, { force: true });
    await underlineColor().toBe(colorOf("--color-border"));
    expect(input.getBoundingClientRect().height).toBeCloseTo(resting.height, 1);
    await pointerAway();
    await underlineColor().toBe("rgba(0, 0, 0, 0)");

    act(() => EditorView.findFromDOM(query(".title-input .cm-editor"))?.focus());
    expect(underline().borderBottomColor).toBe(colorOf("--color-border"));
    expect(input.getBoundingClientRect().height).toBeCloseTo(resting.height, 1);
    expect(input.getBoundingClientRect().top).toBeCloseTo(resting.top, 1);
  }, 60_000);
});
