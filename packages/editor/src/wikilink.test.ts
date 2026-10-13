import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "./create-editor";

const DOC = "前置き [[Amazon Web Services|AWS]] と [[日本語ページ]] の後ろ\n\n2 行目";
const LINK = "[[Amazon Web Services|AWS]]";
const linkFrom = DOC.indexOf(LINK);
const linkTo = linkFrom + LINK.length;

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc = DOC): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, { doc });
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

/** CodeMirror が描いた、画面に見えている 1 行目のテキスト */
const firstLineText = (v: EditorView) => v.contentDOM.querySelector(".cm-line")?.textContent ?? "";

const placeCursor = (v: EditorView, pos: number) => {
  v.focus();
  v.dispatch({ selection: EditorSelection.cursor(pos) });
};

describe("WikiLink decoration", () => {
  it("shows only the label while the editor is not focused", () => {
    const v = mount();
    expect(v.hasFocus).toBe(false);
    const text = firstLineText(v);
    expect(text).toContain("前置き AWS と");
    expect(text).not.toContain("[[");
    expect(text).not.toContain("Amazon Web Services");
    // label 無しの link は target を残して括弧だけ消える
    expect(text).toContain(" 日本語ページ ");
  });

  it("keeps the document text intact while hiding markup", () => {
    const v = mount();
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it("marks the link with its target for navigation", () => {
    const v = mount();
    const link = v.contentDOM.querySelector('[data-wikilink-target="Amazon Web Services"]');
    expect(link?.getAttribute("data-wikilink-label")).toBe("AWS");
  });

  it("marks the link with its block id when the target references one", () => {
    const doc = "前置き [[Target^someBlockId]] の後ろ";
    const v = mount(doc);
    const link = v.contentDOM.querySelector('[data-wikilink-target="Target"]');
    expect(link?.getAttribute("data-wikilink-block-id")).toBe("someBlockId");
  });

  it("does not set a block id attribute when the target has none", () => {
    const v = mount();
    const link = v.contentDOM.querySelector('[data-wikilink-target="Amazon Web Services"]');
    expect(link?.hasAttribute("data-wikilink-block-id")).toBe(false);
  });

  it("reveals the source when the cursor enters the link", () => {
    const v = mount();
    placeCursor(v, linkFrom + 4);
    expect(v.hasFocus).toBe(true);
    expect(firstLineText(v)).toContain(LINK);
  });

  it("reveals the source when the cursor sits right after the link", () => {
    const v = mount();
    placeCursor(v, linkTo);
    expect(firstLineText(v)).toContain(LINK);
  });

  it("collapses back once the cursor leaves the link", () => {
    const v = mount();
    placeCursor(v, linkFrom + 4);
    expect(firstLineText(v)).toContain(LINK);
    placeCursor(v, DOC.length);
    const text = firstLineText(v);
    expect(text).toContain("前置き AWS と");
    expect(text).not.toContain("Amazon Web Services");
  });

  it("collapses when the editor loses focus even if the cursor stays inside", async () => {
    const v = mount();
    placeCursor(v, linkFrom + 4);
    expect(firstLineText(v)).toContain(LINK);
    v.contentDOM.blur();
    expect(v.hasFocus).toBe(false);
    // CodeMirror は blur を少し遅らせてから focusChanged の update を流す
    await vi.waitFor(() => expect(firstLineText(v)).not.toContain("Amazon Web Services"));
  });

  it("reveals a link touched by any selection range, not just the main one", () => {
    host = document.createElement("div");
    document.body.append(host);
    view = createEditor(host, {
      doc: DOC,
      extensions: EditorState.allowMultipleSelections.of(true),
    });
    const v = view;
    v.focus();
    v.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.cursor(DOC.length), EditorSelection.cursor(linkFrom + 3)],
        0,
      ),
    });
    expect(firstLineText(v)).toContain(LINK);
  });
});

describe("unresolved link styling", () => {
  function mountWithResolver(doc: string, resolve: (target: string) => boolean): EditorView {
    host = document.createElement("div");
    document.body.append(host);
    view = createEditor(host, { doc, resolveWikiLink: resolve });
    return view;
  }

  it("does not mark a link as unresolved when no resolver is configured", () => {
    const v = mount("[[Anything]]");
    const link = v.contentDOM.querySelector('[data-wikilink-target="Anything"]');
    expect(link?.className).not.toContain("cm-wikilink-unresolved");
  });

  it("marks a link as unresolved when the resolver reports no match", () => {
    const v = mountWithResolver("[[存在しないページ]]", () => false);
    const link = v.contentDOM.querySelector('[data-wikilink-target="存在しないページ"]');
    expect(link?.className).toContain("cm-wikilink-unresolved");
  });

  it("does not mark a link as unresolved when the resolver reports a match", () => {
    const v = mountWithResolver("[[既存ページ]]", (target) => target === "既存ページ");
    const link = v.contentDOM.querySelector('[data-wikilink-target="既存ページ"]');
    expect(link?.className).not.toContain("cm-wikilink-unresolved");
  });

  it("applies the same unresolved styling to a block reference whose target page does not resolve", () => {
    const v = mountWithResolver("[[存在しないページ^someBlockId]]", () => false);
    const link = v.contentDOM.querySelector('[data-wikilink-target="存在しないページ"]');
    expect(link?.className).toContain("cm-wikilink-unresolved");
    expect(link?.getAttribute("data-wikilink-block-id")).toBe("someBlockId");
  });

  it("resolves the target before \\| without the backslash", () => {
    const v = mountWithResolver("| h |\n| - |\n| [[C\\|D]] |", (target) => target === "C");
    const link = v.contentDOM.querySelector('[data-wikilink-target="C"]');
    expect(link?.className).not.toContain("cm-wikilink-unresolved");
  });
});

