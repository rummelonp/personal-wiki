import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createEditor } from "./create-editor";
import { colorOf, contrastRatio, MIN_CONTRAST, resolve } from "./test-contrast";
import { resetEditorHue, resetScheme, setEditorHue, setScheme } from "./test-tokens";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc: string): EditorView {
  host = document.createElement("div");
  host.style.width = "600px";
  document.body.append(host);
  view = createEditor(host, { doc });
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
  resetScheme();
  resetEditorHue();
});

const codes = (v: EditorView) => [...v.contentDOM.querySelectorAll(".cm-lp-inline-code")];
const codeTexts = (v: EditorView) => codes(v).map((code) => code.textContent);

const placeCursor = (v: EditorView, pos: number) => {
  v.focus();
  v.dispatch({ selection: EditorSelection.cursor(pos) });
};

describe("inline code decoration", () => {
  it("hides the backticks and styles the code when the cursor is elsewhere", () => {
    const v = mount("前 `code` 後\n\n別の行");
    placeCursor(v, v.state.doc.length);

    expect(codeTexts(v)).toEqual(["code"]);
    expect(v.contentDOM.querySelector(".cm-line")?.textContent).toBe("前 code 後");
  });

  it("draws the code in the monospace font on a surface background", () => {
    const v = mount("前 `code` 後");
    const code = codes(v)[0];
    if (!code) throw new Error("inline code is not rendered");
    const style = getComputedStyle(code);

    expect(style.fontFamily).toContain("editor-test-mono");
    expect(style.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  it("shows the backticks while the cursor is inside, at either edge, or in the code", () => {
    const doc = "前 `code` 後";
    const v = mount(doc);
    for (const pos of [doc.indexOf("`"), doc.indexOf("o"), doc.lastIndexOf("`") + 1]) {
      placeCursor(v, pos);
      expect(codeTexts(v)).toEqual(["`code`"]);
    }
    placeCursor(v, doc.length);
    expect(codeTexts(v)).toEqual(["code"]);
  });

  it("hides the backticks in a view without focus", () => {
    const v = mount("`code`");
    expect(codeTexts(v)).toEqual(["code"]);
  });

  it.each([
    ["``a`b``", "a`b"],
    ["`` `x` ``", " `x` "],
    ["```a``b```", "a``b"],
  ])("pairs the backtick runs of %j as CommonMark does", (doc, shown) => {
    const v = mount(`${doc}\n\n別の行`);
    placeCursor(v, v.state.doc.length);

    expect(codeTexts(v)).toEqual([shown]);
    expect(v.state.doc.toString()).toBe(`${doc}\n\n別の行`);
  });

  it("reveals both marks of a double backtick span together", () => {
    const doc = "``a`b`` 後";
    const v = mount(doc);
    placeCursor(v, doc.indexOf("b"));

    expect(codeTexts(v)).toEqual(["``a`b``"]);
  });

  it("leaves a lone backtick as text", () => {
    const v = mount("a ` b");
    expect(codes(v)).toEqual([]);
    expect(v.contentDOM.textContent).toBe("a ` b");
  });

  it("does not treat the fences of a fenced code block as inline code", () => {
    const v = mount("```\ncode\n```\n\n後");
    expect(codes(v)).toEqual([]);
  });

  it("styles the code in a heading and a list item", () => {
    const v = mount("# 見出し `a`\n\n- 項目 `b`\n\n後");
    placeCursor(v, v.state.doc.length);

    expect(codeTexts(v)).toEqual(["a", "b"]);
  });

  // 構文木では inline code の中に WikiLink などの node が生まれない。装飾が張られないことを
  // DOM で確かめる。
  it.each([
    ["wikilink", "`[[Note]]`", ".cm-wikilink"],
    ["tag", "`#tag`", ".cm-tag"],
    ["highlight", "`==mark==`", ".cm-lp-highlight"],
    ["strong", "`**bold**`", ".cm-lp-strong"],
    ["emphasis", "`*em*`", ".cm-lp-em"],
    ["strikethrough", "`~~del~~`", ".cm-lp-strike"],
    ["comment", "`%%note%%`", ".cm-lp-comment"],
    ["markdown link", "`[a](https://example.com)`", ".cm-md-link"],
  ])("does not decorate %s syntax inside the code", (_, doc, selector) => {
    const v = mount(`${doc}\n\n別の行`);
    placeCursor(v, v.state.doc.length);

    expect(v.contentDOM.querySelector(selector)).toBeNull();
    expect(codeTexts(v)).toEqual([doc.slice(1, -1)]);
  });

  it("does not hide anything inside the code", () => {
    const v = mount("`**a**` と `==b==`\n\n別の行");
    placeCursor(v, v.state.doc.length);

    expect(v.contentDOM.querySelector(".cm-line")?.textContent).toBe("**a** と ==b==");
  });
});

// IME 不変条件 2。selection に触れる範囲は replace で隠さない。端点（バッククォートの隣）を含む
// すべての位置で、カーソルに重なる replace が残らないことを確かめる。
describe("inline code and the IME invariants", () => {
  it("never conceals a mark touching the cursor, wherever it sits (IME invariant 2)", () => {
    const doc = "前 `a` と ``b`c`` 後";
    const v = mount(doc);
    const spans = ["`a`", "``b`c``"].map((source) => ({ source, from: doc.indexOf(source) }));
    for (let pos = 0; pos <= doc.length; pos += 1) {
      placeCursor(v, pos);
      const text = v.contentDOM.querySelector(".cm-line")?.textContent ?? "";
      // 別の span のバッククォートで通らないよう、触れている span の記号つきの全文を見る
      for (const { source, from } of spans) {
        if (from <= pos && pos <= from + source.length) expect(text).toContain(source);
      }
    }
  });

  it("does not rebuild decorations while composing, then hides the marks once after it ends (IME invariant 1)", async () => {
    const doc = "前 `code` 後\n\n別の行";
    const v = mount(doc);
    placeCursor(v, doc.indexOf("o"));
    expect(codeTexts(v)).toEqual(["`code`"]);

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    v.dispatch({ selection: EditorSelection.cursor(doc.length) });
    expect(codeTexts(v)).toEqual(["`code`"]);

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await expect.poll(() => codeTexts(v)).toEqual(["code"]);
  });
});

describe("inline code contrast", () => {
  it.each(["light", "dark"] as const)(
    "%s: text on the code background is at least 4.5:1",
    (scheme) => {
      setScheme(scheme);
      const v = mount("`code`");
      const code = codes(v)[0];
      if (!(code instanceof HTMLElement)) throw new Error("inline code is not rendered");

      const failures = Array.from({ length: 72 }, (_, index) => index * 5).flatMap((hue) => {
        setEditorHue(hue);
        const ratio = contrastRatio(
          colorOf(code),
          resolve(v.contentDOM, "var(--ui-color-surface)"),
        );
        return ratio >= MIN_CONTRAST ? [] : [`hue ${hue}: ${ratio.toFixed(2)}:1`];
      });

      expect(failures).toEqual([]);
    },
  );
});
