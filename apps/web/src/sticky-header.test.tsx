import type { EditorView } from "@codemirror/view";
import { createTitleEditor } from "@personal-wiki/editor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusAndRevealCaret } from "./focus-reveal";
import { scrollBelowStickyHeaderWith, scrollTopMargin, stickyHeaderBottom } from "./sticky-header";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});

const HEADER_HEIGHT = 60;
const SCROLL_Y = 500;

/** 画面の上端に固定した `header.header` を足す。ヘッダーの下端は HEADER_HEIGHT になる */
function mountHeader(): void {
  const header = document.createElement("header");
  header.className = "header";
  header.style.cssText = `position: fixed; top: 0; left: 0; right: 0; height: ${HEADER_HEIGHT}px`;
  document.body.append(header);
  cleanup.push(() => header.remove());
}

/**
 * viewport の上端から `top` の位置に title の欄を置く。ページを SCROLL_Y だけ下げた状態にして、
 * 上へスクロールする余地を残す。extraTop が null のときは sticky-header の extension を付けない
 */
function mountTitleEditor(
  extraTop: ((view: EditorView) => number) | null,
  top: number,
): EditorView {
  const page = document.createElement("div");
  page.style.cssText = `height: 4000px; padding-top: ${SCROLL_Y + top}px`;
  const host = document.createElement("div");
  page.append(host);
  document.body.append(page);
  window.scrollTo(0, SCROLL_Y);
  const view = createTitleEditor(host, {
    doc: "title",
    extensions: extraTop === null ? [] : scrollBelowStickyHeaderWith(extraTop),
  });
  cleanup.push(() => {
    window.scrollTo(0, 0);
    view.destroy();
    page.remove();
  });
  return view;
}

describe("scrollTopMargin", () => {
  it("is 0 without a header or an extraTop", () => {
    const view = mountTitleEditor(null, 100);
    expect(stickyHeaderBottom()).toBe(0);
    expect(scrollTopMargin(view)).toBe(0);
  });

  it("returns the bottom of the sticky header when the extension has no extraTop", () => {
    mountHeader();
    const view = mountTitleEditor(() => 0, 100);
    expect(scrollTopMargin(view)).toBe(HEADER_HEIGHT);
  });

  it("adds the extraTop read from the facet to the bottom of the sticky header", () => {
    mountHeader();
    const view = mountTitleEditor(() => 40, 100);
    expect(scrollTopMargin(view)).toBe(HEADER_HEIGHT + 40);
  });

  it("calls extraTop with the view each time instead of caching the first value", () => {
    mountHeader();
    let extraTop = 10;
    const read = vi.fn((_view: EditorView) => extraTop);
    const view = mountTitleEditor(read, 100);
    expect(scrollTopMargin(view)).toBe(HEADER_HEIGHT + 10);
    extraTop = 25;
    expect(scrollTopMargin(view)).toBe(HEADER_HEIGHT + 25);
    expect(read).toHaveBeenCalledWith(view);
  });
});

describe("focusAndRevealCaret with a sticky header", () => {
  /** カーソルの行はヘッダーの下に出ているが、extraTop の帯には入っている位置 */
  const TOP_IN_EXTRA_BAND = HEADER_HEIGHT + 10;

  it("scrolls a caret that sits in the extraTop band below the header", async () => {
    mountHeader();
    const view = mountTitleEditor(() => 40, TOP_IN_EXTRA_BAND);
    focusAndRevealCaret(view);
    await vi.waitFor(() => expect(window.scrollY).toBeLessThan(SCROLL_Y));
  });

  it("does not scroll the same caret when the extraTop is 0", async () => {
    mountHeader();
    const view = mountTitleEditor(() => 0, TOP_IN_EXTRA_BAND);
    focusAndRevealCaret(view);
    // 保留した処理が走る時間を取る。task を 1 つ挟んだ後に 2 フレーム進める
    await new Promise<void>((resolve) =>
      setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 0),
    );
    expect(window.scrollY).toBe(SCROLL_Y);
  });
});
