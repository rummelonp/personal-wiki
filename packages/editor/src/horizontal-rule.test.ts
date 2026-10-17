import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createEditor } from "./create-editor";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc: string, extensions: Extension = []): EditorView {
  host = document.createElement("div");
  host.style.width = "600px";
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

const rules = (v: EditorView) => v.contentDOM.querySelectorAll(".cm-lp-hr");

/** 画面に描かれた n 行目（0 始まり）のテキスト */
const lineText = (v: EditorView, n: number) =>
  v.contentDOM.querySelectorAll(".cm-line")[n]?.textContent ?? "";

const placeCursor = (v: EditorView, ...positions: number[]) => {
  v.focus();
  v.dispatch({
    selection: EditorSelection.create(positions.map((p) => EditorSelection.cursor(p))),
  });
};

describe("horizontal rule decoration", () => {
  it.each(["---", "***", "___", "- - -", "* * *", "_____", "   ---", "--- "])(
    "draws %j as a rule and hides the markup",
    (rule) => {
      const doc = `前\n\n${rule}\n\n後`;
      const v = mount(doc);

      expect(rules(v)).toHaveLength(1);
      // インデントも残さない。残ると罫線が次の表示行へ折り返す
      expect(lineText(v, 2)).toBe("");
      expect(v.state.doc.toString()).toBe(doc);
    },
  );

  it("spans the full width of the line", () => {
    const v = mount("前\n\n---\n\n後");
    const rule = rules(v)[0]?.getBoundingClientRect();
    const line = v.contentDOM.querySelectorAll(".cm-line")[2];
    if (!rule || !line) throw new Error("rule is not drawn");
    const style = getComputedStyle(line);
    const contentWidth =
      line.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);

    expect(rule.height).toBeGreaterThan(0);
    expect(rule.width).toBeCloseTo(contentWidth, 0);
  });

  it("leaves a setext heading underline as source", () => {
    const v = mount("見出し\n---\n\n後");

    expect(rules(v)).toHaveLength(0);
    expect(lineText(v, 1)).toBe("---");
  });

  it("treats `***` after a paragraph as a rule, since only `-` and `=` underline headings", () => {
    const v = mount("段落\n***");

    expect(rules(v)).toHaveLength(1);
    expect(lineText(v, 0)).toBe("段落");
  });

  it("leaves the frontmatter delimiters as source and draws a rule after it", () => {
    const v = mount("---\ntitle: a\n---\n\n---\n\n後");
    // frontmatter は既定で畳んだ枠になるので、delimiter の行を見るにはカーソルを中に置く
    // （`frontmatter-block.ts`）。rule かどうかの判定はカーソルの位置に依らない。
    placeCursor(v, 0);

    expect(rules(v)).toHaveLength(1);
    expect(lineText(v, 0)).toBe("---");
    expect(lineText(v, 2)).toBe("---");
    expect(lineText(v, 4)).toBe("");
  });

  it.each(["> ---", ">\t---", "> > ---", ">   ---"])(
    "draws %j inside a blockquote as a rule with the quote mark hidden",
    (rule) => {
      const doc = `前\n\n${rule}\n\n後`;
      const v = mount(doc);

      expect(rules(v)).toHaveLength(1);
      expect(lineText(v, 2)).toBe("");
    },
  );

  it("exposes the rule as a separator", () => {
    const v = mount("前\n\n---\n\n後");

    expect(rules(v)[0]?.getAttribute("role")).toBe("separator");
  });

  it("leaves `---` in a fenced code block as source", () => {
    const v = mount("```\n---\n```");

    expect(rules(v)).toHaveLength(0);
    expect(lineText(v, 1)).toBe("---");
  });
});

describe("horizontal rule reveal", () => {
  const DOC = "前\n\n  ---\n\n後";
  const lineFrom = DOC.indexOf("  ---");
  const lineTo = lineFrom + "  ---".length;

  it.each([
    ["the indentation", lineFrom],
    ["the markup", lineFrom + 3],
    ["the line end", lineTo],
  ])("shows the source while the cursor is at %s", (_, pos) => {
    const v = mount(DOC);
    placeCursor(v, pos);

    expect(rules(v)).toHaveLength(0);
    expect(lineText(v, 2)).toBe("  ---");
  });

  it("draws the rule again once the cursor leaves the line", () => {
    const v = mount(DOC);
    placeCursor(v, lineFrom + 3);
    placeCursor(v, 0);

    expect(rules(v)).toHaveLength(1);
  });

  it("shows the source when any of multiple cursors is on the line", () => {
    const v = mount(DOC, EditorState.allowMultipleSelections.of(true));
    placeCursor(v, 0, lineFrom + 3);

    expect(v.state.selection.ranges).toHaveLength(2);
    expect(rules(v)).toHaveLength(0);
  });

  it("shows the source when a selection spans across the line", () => {
    const v = mount(DOC);
    v.focus();
    v.dispatch({ selection: EditorSelection.single(0, DOC.length) });

    expect(rules(v)).toHaveLength(0);
  });

  it("moves the cursor onto the line when the rule is clicked", () => {
    const v = mount(DOC);
    const rule = rules(v)[0];
    if (!rule) throw new Error("rule is not drawn");
    const rect = rule.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      button: 0,
      // CodeMirror は detail をクリック回数として読む。既定の 0 だと行全体の選択になる
      detail: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };

    rule.dispatchEvent(new MouseEvent("mousedown", init));
    rule.dispatchEvent(new MouseEvent("mouseup", init));

    const { main } = v.state.selection;
    expect(main.empty).toBe(true);
    expect(main.head).toBeGreaterThanOrEqual(lineFrom);
    expect(main.head).toBeLessThanOrEqual(lineTo);
    expect(lineText(v, 2)).toBe("  ---");
  });
});
