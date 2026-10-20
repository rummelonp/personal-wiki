import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "./create-editor";
import { invalidateDecorations } from "./decoration-plugin";
import { charRect, onSameVisualLine } from "./test-geometry";

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

// `\r` は state が改行に直すので editor の解析には届かない。届くのは U+2028 と U+2029 だけ
describe("WikiLink with a line terminator inside", () => {
  it.each(["\u2028", "\u2029"])("leaves a link containing %j as plain text", (terminator) => {
    const doc = `前 [[a#b${terminator}c]] [[a^b${terminator}c]] [[ok]]`;
    const v = mount(doc);
    expect(v.state.doc.toString()).toBe(doc);
    const targets = [...v.contentDOM.querySelectorAll("[data-wikilink-target]")].map((el) =>
      el.getAttribute("data-wikilink-target"),
    );
    expect(targets).toEqual(["ok"]);
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

describe("draft link badge", () => {
  const BADGE = ".cm-wikilink-draft-badge";

  function mountWithDraftTest(
    doc: string,
    isDraft: (target: string) => boolean,
    resolve: (target: string) => boolean = () => true,
  ): EditorView {
    host = document.createElement("div");
    document.body.append(host);
    view = createEditor(host, { doc, resolveWikiLink: resolve, isDraftWikiLink: isDraft });
    return view;
  }

  it("adds a text badge after a link whose target is a draft", () => {
    const v = mountWithDraftTest("前 [[下書きのページ|ラベル]] 後", (t) => t === "下書きのページ");
    const link = v.contentDOM.querySelector('[data-wikilink-target="下書きのページ"]');
    expect(link?.className).toContain("cm-wikilink-draft");
    const badges = v.contentDOM.querySelectorAll(BADGE);
    expect(badges).toHaveLength(1);
    // 読み上げにも伝わるよう、印は文字で持つ
    expect(badges[0]?.textContent).toBe("下書き");
    expect(firstLineText(v)).toBe("前 ラベル下書き 後");
    expect(v.state.doc.toString()).toBe("前 [[下書きのページ|ラベル]] 後");
  });

  it("does not badge links to public pages, missing pages, or the same page", () => {
    // 存在しないと分かった link と同じページへの link は、draft の判定より先に除く
    const v = mountWithDraftTest(
      "[[下書き]] [[公開]] [[無いページ]] [[#見出し]]",
      (t) => t !== "公開",
      (t) => t !== "無いページ",
    );
    expect(v.contentDOM.querySelectorAll(BADGE)).toHaveLength(1);
    const open = v.contentDOM.querySelector('[data-wikilink-target="公開"]');
    expect(open?.className).not.toContain("cm-wikilink-draft");
    const missing = v.contentDOM.querySelector('[data-wikilink-target="無いページ"]');
    expect(missing?.className).not.toContain("cm-wikilink-draft");
    const same = v.contentDOM.querySelector('[data-wikilink-target=""]');
    expect(same?.className).not.toContain("cm-wikilink-draft");
  });

  it("does not badge anything when no draft test is configured", () => {
    const v = mount("[[下書きのページ]]");
    expect(v.contentDOM.querySelector(BADGE)).toBeNull();
  });

  it("hides the badge while the cursor touches the link", () => {
    const doc = "前 [[下書きのページ]] 後";
    const v = mountWithDraftTest(doc, () => true);
    const end = doc.indexOf("]]") + 2;
    placeCursor(v, end);
    expect(v.contentDOM.querySelector(BADGE)).toBeNull();
    placeCursor(v, doc.length);
    expect(v.contentDOM.querySelector(BADGE)).not.toBeNull();
  });

  it("holds a badge change that arrives during composition until it settles", async () => {
    let drafts = false;
    const v = mountWithDraftTest("[[あとで分かるページ]] 本文", () => drafts);
    expect(v.contentDOM.querySelector(BADGE)).toBeNull();

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    drafts = true;
    invalidateDecorations(v);
    expect(v.contentDOM.querySelector(BADGE)).toBeNull();
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));

    await vi.waitFor(() => expect(v.contentDOM.querySelector(BADGE)).not.toBeNull());
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

describe("WikiLink and line wrapping", () => {
  /** 幅を 1px ずつ広げ、括弧、句読点 `char` が link の端と別の表示行に落ちる幅を集める */
  function widthsSplitFromLink(v: EditorView, char: string, side: "after" | "before"): string[] {
    placeCursor(v, v.state.doc.length);
    const line = v.contentDOM.querySelector(".cm-line") as Element;
    const link = v.contentDOM.querySelector(".cm-wikilink");
    if (!link || !host) throw new Error("wikilink is not rendered");

    const failures: string[] = [];
    // 狭い幅から広げ、括弧、句読点の隣が折り返し位置になる幅を必ず通らせる
    for (let width = 120; width <= 400; width++) {
      host.style.width = `${width}px`;
      const rects = link.getClientRects();
      const edge = side === "after" ? rects[rects.length - 1] : rects[0];
      const mark = charRect(line, char);
      if (edge && !onSameVisualLine(mark, edge)) failures.push(`${width}px`);
    }
    return failures;
  }

  it.each([
    ["全角の閉じ括弧", "本文の設定は [[wrangler の設定]]）の中にある。", "）"],
    ["ラベルの後の句点", "設定は次の [[wrangler の設定|ラベル付きの link]]。続きの文", "。"],
    ["半角の閉じ括弧", "file (see [[Settings of wrangler]]) for details", ")"],
  ])("keeps %s on the same visual line as the link before it, at any width", (_, doc, char) => {
    const v = mount(`${doc}\n\n後`);
    expect(widthsSplitFromLink(v, char, "after")).toEqual([]);
  });

  it.each([
    ["全角の開き括弧", "本文の設定は（[[wrangler の設定]] の中）にある。", "（"],
    ["鉤括弧", "設定の説明は「[[wranglerconfigurationsettings]] を見る」こと。", "「"],
    ["半角の開き括弧", "see the docs ([[wranglerconfigurationsettings]] for) details", "("],
  ])("keeps %s on the same visual line as the link after it, at any width", (_, doc, char) => {
    const v = mount(`${doc}\n\n後`);
    expect(widthsSplitFromLink(v, char, "before")).toEqual([]);
  });

  it("keeps the link in one element", () => {
    const v = mount("設定は（[[wrangler の設定]]）の中\n\n後");
    placeCursor(v, v.state.doc.length);

    expect(v.contentDOM.querySelectorAll(".cm-wikilink")).toHaveLength(1);
    expect(v.contentDOM.querySelector(".cm-wikilink")?.textContent).toBe("wrangler の設定");
  });

  it("does not add the no-break mark where no bracket or punctuation touches the link", () => {
    const v = mount("前 [[Note]] 後\n\n後");
    placeCursor(v, v.state.doc.length);

    expect(v.contentDOM.querySelector(".cm-lp-nobreak")).toBeNull();
  });

  it.each([
    ["日本語の target", "[[公開設定]]", "公開設定"],
    ["日本語の label", "[[Amazon Web Services|公開設定]]", "公開設定"],
    ["解決できない target", "[[存在しない記事]]", "存在しない記事"],
  ])(
    "wraps a link at the same places as plain text, including between characters: %s",
    (_, link, text) => {
      const lead = "今日は図書館で調べた内容をまとめて、";
      const tail = "の記事に書き足した。\n\n後";
      const v = mount(`${lead}${link}${tail}`);
      placeCursor(v, v.state.doc.length);
      const target = v.contentDOM.querySelector(".cm-wikilink");
      if (!target || !host) throw new Error("wikilink is not rendered");
      const linkedHeights: number[] = [];
      let splitWidths = 0;
      for (let width = 120; width <= 400; width++) {
        host.style.width = `${width}px`;
        linkedHeights.push(v.contentDOM.getBoundingClientRect().height);
        if (target.getClientRects().length > 1) splitWidths++;
      }
      view?.destroy();
      host.remove();

      const plain = mount(`${lead}${text}${tail}`);
      placeCursor(plain, plain.state.doc.length);
      const plainHeights: number[] = [];
      for (let width = 120; width <= 400; width++) {
        if (!host) throw new Error("host is not mounted");
        host.style.width = `${width}px`;
        plainHeights.push(plain.contentDOM.getBoundingClientRect().height);
      }

      expect(linkedHeights).toEqual(plainHeights);
      // 字の間で折り返す幅を通っていないと、地の文と同じ折り返しを確かめたことにならない
      expect(splitWidths).toBeGreaterThan(0);
    },
  );

  it("still wraps a Japanese link longer than the line inside the link", () => {
    const v = mount(`前の文 [[${"長い名前のページ".repeat(8)}]] 後の文\n\n後`);
    placeCursor(v, v.state.doc.length);
    const link = v.contentDOM.querySelector(".cm-wikilink");
    if (!link || !host) throw new Error("wikilink is not rendered");

    for (const width of [200, 280, 375]) {
      host.style.width = `${width}px`;
      expect(link.getClientRects().length).toBeGreaterThan(1);
      expect(v.contentDOM.scrollWidth).toBeLessThanOrEqual(v.contentDOM.clientWidth);
    }
  });

  it("still wraps a label longer than the line inside the link", () => {
    const v = mount(`前 [[Note|${"a-".repeat(80)}]]）後\n\n後`);
    placeCursor(v, v.state.doc.length);
    const link = v.contentDOM.querySelector(".cm-wikilink");
    if (!link || !host) throw new Error("wikilink is not rendered");
    host.style.width = "200px";

    expect(link.getClientRects().length).toBeGreaterThan(1);
    expect(v.contentDOM.scrollWidth).toBeLessThanOrEqual(v.contentDOM.clientWidth);
  });
});
