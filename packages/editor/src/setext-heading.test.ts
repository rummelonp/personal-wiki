import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createEditor } from "./create-editor";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc: string): EditorView {
  view?.destroy();
  host?.remove();
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
});

const lines = (v: EditorView) => [...v.contentDOM.querySelectorAll(".cm-line")];

/** 各行が持つ見出しの level。見出しの行でなければ null */
const levels = (v: EditorView) =>
  lines(v).map((line) => {
    const match = /cm-lp-h([1-6])/.exec(line.className);
    return match ? Number(match[1]) : null;
  });

const placeCursor = (v: EditorView, pos: number) => {
  v.focus();
  v.dispatch({ selection: EditorSelection.cursor(pos) });
};

describe("setext heading decoration", () => {
  it("styles the text line as a heading and leaves the underline as source", () => {
    const v = mount("見出し\n===\n\n後");

    expect(levels(v)).toEqual([1, null, null, null]);
    expect(lines(v)[1]?.textContent).toBe("===");
    expect(lines(v)[1]?.className).not.toContain("cm-lp-heading");
  });

  it("reads --- under a paragraph line as a level 2 heading, not a rule", () => {
    const v = mount("見出し\n---\n\n後");

    expect(levels(v)).toEqual([2, null, null, null]);
    expect(v.contentDOM.querySelector(".cm-lp-hr")).toBeNull();
    expect(lines(v)[1]?.textContent).toBe("---");
  });

  it("keeps --- after a blank line as a rule", () => {
    const v = mount("段落\n\n---\n\n後");

    expect(levels(v)).toEqual([null, null, null, null, null]);
    expect(v.contentDOM.querySelectorAll(".cm-lp-hr")).toHaveLength(1);
  });

  it("styles every line of a heading written over several lines", () => {
    const v = mount("一行目\n二行目\n===");

    expect(levels(v)).toEqual([1, 1, null]);
  });

  it("puts the top spacing only on the first line of a multi-line heading", () => {
    const v = mount("前\n\n一行目\n二行目\n===");
    const padding = lines(v).map((line) => getComputedStyle(line).paddingTop);

    expect(Number.parseFloat(padding[2] ?? "0")).toBeGreaterThan(0);
    expect(Number.parseFloat(padding[3] ?? "1")).toBe(0);
  });

  it("accepts an underline of any length, one character included", () => {
    expect(levels(mount("見出し\n="))).toEqual([1, null]);
    expect(levels(mount("見出し\n--------"))).toEqual([2, null]);
  });

  it("gives only a heading at the top of the document the leading class", () => {
    const first = mount("見出し\n===");
    expect(lines(first)[0]?.className).toContain("cm-lp-heading-leading");

    const later = mount("前\n\n見出し\n===");
    expect(lines(later)[2]?.className).not.toContain("cm-lp-heading-leading");
    expect(levels(later)).toEqual([null, null, 1, null]);
  });

  it("draws the heading text larger than the body and the underline at the body size", () => {
    const v = mount("見出し\n===\n\n本文");
    const [heading, underline, , body] = lines(v).map((line) => getComputedStyle(line).fontSize);

    expect(Number.parseFloat(heading ?? "0")).toBeGreaterThan(Number.parseFloat(body ?? "0"));
    expect(underline).toBe(body);
  });

  it("does not turn the delimiters of a frontmatter block into a heading", () => {
    const v = mount("---\ntitle: a\n---\n\n本文");
    placeCursor(v, 0);

    expect(levels(v).every((level) => level === null)).toBe(true);
  });

  it("styles a heading inside a blockquote", () => {
    const v = mount("> 見出し\n> ===\n\n後");

    expect(levels(v)).toEqual([1, null, null, null]);
  });

  it("styles a heading inside a list item", () => {
    const v = mount("- 見出し\n  ---\n\n後");

    expect(levels(v)).toEqual([2, null, null, null]);
  });

  it("does not read an underline after a blank line as a heading", () => {
    const v = mount("段落\n\n===");

    expect(levels(v)).toEqual([null, null, null]);
  });

  it("shows the same classes while the cursor is on the heading", () => {
    const v = mount("見出し\n===\n\n後");
    placeCursor(v, 1);

    expect(levels(v)).toEqual([1, null, null, null]);
    expect(lines(v)[1]?.textContent).toBe("===");
  });
});

describe("setext heading and the IME invariants", () => {
  // IME 不変条件 1。下線を打つ composition の間は装飾を組み直さず、終わってから 1 回だけ見出しにする
  it("does not restyle the line while composing, then does once after it ends", async () => {
    const v = mount("見出し\n");
    placeCursor(v, v.state.doc.length);
    expect(levels(v)).toEqual([null, null]);

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    v.dispatch({
      changes: { from: v.state.doc.length, insert: "===" },
      selection: { anchor: v.state.doc.length + 3 },
      userEvent: "input.type.compose",
    });
    expect(levels(v)).toEqual([null, null]);

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await expect.poll(() => levels(v)).toEqual([1, null]);
  });
});