describe("escaped label pipe (\\|)", () => {
  it("shows only the label and hides the backslash with the separator", () => {
    const v = mount("前置き [[C\\|D]] 後ろ");
    expect(firstLineText(v)).toBe("前置き D 後ろ");
    const link = v.contentDOM.querySelector('[data-wikilink-target="C"]');
    expect(link?.getAttribute("data-wikilink-label")).toBe("D");
  });

  it("shows only the label inside a table cell", () => {
    const v = mount("| h |\n| - |\n| [[C\\|D]] |");
    const row = v.contentDOM.querySelectorAll(".cm-line")[2];
    expect(row?.textContent).toBe("| D |");
    expect(row?.querySelector('[data-wikilink-target="C"]')).not.toBeNull();
  });

  it("navigates to the target before \\| on click", () => {
    const onWikiLinkClick = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    view = createEditor(host, { doc: "| h |\n| - |\n| [[C\\|D]] |", onWikiLinkClick });
    const link = view.contentDOM.querySelector('[data-wikilink-target="C"]');
    link?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(onWikiLinkClick).toHaveBeenCalledWith({
      target: "C",
      label: "D",
      blockId: null,
      heading: null,
    });
  });
});

describe("WikiLink to a heading or a block", () => {
  const click = (v: EditorView, selector: string) =>
    v.contentDOM
      .querySelector(selector)
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));

  it("passes the heading to the click handler and to the href", () => {
    const onWikiLinkClick = vi.fn();
    const hrefForWikiLink = vi.fn(() => "/x");
    host = document.createElement("div");
    document.body.append(host);
    view = createEditor(host, {
      doc: "[[A#見出し]] [[A#^abc]] [[A^def]]",
      onWikiLinkClick,
      hrefForWikiLink,
    });
    click(view, '[data-wikilink-heading="見出し"]');
    click(view, '[data-wikilink-heading="^abc"]');
    click(view, '[data-wikilink-block-id="def"]');
    expect(onWikiLinkClick.mock.calls.map(([link]) => link)).toEqual([
      { target: "A", label: null, blockId: null, heading: "見出し" },
      { target: "A", label: null, blockId: null, heading: "^abc" },
      { target: "A", label: null, blockId: "def", heading: null },
    ]);
    expect(hrefForWikiLink).toHaveBeenCalledWith({
      target: "A",
      label: null,
      blockId: null,
      heading: "見出し",
    });
  });

  it("draws a same-page link as resolved and passes an empty target on click", () => {
    const onWikiLinkClick = vi.fn();
    const resolveWikiLink = vi.fn(() => false);
    host = document.createElement("div");
    document.body.append(host);
    view = createEditor(host, {
      doc: "[[#見出し]] と [[#^abc|ラベル]]",
      onWikiLinkClick,
      resolveWikiLink,
    });
    expect(view.contentDOM.querySelectorAll(".cm-wikilink")).toHaveLength(2);
    expect(view.contentDOM.querySelector(".cm-wikilink-unresolved")).toBeNull();
    expect(resolveWikiLink).not.toHaveBeenCalled();
    click(view, '[data-wikilink-heading="見出し"]');
    expect(onWikiLinkClick).toHaveBeenLastCalledWith({
      target: "",
      label: null,
      blockId: null,
      heading: "見出し",
    });
    click(view, '[data-wikilink-heading="^abc"]');
    expect(onWikiLinkClick).toHaveBeenLastCalledWith({
      target: "",
      label: "ラベル",
      blockId: null,
      heading: "^abc",
    });
  });
});

