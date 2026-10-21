import type { EditorView } from "@codemirror/view";
import { createTitleEditor } from "@personal-wiki/editor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusAndRevealCaret } from "./focus-reveal";

const cleanup: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const run of cleanup.splice(0).reverse()) run();
});

/** 画面の下に外れた位置に title の欄を置く。カーソルの行が見えていないので、focus を移すとスクロールを要する */
function mountBelowFold(): { view: EditorView; other: HTMLInputElement } {
  const page = document.createElement("div");
  page.style.cssText = "height: 4000px; padding-top: 3000px";
  const host = document.createElement("div");
  const other = document.createElement("input");
  page.append(host, other);
  document.body.append(page);
  const view = createTitleEditor(host, { doc: "title" });
  cleanup.push(() => {
    window.scrollTo(0, 0);
    view.destroy();
    page.remove();
  });
  return { view, other };
}

/** scrollIntoView は次の measure で動くので、動くまで待つ */
const scrolled = () => vi.waitFor(() => expect(window.scrollY).toBeGreaterThan(0));

/**
 * スクロールが起きないことを確かめる前に、保留した処理が走る時間を取る。時間だけの待ちは、rAF が
 * 間引かれて measure が来る前に抜けると、guard が無くても通る。task を 1 つ挟んだ後に 2 フレーム進める
 */
const settle = () =>
  new Promise<void>((resolve) =>
    setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 0),
  );

describe("focusAndRevealCaret", () => {
  it("scrolls to a caret that is out of view", async () => {
    const { view } = mountBelowFold();
    focusAndRevealCaret(view);
    await scrolled();
  });

  it("scrolls even when the window is in the background, as long as the view holds the focus", async () => {
    const { view } = mountBelowFold();
    // 窓が背面のとき、view.hasFocus は false になる
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    focusAndRevealCaret(view);
    expect(view.root.activeElement).toBe(view.contentDOM);
    expect(view.hasFocus).toBe(false);
    await scrolled();
  });

  it("does not scroll a held reveal after the focus has moved to another element", async () => {
    const { view, other } = mountBelowFold();
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    focusAndRevealCaret(view);
    other.focus({ preventScroll: true });
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await settle();
    expect(document.activeElement).toBe(other);
    expect(window.scrollY).toBe(0);
  });

  it("scrolls a held reveal once the composition settles while the view still holds the focus", async () => {
    const { view } = mountBelowFold();
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    focusAndRevealCaret(view);
    expect(window.scrollY).toBe(0);
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await scrolled();
  });
});
