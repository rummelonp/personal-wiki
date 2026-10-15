import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CreateEditorOptions, createEditor } from "./create-editor";
import { type LinkActivation, linkActivator } from "./link-activation";
import type { TagHref } from "./tag";
import type { WikiLinkHref } from "./wikilink";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc: string, options: Omit<CreateEditorOptions, "doc"> = {}): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, { doc, ...options });
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

const pageHref: WikiLinkHref = (link) =>
  `/proj/${encodeURIComponent(link.target)}${link.blockId === null ? "" : `?blockId=${link.blockId}`}`;

function anchorFor(v: EditorView, selector: string): HTMLAnchorElement {
  const element = v.contentDOM.querySelector(selector);
  if (!(element instanceof HTMLAnchorElement)) {
    throw new Error(`${selector} is not an <a>: ${element?.tagName ?? "(missing)"}`);
  }
  return element;
}

function click(element: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent(init.button === 1 ? "auxclick" : "click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  element.dispatchEvent(event);
  return event;
}

/** 起動先を観測する。facet に値があると `<a>` への synthetic click は起きない */
function captureActivations(): { extension: Extension; seen: LinkActivation[] } {
  const seen: LinkActivation[] = [];
  return { extension: linkActivator.of((activation) => seen.push(activation)), seen };
}

describe("WikiLink anchor", () => {
  it("renders the link as an <a> pointing at the host url", () => {
    const v = mount("前 [[Some Page]] 後", { hrefForWikiLink: pageHref });
    const link = anchorFor(v, '[data-wikilink-target="Some Page"]');
    expect(link.getAttribute("href")).toBe("/proj/Some%20Page");
    expect(link.textContent).toBe("Some Page");
  });

  it("carries the block id in the url", () => {
    const v = mount("前 [[Some Page^abc123]] 後", { hrefForWikiLink: pageHref });
    const link = anchorFor(v, '[data-wikilink-target="Some Page"]');
    expect(link.getAttribute("href")).toBe("/proj/Some%20Page?blockId=abc123");
  });

  it("is not draggable, so selecting across the link does not move the text", () => {
    const v = mount("前 [[Some Page]] 後", { hrefForWikiLink: pageHref });
    expect(anchorFor(v, '[data-wikilink-target="Some Page"]').getAttribute("draggable")).toBe(
      "false",
    );
  });

  it("stays an <a> in a read-only view (embeds and viewers link out too)", () => {
    const v = mount("前 [[Some Page]] 後", {
      hrefForWikiLink: pageHref,
      readOnly: true,
      readOnlyFocusable: false,
    });
    expect(anchorFor(v, '[data-wikilink-target="Some Page"]').getAttribute("href")).toBe(
      "/proj/Some%20Page",
    );
  });

  it("keeps the decoration without an <a> when the host gives no url", () => {
    const v = mount("前 [[Some Page]] 後");
    const link = v.contentDOM.querySelector('[data-wikilink-target="Some Page"]');
    expect(link?.tagName).toBe("SPAN");
    expect(link?.hasAttribute("href")).toBe(false);
  });
});

describe("tag anchor", () => {
  const tagHref: TagHref = (tag) => `/?tag=${encodeURIComponent(tag.name)}`;

  it("renders the tag as a non-draggable <a> pointing at the host url", () => {
    const v = mount("本文 #仕事 です", { hrefForTag: tagHref });
    const tag = anchorFor(v, ".cm-tag");
    expect(tag.getAttribute("href")).toBe(`/?tag=${encodeURIComponent("仕事")}`);
    expect(tag.getAttribute("draggable")).toBe("false");
    expect(tag.textContent).toBe("#仕事");
    // `<a>` にしたことで乗るブラウザ既定の下線は付けない
    expect(getComputedStyle(tag).textDecorationLine).toBe("none");
  });

  it("keeps the tag without an <a> when the host gives no url", () => {
    const v = mount("本文 #仕事 です");
    const tag = v.contentDOM.querySelector(".cm-tag");
    expect(tag?.tagName).toBe("SPAN");
    expect(tag?.hasAttribute("href")).toBe(false);
  });

  it("sends a modified click and a middle click to the activator", () => {
    const { extension, seen } = captureActivations();
    const onTagClick = vi.fn();
    const v = mount("本文 #仕事 です", { hrefForTag: tagHref, onTagClick, extensions: extension });
    const tag = anchorFor(v, ".cm-tag");
    tag.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, metaKey: true }),
    );
    click(tag, { metaKey: true });
    click(tag, { button: 1 });

    expect(onTagClick).not.toHaveBeenCalled();
    expect(seen.map(({ href, newTab }) => ({ href, newTab }))).toEqual([
      { href: new URL(`/?tag=${encodeURIComponent("仕事")}`, location.href).href, newTab: false },
      { href: new URL(`/?tag=${encodeURIComponent("仕事")}`, location.href).href, newTab: true },
    ]);
  });

  it("leaves a plain click to the tag handler and stops the native follow", () => {
    const { extension, seen } = captureActivations();
    const onTagClick = vi.fn();
    const v = mount("本文 #仕事 です", { hrefForTag: tagHref, onTagClick, extensions: extension });
    const tag = anchorFor(v, ".cm-tag");
    tag.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    const event = click(tag);

    expect(onTagClick).toHaveBeenCalledExactlyOnceWith({ name: "仕事" });
    expect(seen).toHaveLength(0);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("external link anchors", () => {
  it("renders a markdown link as an <a> that opens in a new tab", () => {
    const v = mount("[リンク](https://example.com/path)");
    const link = anchorFor(v, ".cm-md-link");
    expect(link.getAttribute("href")).toBe("https://example.com/path");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("gives a markdown link with a disallowed scheme no href at all", () => {
    const v = mount('[リンク](javascript:alert("x"))');
    const link = v.contentDOM.querySelector(".cm-md-link");
    expect(link?.tagName).toBe("SPAN");
    expect(link?.hasAttribute("href")).toBe(false);
  });

  it("renders a bare url as an <a>", () => {
    const v = mount("前 https://example.com/path 後");
    const link = anchorFor(v, ".cm-autolink");
    expect(link.textContent).toBe("https://example.com/path");
    expect(link.getAttribute("href")).toBe("https://example.com/path");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("renders an angle bracket autolink as an <a> without the brackets in the url", () => {
    const v = mount("前 <https://example.com/path> 後");
    expect(anchorFor(v, ".cm-autolink").getAttribute("href")).toBe("https://example.com/path");
  });

  it("leaves the url of a markdown link undecorated (live-preview.ts owns it)", () => {
    const v = mount("[リンク](https://example.com/path)");
    expect(v.contentDOM.querySelector(".cm-autolink")).toBeNull();
  });
});

describe("link activation", () => {
  it("sends a modified click to the activator instead of navigating in place", () => {
    const { extension, seen } = captureActivations();
    const onWikiLinkClick = vi.fn();
    const v = mount("前 [[Some Page]] 後", {
      hrefForWikiLink: pageHref,
      onWikiLinkClick,
      extensions: extension,
    });
    const link = anchorFor(v, '[data-wikilink-target="Some Page"]');
    link.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, metaKey: true }),
    );
    click(link, { metaKey: true });

    expect(onWikiLinkClick).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.href).toBe(`${window.location.origin}/proj/Some%20Page`);
    expect(seen[0]?.newTab).toBe(false);
    expect(seen[0]?.event.metaKey).toBe(true);
  });

  it("leaves a plain click to the wikilink handler", () => {
    const { extension, seen } = captureActivations();
    const onWikiLinkClick = vi.fn();
    const v = mount("前 [[Some Page]] 後", {
      hrefForWikiLink: pageHref,
      onWikiLinkClick,
      extensions: extension,
    });
    const link = anchorFor(v, '[data-wikilink-target="Some Page"]');
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    const event = click(link);

    expect(onWikiLinkClick).toHaveBeenCalledWith({
      target: "Some Page",
      label: null,
      blockId: null,
      heading: null,
    });
    expect(seen).toHaveLength(0);
    // 素のクリックでも native の追従は止める（readonly な view と埋め込みでの二重遷移を防ぐ）
    expect(event.defaultPrevented).toBe(true);
  });

  it("asks for a new tab on a middle click", () => {
    const { extension, seen } = captureActivations();
    const v = mount("前 [[Some Page]] 後", { hrefForWikiLink: pageHref, extensions: extension });
    click(anchorFor(v, '[data-wikilink-target="Some Page"]'), { button: 1 });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.newTab).toBe(true);
  });

  it("reports a new tab for external links, which open there by default", () => {
    const { extension, seen } = captureActivations();
    const v = mount("[リンク](https://example.com/path)", { extensions: extension });
    click(anchorFor(v, ".cm-md-link"), { shiftKey: true });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.href).toBe("https://example.com/path");
    expect(seen[0]?.newTab).toBe(true);
    expect(seen[0]?.event.shiftKey).toBe(true);
  });

  /**
   * 既定の起動先（`dispatchToHiddenAnchor`）だけは facet を差し替えずに見る。
   * synthetic click は bubbles しないので、capture で受けて `preventDefault` し、
   * 実際の遷移とタブの生成を止めたうえで `<a>` の状態を読む。
   */
  function captureHiddenAnchor(): { anchors: HTMLAnchorElement[]; dispose: () => void } {
    const anchors: HTMLAnchorElement[] = [];
    const listener = (event: Event) => {
      const target = event.target;
      // editor 内の `<a>` への click（この test が自分で送るもの）は数えない
      if (!(target instanceof HTMLAnchorElement) || target.parentElement !== document.body) return;
      anchors.push(target);
      event.preventDefault();
    };
    document.addEventListener("click", listener, true);
    return { anchors, dispose: () => document.removeEventListener("click", listener, true) };
  }

  it("reuses one hidden <a> and drops the previous target on the next activation", () => {
    const { anchors, dispose } = captureHiddenAnchor();
    try {
      const v = mount("前 [[Some Page]] 後", { hrefForWikiLink: pageHref });
      const link = anchorFor(v, '[data-wikilink-target="Some Page"]');
      click(link, { button: 1 });
      click(link, { metaKey: true });

      expect(anchors).toHaveLength(2);
      // 作り直さない（外すと Chromium が download を捨てる。link-activation.ts 参照）
      expect(anchors[1]).toBe(anchors[0]);
      expect(anchors[0]?.isConnected).toBe(true);
      // 中クリックで付いた target を、次の修飾クリックへ持ち越さない
      expect(anchors[1]?.getAttribute("target")).toBeNull();
    } finally {
      dispose();
    }
  });

  it("does not open a new window on a modified click of an external link", () => {
    const { extension } = captureActivations();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const v = mount("[リンク](https://example.com/path)", { extensions: extension });
    const link = anchorFor(v, ".cm-md-link");
    link.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, metaKey: true }),
    );

    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