describe("Live Preview", () => {
  it("hides heading and emphasis markup away from the cursor", () => {
    const v = mount("# 見出し\n\n本文 **太字** と *斜体* です\n\n末尾");
    placeCursor(v, v.state.doc.length);
    const lines = [...v.contentDOM.querySelectorAll(".cm-line")].map((l) => l.textContent);
    expect(lines[0]).toBe("見出し");
    expect(lines[2]).toBe("本文 太字 と 斜体 です");
    expect(v.contentDOM.querySelector(".cm-lp-h1")).not.toBeNull();
    expect(v.contentDOM.querySelector(".cm-lp-strong")?.textContent).toBe("太字");
  });

  it("reveals emphasis markup under the cursor", () => {
    const doc = "本文 **太字** です\n\n末尾";
    const v = mount(doc);
    placeCursor(v, doc.indexOf("太字") + 1);
    expect(firstLineText(v)).toBe("本文 **太字** です");
  });

  it("hides strikethrough markup away from the cursor", () => {
    const doc = "本文 ~~取消~~ です\n\n末尾";
    const v = mount(doc);
    placeCursor(v, doc.length);
    expect(firstLineText(v)).toBe("本文 取消 です");
    expect(v.contentDOM.querySelector(".cm-lp-strike")?.textContent).toBe("取消");
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("hides strikethrough markup while the editor is not focused", () => {
    const v = mount("本文 ~~取消~~ です");
    expect(v.hasFocus).toBe(false);
    expect(firstLineText(v)).toBe("本文 取消 です");
  });

  it("reveals strikethrough markup under the cursor and right after it", () => {
    const doc = "本文 ~~取消~~ です\n\n末尾";
    const v = mount(doc);
    placeCursor(v, doc.indexOf("取消") + 1);
    expect(firstLineText(v)).toBe("本文 ~~取消~~ です");
    placeCursor(v, doc.indexOf("~~ です") + 2);
    expect(firstLineText(v)).toBe("本文 ~~取消~~ です");
    placeCursor(v, doc.indexOf("~~取消"));
    expect(firstLineText(v)).toBe("本文 ~~取消~~ です");
  });

  it("leaves tildes that do not form a strikethrough as written", () => {
    // GFM（と Obsidian）の取り消し線は `~~` の対だけ。単独の `~` や閉じていない `~~` は本文のまま
    const doc = "~単独~ と ~~閉じない\n\n末尾";
    const v = mount(doc);
    placeCursor(v, doc.length);
    expect(firstLineText(v)).toBe("~単独~ と ~~閉じない");
    expect(v.contentDOM.querySelector(".cm-lp-strike")).toBeNull();
  });

  it("skips cursor motion over hidden strikethrough markup", () => {
    const doc = "abc ~~def~~ ghi";
    const v = mount(doc);
    v.contentDOM.blur();
    const start = doc.indexOf("~~");
    expect(v.moveByChar(EditorSelection.cursor(start), true).head).toBe(doc.indexOf("def"));
  });

  it("hides highlight markup away from the cursor", () => {
    const doc = "本文 ==強調== です\n\n末尾";
    const v = mount(doc);
    placeCursor(v, doc.length);
    expect(firstLineText(v)).toBe("本文 強調 です");
    expect(v.contentDOM.querySelector(".cm-lp-highlight")?.textContent).toBe("強調");
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("hides highlight markup while the editor is not focused", () => {
    const v = mount("本文 ==強調== です");
    expect(v.hasFocus).toBe(false);
    expect(firstLineText(v)).toBe("本文 強調 です");
  });

  it("reveals highlight markup under the cursor and at both ends", () => {
    const doc = "本文 ==強調== です\n\n末尾";
    const v = mount(doc);
    placeCursor(v, doc.indexOf("強調") + 1);
    expect(firstLineText(v)).toBe("本文 ==強調== です");
    placeCursor(v, doc.indexOf("== です") + 2);
    expect(firstLineText(v)).toBe("本文 ==強調== です");
    placeCursor(v, doc.indexOf("==強調"));
    expect(firstLineText(v)).toBe("本文 ==強調== です");
  });

  it("leaves = that do not form a highlight as written", () => {
    const doc = "a == b と ===三つ=== と ==閉じない\n\n末尾";
    const v = mount(doc);
    placeCursor(v, doc.length);
    expect(firstLineText(v)).toBe("a == b と ===三つ=== と ==閉じない");
    expect(v.contentDOM.querySelector(".cm-lp-highlight")).toBeNull();
  });

  it("highlights a WikiLink label while hiding both markups", () => {
    const v = mount("前 ==[[Amazon Web Services|AWS]]== 後");
    expect(firstLineText(v)).toBe("前 AWS 後");
    const mark = v.contentDOM.querySelector(".cm-lp-highlight");
    expect(mark?.textContent).toBe("AWS");
    expect(mark?.querySelector('[data-wikilink-target="Amazon Web Services"]')).not.toBeNull();
  });

  it("skips cursor motion over hidden highlight markup", () => {
    const doc = "abc ==def== ghi";
    const v = mount(doc);
    v.contentDOM.blur();
    const start = doc.indexOf("==");
    expect(v.moveByChar(EditorSelection.cursor(start), true).head).toBe(doc.indexOf("def"));
  });

  it("skips cursor motion over hidden markup", () => {
    const doc = "abc [[Target|Label]] def";
    const v = mount(doc);
    // 非フォーカス時に隠れている範囲が atomic になっていることを確かめる
    v.contentDOM.blur();
    const start = doc.indexOf("[[");
    const hiddenStart = v.moveByChar(EditorSelection.cursor(start), true);
    expect(hiddenStart.head).toBe(doc.indexOf("Label"));
  });
});
