import { EditorView } from "@codemirror/view";
import { isCompositionUnsettled } from "@personal-wiki/editor";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page as browserPage } from "vitest/browser";
import { BodyEditor } from "./BodyEditor";
import { bodyScrollAnchor } from "./body-scroll-anchor";
import "./theme.css";
import "./styles.css";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  // 前のテストの合わせ直しを止め、listener を次のテストへ残さない
  window.dispatchEvent(new Event("keydown"));
  vi.restoreAllMocks();
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  window.scrollTo(0, 0);
});

const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

const doc = Array.from({ length: 120 }, (_, i) => `段落 ${i}\n`).join("\n");

async function mountBody() {
  await browserPage.viewport(375, 600);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <>
        <header className="header">
          <span className="brand">personal-wiki</span>
        </header>
        <article className="note">
          <BodyEditor value={doc} readOnly={false} />
        </article>
      </>,
    ),
  );
  const dom = container.querySelector<HTMLElement>(".body-editor .cm-editor");
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (view === null) throw new Error("本文の view が無い");
  await frame();
  const headerBottom = () =>
    container?.querySelector("header.header")?.getBoundingClientRect().bottom ?? 0;
  return { view, headerBottom };
}

describe("本文の行で位置を読み書きする", () => {
  it("ヘッダーの下端に見えている行を読み、離れた後でも同じ位置へ戻す", async () => {
    const { view, headerBottom } = await mountBody();
    window.scrollTo(0, 1500);
    await frame();
    const source = bodyScrollAnchor(view);
    const anchor = source.read();
    if (anchor === null) throw new Error("行が読めない");
    expect(view.state.doc.lineAt(anchor.offset).from).toBe(anchor.offset);

    window.scrollTo(0, 0);
    await frame();
    expect(source.apply(anchor)).toBe(true);
    await vi.waitFor(() => {
      const rect = view.coordsAtPos(anchor.offset, 1);
      expect(Math.abs((rect?.top ?? Number.NaN) - headerBottom() - anchor.delta)).toBeLessThan(1.5);
    });
  });

  it("本文の先頭付近（上端がヘッダーの下）では行を読まない", async () => {
    const { view } = await mountBody();
    expect(bodyScrollAnchor(view).read()).toBeNull();
  });

  it("範囲の外の offset は、本文の中へ丸めて戻す", async () => {
    const { view } = await mountBody();
    const source = bodyScrollAnchor(view);
    expect(source.apply({ offset: view.state.doc.length + 1000, delta: 0 })).toBe(true);
    await vi.waitFor(() => expect(window.scrollY).toBeGreaterThan(1000));
    expect(source.apply({ offset: -50, delta: 0 })).toBe(true);
    await vi.waitFor(() => expect(window.scrollY).toBeLessThan(100));
  });
});

describe("変換が落ち着く前", () => {
  it("落ち着くまで測らず、行を返さない", async () => {
    const { view } = await mountBody();
    window.scrollTo(0, 1500);
    await frame();
    const source = bodyScrollAnchor(view);
    const before = source.read();
    expect(before).not.toBeNull();

    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    window.scrollTo(0, 2500);
    await frame();
    const lineBlock = vi.spyOn(view, "lineBlockAtHeight");
    const coords = vi.spyOn(view, "coordsAtPos");
    expect(source.read()).toBeNull();
    expect(lineBlock).not.toHaveBeenCalled();
    expect(coords).not.toHaveBeenCalled();

    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    expect(isCompositionUnsettled(view)).toBe(true);
    expect(source.read()).toBeNull();
    expect(lineBlock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(isCompositionUnsettled(view)).toBe(false));
    const after = source.read();
    expect(after).not.toBeNull();
    expect(after).not.toEqual(before);
    expect(lineBlock).toHaveBeenCalled();
  });

  it("落ち着くまで行へ移さず、落ち着いた後に移す", async () => {
    const { view } = await mountBody();
    const source = bodyScrollAnchor(view);
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(source.apply({ offset: view.state.doc.length, delta: 0 })).toBe(true);
    await frame();
    await frame();
    expect(window.scrollY).toBe(0);

    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(window.scrollY).toBeGreaterThan(1000));
  });

  it("落ち着く前に利用者の操作で止めたら、落ち着いた後も移さない", async () => {
    const { view } = await mountBody();
    const source = bodyScrollAnchor(view);
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    source.apply({ offset: view.state.doc.length, delta: 0 });
    window.dispatchEvent(new Event("wheel"));

    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(isCompositionUnsettled(view)).toBe(false));
    await frame();
    await frame();
    expect(window.scrollY).toBe(0);
  });
});

describe("合わせ直し", () => {
  afterEach(() => {
    document.documentElement.style.overflowAnchor = "";
  });

  it("移した後に本文より上の高さが変わったら、行を元の位置へ合わせ直す", async () => {
    // ブラウザの scroll anchoring が補うと、合わせ直しが無くても行が動かず確かめられない
    document.documentElement.style.overflowAnchor = "none";
    const { view, headerBottom } = await mountBody();
    const source = bodyScrollAnchor(view);
    const offset = view.state.doc.line(100).from;
    const delta = 30;
    const lineOffsetFromTarget = () =>
      (view.coordsAtPos(offset, 1)?.top ?? Number.NaN) - headerBottom() - delta;
    source.apply({ offset, delta });
    await vi.waitFor(() => expect(Math.abs(lineOffsetFromTarget())).toBeLessThan(1.5));

    const note = document.querySelector<HTMLElement>("article.note");
    if (note === null) throw new Error("article.note が無い");
    note.style.paddingTop = "200px";
    await vi.waitFor(() => expect(Math.abs(lineOffsetFromTarget())).toBeLessThan(1.5));
  });
});

describe("合わせ直しの停止", () => {
  it("移した後に利用者がスクロールしたら、画面の高さが変わっても奪い返さない", async () => {
    const { view } = await mountBody();
    const source = bodyScrollAnchor(view);
    const offset = view.state.doc.line(100).from;
    source.apply({ offset, delta: 0 });
    await vi.waitFor(() => expect(window.scrollY).toBeGreaterThan(1000));
    // 自分が移した直後（OWN_MOVE_MS）のスクロールは操作とみなされないので、それが過ぎるまで待つ
    await new Promise((resolve) => setTimeout(resolve, 400));

    window.scrollTo(0, 0);
    await frame();
    await frame();
    const note = document.querySelector<HTMLElement>("article.note");
    if (note === null) throw new Error("article.note が無い");
    // 高さを変えて ResizeObserver を起こす
    note.style.paddingTop = "40px";
    await frame();
    await frame();
    expect(window.scrollY).toBeLessThan(100);
  });
});
