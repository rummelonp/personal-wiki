import { EditorView } from "@codemirror/view";
import { MAX_BODY_BYTES, MAX_TITLE_BYTES } from "@personal-wiki/domain/page-input";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page as browserPage } from "vitest/browser";
import { METER_SHOW_RATIO } from "./InputMeter";
import { linkRewrites } from "./link-rewrites";
import { PageEditor } from "./PageEditor";
import {
  type ApiResult,
  findPageByTitle,
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

function mountEditor(page = PAGE) {
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  act(() => mounted.render(<PageEditor page={page} attachments={false} />));
  const query = (selector: string) => {
    const found = container?.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`${selector} が無い`);
    return found;
  };
  const viewOf = (selector: string) => {
    const found = EditorView.findFromDOM(query(selector));
    if (!found) throw new Error(`${selector} の view が無い`);
    return found;
  };
  const replace = (view: EditorView, text: string) =>
    act(() => {
      view.focus();
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: text.length },
        userEvent: "input.type",
      });
    });
  return {
    query,
    title: () => viewOf(".title-input .cm-editor"),
    body: () => viewOf(".body-editor .cm-editor"),
    replace,
  };
}

const colorOf = (token: string) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
};

const noHorizontalScroll = () =>
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

describe.each([320, 375, 768])("入力の長さの表示（%dpx）", (width) => {
  it("title の案内は欄の下の余白に収まり、出ても公開の行と本文を動かさない", async () => {
    await browserPage.viewport(width, 800);
    const { query, title, replace } = mountEditor();
    await flushAsync();
    // title の行数は文字を足すと変わりうるので、欄の下端から公開の行までの間を比べる
    const gap = () =>
      query(".publish-bar").getBoundingClientRect().top -
      query(".title-input").getBoundingClientRect().bottom;
    const base = "あ".repeat(Math.ceil((MAX_TITLE_BYTES * 0.8) / 3) - 2);
    replace(title(), base);
    expect(query(".title-hint").textContent).toBe("");
    const before = gap();

    replace(title(), `${base}#|`.padEnd(base.length + 4, "a"));
    const hint = query(".title-hint");
    expect(hint.textContent).toContain("を含むタイトルには、[[ ]] でリンクできません。");
    expect(hint.querySelector(".input-meter")).not.toBeNull();
    expect(gap()).toBeCloseTo(before, 0);

    const field = query(".title-input").getBoundingClientRect();
    const rect = hint.getBoundingClientRect();
    const note = query(".note").getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(field.bottom - 0.5);
    expect(rect.bottom).toBeLessThanOrEqual(
      query(".publish-bar").getBoundingClientRect().top + 0.5,
    );
    expect(rect.right).toBeLessThanOrEqual(note.right + 0.5);
    // 狭い幅で省略するのは左の文だけで、長さの数は切らない
    const meter = query(".title-hint .input-meter");
    expect(meter.getBoundingClientRect().right).toBeLessThanOrEqual(rect.right + 0.5);
    expect(meter.scrollWidth).toBeLessThanOrEqual(meter.clientWidth + 1);
    noHorizontalScroll();
  });

  it("title を空にしたときの案内は、前の title が長くても 1 行の帯に収まる", async () => {
    await browserPage.viewport(width, 800);
    const { query, title, replace } = mountEditor({ ...PAGE, title: "長い題".repeat(40) });
    await flushAsync();
    const gap = () =>
      query(".publish-bar").getBoundingClientRect().top -
      query(".title-input").getBoundingClientRect().bottom;
    // 長い title は折り返して行が増えるので、案内の出ない 1 行の title と比べる
    replace(title(), "a");
    expect(query(".title-hint").textContent).toBe("");
    const before = gap();
    replace(title(), "");
    act(() => title().contentDOM.blur());
    await flushAsync();
    const hint = query(".title-hint");
    expect(hint.textContent).toContain("空のタイトルは保存しません。");
    const rect = hint.getBoundingClientRect();
    expect(rect.right).toBeLessThanOrEqual(query(".note").getBoundingClientRect().right + 0.5);
    expect(rect.bottom).toBeLessThanOrEqual(
      query(".publish-bar").getBoundingClientRect().top + 0.5,
    );
    expect(gap()).toBeCloseTo(before, 0);
    noHorizontalScroll();
  });

  it("本文の長さは本文の下の右端に出て、超えたら赤くなり、保存の状態も赤くなる", async () => {
    await browserPage.viewport(width, 800);
    const { query, body, replace } = mountEditor();
    await flushAsync();
    const meter = () => query(".body-meter .input-meter");
    expect(container?.querySelector(".body-meter")).toBeNull();

    replace(body(), "a".repeat(Math.ceil(MAX_BODY_BYTES * METER_SHOW_RATIO) - 1));
    await flushAsync();
    expect(container?.querySelector(".body-meter")).toBeNull();

    replace(body(), "a".repeat(Math.ceil(MAX_BODY_BYTES * METER_SHOW_RATIO)));
    await flushAsync();
    expect(meter().className).toContain("input-meter-normal");
    expect(getComputedStyle(meter()).color).toBe(colorOf("--color-fg-muted"));

    replace(body(), "a".repeat(Math.ceil(MAX_BODY_BYTES * 0.9)));
    await flushAsync();
    expect(meter().className).toContain("input-meter-near");
    expect(getComputedStyle(meter()).color).toBe(colorOf("--color-fg"));

    replace(body(), "a".repeat(MAX_BODY_BYTES + 1));
    await flushAsync();
    expect(meter().className).toContain("input-meter-over");
    expect(getComputedStyle(meter()).color).toBe(colorOf("--color-danger"));
    expect(query(".save-state").className).toContain("save-state-invalid");
    expect(getComputedStyle(query(".save-state")).color).toBe(colorOf("--color-danger"));

    const note = query(".note").getBoundingClientRect();
    const editor = query(".body-editor").getBoundingClientRect();
    const rect = meter().getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(editor.bottom - 0.5);
    expect(rect.right).toBeLessThanOrEqual(note.right + 0.5);
    expect(rect.right).toBeGreaterThan(note.right - 4);
    expect(meter().scrollWidth).toBeLessThanOrEqual(meter().clientWidth + 1);
    noHorizontalScroll();
  });
});
