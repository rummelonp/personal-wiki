import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "./create-editor";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc: string, extensions: Extension = []): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, { doc, extensions });
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

const lineElements = (v: EditorView) => [...v.contentDOM.querySelectorAll<HTMLElement>(".cm-line")];
const lineTexts = (v: EditorView) => lineElements(v).map((line) => line.textContent ?? "");
/** 引用の line decoration が付いていなければ 0 */
const quoteDepths = (v: EditorView) =>
  lineElements(v).map((line) =>
    line.classList.contains("cm-lp-blockquote")
      ? Number(line.style.getPropertyValue("--cm-lp-quote-depth"))
      : 0,
  );

const placeCursor = (v: EditorView, pos: number) => {
  v.focus();
  v.dispatch({ selection: EditorSelection.cursor(pos) });
};

describe("blockquote Live Preview", () => {
  it("hides the quote mark and its space while the editor is not focused", () => {
    const doc = "> 引用の一行目\n> 二行目\n\n本文";
    const v = mount(doc);
    expect(lineTexts(v)).toEqual(["引用の一行目", "二行目", "", "本文"]);
    expect(quoteDepths(v)).toEqual([1, 1, 0, 0]);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("hides only the mark when no space follows it", () => {
    const v = mount(">詰めた引用");
    expect(lineTexts(v)).toEqual(["詰めた引用"]);
  });

  it("reveals the mark only on the line holding the cursor", () => {
    const doc = "> 一行目\n> 二行目\n> 三行目";
    const v = mount(doc);
    placeCursor(v, doc.indexOf("二行目") + 1);
    expect(lineTexts(v)).toEqual(["一行目", "> 二行目", "三行目"]);
    // source を出した行もバーは残す
    expect(quoteDepths(v)).toEqual([1, 1, 1]);
  });

  it("reveals the mark when the cursor sits at either end of the line", () => {
    const doc = "> 一行目\n> 二行目";
    const v = mount(doc);
    placeCursor(v, doc.indexOf("> 二行目"));
    expect(lineTexts(v)[1]).toBe("> 二行目");
    placeCursor(v, doc.length);
    expect(lineTexts(v)[1]).toBe("> 二行目");
    expect(lineTexts(v)[0]).toBe("一行目");
  });

  it("reveals every line touched by any selection range", () => {
    const doc = "> 一行目\n> 二行目\n> 三行目";
    const v = mount(doc, EditorState.allowMultipleSelections.of(true));
    v.focus();
    v.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.cursor(doc.indexOf("一行目")), EditorSelection.cursor(doc.length)],
        0,
      ),
    });
    expect(lineTexts(v)).toEqual(["> 一行目", "二行目", "> 三行目"]);
  });

  it("collapses the mark when the editor loses focus", async () => {
    const doc = "> 引用\n\n本文";
    const v = mount(doc);
    placeCursor(v, 2);
    expect(lineTexts(v)[0]).toBe("> 引用");
    v.contentDOM.blur();
    await vi.waitFor(() => expect(lineTexts(v)[0]).toBe("引用"));
  });

  it("draws one bar per nesting level", () => {
    const v = mount("> 外側\n> > 内側\n>\n> 外側に戻る");
    expect(lineTexts(v)).toEqual(["外側", "内側", "", "外側に戻る"]);
    expect(quoteDepths(v)).toEqual([1, 2, 1, 1]);
    const inner = lineElements(v)[1];
    const outer = lineElements(v)[0];
    if (!inner || !outer) throw new Error("lines are not rendered");
    const padding = (line: HTMLElement) => Number.parseFloat(getComputedStyle(line).paddingLeft);
    expect(padding(inner)).toBeGreaterThan(padding(outer));
    expect(getComputedStyle(inner).backgroundImage).toContain("gradient");
  });

  it("treats a lazy continuation line as part of the quote", () => {
    // `>` の無い 2 行目は CommonMark の lazy continuation で、1 行目と同じ段落になる
    const v = mount("> 引用の段落\n続きの行\n\n本文");
    expect(lineTexts(v)).toEqual(["引用の段落", "続きの行", "", "本文"]);
    expect(quoteDepths(v)).toEqual([1, 1, 0, 0]);
  });

  it("renders quotes separated by a blank line as two quotes", () => {
    const v = mount("> 一つ目\n\n> 二つ目");
    expect(lineTexts(v)).toEqual(["一つ目", "", "二つ目"]);
    expect(quoteDepths(v)).toEqual([1, 0, 1]);
  });

  it("keeps decorating headings and lists inside a quote", () => {
    const v = mount("> # 見出し\n> - 項目\n> **太字**");
    // `-` は箇条書きの記号として「•」に置き換わる
    expect(lineTexts(v)).toEqual(["見出し", "• 項目", "太字"]);
    expect(quoteDepths(v)).toEqual([1, 1, 1]);
    expect(lineElements(v)[0]?.classList.contains("cm-lp-h1")).toBe(true);
  });

  it("hides only one of two spaces after the mark", () => {
    const v = mount(">  二つの空白");
    expect(lineTexts(v)).toEqual([" 二つの空白"]);
  });

  it("hides a tab right after the mark", () => {
    const v = mount(">\tタブの後");
    expect(lineTexts(v)).toEqual(["タブの後"]);
  });

  it("decorates a quote inside a list item from the start of the line", () => {
    // 現状の見た目を固定する。バーはリスト記号の位置でなく行頭に描かれる
    // `-` は箇条書きの記号として「•」に置き換わる
    const v = mount("- > リスト内の引用");
    expect(lineTexts(v)).toEqual(["• リスト内の引用"]);
    expect(quoteDepths(v)).toEqual([1]);
  });

  it("aligns bars and text of a heading line with the other quote lines", () => {
    // 空の `>` 行で内側の引用を閉じる。無いと `> 外側` は内側の段落の lazy continuation になる
    const v = mount("> > # 見出し\n> > 本文\n>\n> 外側");
    const [heading, body, , outer] = lineElements(v);
    if (!heading || !body || !outer) throw new Error("lines are not rendered");
    expect(heading.classList.contains("cm-lp-h1")).toBe(true);
    const style = (line: HTMLElement) => getComputedStyle(line);
    expect(style(heading).paddingLeft).toBe(style(body).paddingLeft);
    expect(style(heading).backgroundSize).toBe(style(body).backgroundSize);
    // 深さ 1 の行は、深さ 2 の行と 1 本目のバーの位置が揃い、本文が 1 段浅い
    expect(style(outer).backgroundPosition).toBe(style(heading).backgroundPosition);
    expect(Number.parseFloat(style(outer).paddingLeft)).toBeLessThan(
      Number.parseFloat(style(heading).paddingLeft),
    );
  });

  it("decorates the visible lines of a quote that starts above the viewport", async () => {
    const count = 3000;
    const doc = Array.from({ length: count }, (_, i) => `> 引用 ${i}`).join("\n");
    const v = mount(
      doc,
      EditorView.theme({ "&": { height: "200px" }, ".cm-scroller": { overflow: "auto" } }),
    );
    // selection も末尾へ移す。先頭に残すと、CodeMirror は visibleRanges の外にある
    // selection の行も描くので、decoration の無い 1 行目が DOM に混ざる。
    v.dispatch({
      selection: EditorSelection.cursor(doc.length),
      effects: EditorView.scrollIntoView(doc.length),
    });
    await vi.waitFor(() => expect(lineTexts(v).at(-1)).toBe(`引用 ${count - 1}`));
    expect(v.viewport.from).toBeGreaterThan(0);
    const visible = lineElements(v).filter((line) => line.textContent !== "");
    expect(visible.length).toBeGreaterThan(0);
    for (const line of visible) {
      expect(line.textContent).not.toContain(">");
      expect(line.classList.contains("cm-lp-blockquote")).toBe(true);
    }
  });

  it("skips cursor motion over the hidden mark", () => {
    const doc = "前\n> 引用";
    const v = mount(doc);
    v.contentDOM.blur();
    const lineStart = doc.indexOf(">");
    expect(v.moveByChar(EditorSelection.cursor(lineStart), true).head).toBe(doc.indexOf("引用"));
  });
});
