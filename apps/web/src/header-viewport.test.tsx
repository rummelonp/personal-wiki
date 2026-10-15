import { afterEach, describe, expect, it } from "vitest";
import { followVisualViewportTop } from "./header-viewport";
import { stickyHeaderBottom } from "./sticky-header";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});

/** iOS のキーボードの高さ。visual viewport はこの分だけ縮む。 */
const KEYBOARD = 300;

function fakeViewport(initial: { offsetTop?: number; scale?: number; height?: number } = {}) {
  const viewport = Object.assign(new EventTarget(), {
    offsetTop: 0,
    offsetLeft: 0,
    scale: 1,
    height: window.innerHeight,
    width: window.innerWidth,
    ...initial,
  });
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  cleanup.push(() => {
    if (original) Object.defineProperty(window, "visualViewport", original);
    else Reflect.deleteProperty(window, "visualViewport");
  });
  return viewport;
}

function mountHeader(): HTMLElement {
  const page = document.createElement("div");
  page.style.cssText = "height: 3000px";
  const header = document.createElement("header");
  header.className = "header";
  header.style.cssText = "position: sticky; top: 0; height: 48px";
  page.append(header);
  document.body.append(page);
  cleanup.push(() => page.remove());
  return header;
}

describe("followVisualViewportTop", () => {
  it("keeps the header at the top of the visual viewport when the keyboard shifts it down", () => {
    const viewport = fakeViewport();
    const header = mountHeader();
    cleanup.push(followVisualViewportTop(header));
    expect(header.getBoundingClientRect().top).toBe(0);

    // キーボードが出て、見える範囲が layout viewport の 40px から下になる
    viewport.height = window.innerHeight - KEYBOARD;
    viewport.offsetTop = 40;
    viewport.dispatchEvent(new Event("scroll"));
    expect(header.getBoundingClientRect().top).toBe(40);
    // 補完の窓の上限と本文のスクロールの余白は、ずらした後の下端を基準にする
    expect(stickyHeaderBottom()).toBe(40 + 48);

    viewport.height = window.innerHeight;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("resize"));
    expect(header.getBoundingClientRect().top).toBe(0);
  });

  it("does not follow the offset of a bounce at the end of the document", () => {
    const viewport = fakeViewport();
    const header = mountHeader();
    cleanup.push(followVisualViewportTop(header));
    viewport.offsetTop = 180;
    viewport.dispatchEvent(new Event("scroll"));
    expect(header.getBoundingClientRect().top).toBe(0);
  });

  it("does not follow while the page is pinch-zoomed", () => {
    const viewport = fakeViewport({ offsetTop: 40, scale: 2, height: window.innerHeight / 2 });
    const header = mountHeader();
    cleanup.push(followVisualViewportTop(header));
    expect(header.getBoundingClientRect().top).toBe(0);
    viewport.scale = 1;
    viewport.height = window.innerHeight - KEYBOARD;
    viewport.dispatchEvent(new Event("resize"));
    expect(header.getBoundingClientRect().top).toBe(40);
  });

  it("restores the header and stops listening when released", () => {
    const viewport = fakeViewport({ offsetTop: 40, height: window.innerHeight - KEYBOARD });
    const header = mountHeader();
    const release = followVisualViewportTop(header);
    expect(header.getBoundingClientRect().top).toBe(40);
    release();
    expect(header.getBoundingClientRect().top).toBe(0);
    viewport.offsetTop = 60;
    viewport.dispatchEvent(new Event("scroll"));
    expect(header.getBoundingClientRect().top).toBe(0);
  });
});
