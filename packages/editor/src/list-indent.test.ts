import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createEditor } from "./create-editor";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** 折り返しが起きる狭い幅で描く */
function mount(doc: string): EditorView {
  const host = document.createElement("div");
  host.style.width = "320px";
  document.body.append(host);
  const view = createEditor(host, { doc });
  cleanups.push(() => {
    view.destroy();
    host.remove();
  });
  return view;
}

const placeCursor = (view: EditorView, pos: number) => {
  view.focus();
  view.dispatch({ selection: EditorSelection.cursor(pos) });
};

/** 3 行以上に折り返す長さの本文 */
const LONG = "折り返しを確かめるための長い本文。".repeat(4);

/**
 * `lineNumber` 行目の、本文の始まり（`bodyFrom`）と、折り返した 2 つ目の表示行の始まりの x 座標。
 * 2 つ目の表示行の始まりは、文字の上端が 1 つ目の表示行より下に来る最初の位置で見る。
 */
function wrapStarts(view: EditorView, lineNumber: number, bodyFrom: number) {
  const line = view.state.doc.line(lineNumber);
  const body = view.coordsAtPos(bodyFrom, 1);
  if (!body) throw new Error("the body start has no coordinates");
  for (let pos = bodyFrom + 1; pos < line.to; pos += 1) {
    const coords = view.coordsAtPos(pos, 1);
    if (coords && coords.top > body.bottom - 1) {
      return { body: body.left, wrapped: coords.left };
    }
  }
  throw new Error(`line ${lineNumber} does not wrap`);
}

function expectAligned(view: EditorView, lineNumber: number, bodyFrom: number): void {
  const { body, wrapped } = wrapStarts(view, lineNumber, bodyFrom);
  expect(Math.abs(wrapped - body)).toBeLessThan(1);
}

describe("list hanging indent", () => {
  it.each([
    ["a bullet item", `- ${LONG}`],
    ["an item marked with `*`", `* ${LONG}`],
    ["an ordered item", `1. ${LONG}`],
    ["an ordered item with a wide number", `10. ${LONG}`],
    ["an item with extra spaces after the marker", `-   ${LONG}`],
    ["an item with a tab after the marker", `-\t${LONG}`],
    ["an unchecked task", `- [ ] ${LONG}`],
    ["a checked task", `- [x] ${LONG}`],
    ["an ordered task", `1. [ ] ${LONG}`],
    ["an item in a blockquote", `> - ${LONG}`],
    ["a task in a nested blockquote", `> > - [ ] ${LONG}`],
  ])("aligns the wrapped lines of %s with the start of the text", (_, doc) => {
    const view = mount(doc);
    expectAligned(view, 1, doc.indexOf("折"));
  });

  it.each([
    ["spaces", `- 親\n  - ${LONG}\n    - [ ] ${LONG}`],
    ["a tab", `- 親\n\t- ${LONG}\n\t\t- [ ] ${LONG}`],
  ])("aligns nested items indented with %s at every level", (_, doc) => {
    const view = mount(doc);
    expectAligned(view, 2, view.state.doc.line(2).from + view.state.doc.line(2).text.indexOf("折"));
    expectAligned(view, 3, view.state.doc.line(3).from + view.state.doc.line(3).text.indexOf("折"));
  });

  it.each([
    ["a bullet item", `- ${LONG}`, 0],
    ["a task", `- [ ] ${LONG}`, 0],
    ["an item in a blockquote", `> - ${LONG}`, 0],
  ])("keeps %s aligned while the source of the line is shown", (_, doc, cursor) => {
    const view = mount(doc);
    placeCursor(view, cursor);
    // source が出ていること（`-` が「•」や checkbox になっていない）を先に確かめる
    expect(
      view.contentDOM.querySelector(".cm-line")?.textContent?.startsWith(doc.slice(0, 2)),
    ).toBe(true);
    expectAligned(view, 1, doc.indexOf("折"));
  });

  it("measures again when the font of the editor changes after it is drawn", async () => {
    const doc = `- [ ] ${LONG}`;
    const view = mount(doc);
    const indent = () =>
      view.contentDOM
        .querySelector<HTMLElement>(".cm-lp-list")
        ?.style.getPropertyValue("--cm-lp-list-indent");
    const before = indent();
    // typographyTheme が `.cm-scroller` で文字の大きさを固定しているので、view.dom では contentDOM に届かない
    view.scrollDOM.style.fontSize = "24px";
    view.requestMeasure();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(indent()).not.toBe(before);
    expectAligned(view, 1, doc.indexOf("折"));
  });

  it("leaves lines outside lists without the indent", () => {
    const view = mount(`${LONG}\n\n- 項目`);
    const lines = view.contentDOM.querySelectorAll(".cm-line");
    expect(lines[0]?.classList.contains("cm-lp-list")).toBe(false);
    expect(lines[2]?.classList.contains("cm-lp-list")).toBe(true);
  });

  it.each([
    ["a code block", "- ```js\n  const a = 1;\n  ```"],
    ["a heading", "- # 見出し"],
    ["another list marker", "- - 項目"],
    ["text that starts on the next line", `-\n  ${LONG}`],
  ])("leaves an item that starts with %s without the indent", (_, doc) => {
    const view = mount(doc);
    expect(view.contentDOM.querySelectorAll(".cm-line").length).toBeGreaterThan(0);
    expect(view.contentDOM.querySelector(".cm-lp-list")).toBeNull();
  });

  it("starts the first line of an item at the left edge of the paragraphs", () => {
    const view = mount(`本文\n\n- ${LONG}`);
    const paragraph = view.coordsAtPos(0, 1);
    const item = view.coordsAtPos(view.state.doc.line(3).from, 1);
    expect(item?.left).toBeCloseTo(paragraph?.left ?? Number.NaN, 0);
  });
});
