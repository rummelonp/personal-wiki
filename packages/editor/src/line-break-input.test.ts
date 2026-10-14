import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, test } from "vitest";
import { createEditor } from "./create-editor";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** `|` の位置に caret を置き、focus した editor を作る */
function setup(docWithCursor: string): EditorView {
  const cursor = docWithCursor.indexOf("|");
  const doc = docWithCursor.slice(0, cursor) + docWithCursor.slice(cursor + 1);
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = createEditor(parent, { doc });
  cleanups.push(() => {
    view.destroy();
    parent.remove();
  });
  view.focus();
  view.dispatch({ selection: EditorSelection.cursor(cursor) });
  return view;
}

const withCursor = (view: EditorView) => {
  const doc = view.state.doc.toString();
  const head = view.state.selection.main.head;
  return `${doc.slice(0, head)}|${doc.slice(head)}`;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/**
 * iOS の確定直後の改行を模す。keydown を伴わない `insertLineBreak` で、ブラウザが DOM に
 * 書いた内容を CodeMirror が読む。Chromium でも行末では `\n\n` が書かれる。
 */
async function insertLineBreak(): Promise<void> {
  document.execCommand("insertLineBreak");
  await settle();
}

describe("line break without a keydown (iOS right after a conversion)", () => {
  test("a line end gets one line break", async () => {
    const view = setup("朝|");
    await insertLineBreak();
    expect(withCursor(view)).toBe("朝\n|");
    expect(view.contentDOM.querySelectorAll(".cm-line")).toHaveLength(2);
  });

  test("a line end before another line gets one line break", async () => {
    const view = setup("朝|\n傘");
    await insertLineBreak();
    expect(withCursor(view)).toBe("朝\n|\n傘");
  });

  test("a bullet list item continues with a single marker", async () => {
    const view = setup("- 朝|");
    await insertLineBreak();
    expect(withCursor(view)).toBe("- 朝\n- |");
  });

  test("an ordered list item continues with the next number", async () => {
    const view = setup("1. 朝|");
    await insertLineBreak();
    expect(withCursor(view)).toBe("1. 朝\n2. |");
  });

  test("pressing twice leaves one empty line", async () => {
    const view = setup("朝|");
    await insertLineBreak();
    await insertLineBreak();
    expect(view.state.doc.toString()).toBe("朝\n\n");
  });

  test("nothing changes in a read-only editor", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = createEditor(parent, { doc: "朝", readOnly: true });
    cleanups.push(() => {
      view.destroy();
      parent.remove();
    });
    view.focus();
    view.dispatch({ selection: EditorSelection.cursor(1) });
    await insertLineBreak();
    expect(view.state.doc.toString()).toBe("朝");
    expect(view.contentDOM.querySelectorAll(".cm-line")).toHaveLength(1);
  });
});

describe("inputHandler guards", () => {
  /** CodeMirror が DOM の変更を読んだときに呼ぶ handler を、変更の内容を指定して直接呼ぶ */
  function handled(view: EditorView, from: number, to: number, text: string): boolean {
    const defaultInsert = () => view.state.update({ changes: { from, to, insert: text } });
    return view.state
      .facet(EditorView.inputHandler)
      .some((handler) => handler(view, from, to, text, defaultInsert));
  }

  test("a single line break is left to CodeMirror", () => {
    const view = setup("朝|");
    expect(handled(view, 1, 1, "\n")).toBe(false);
    expect(view.state.doc.toString()).toBe("朝");
  });

  test("a pasted double line break is left to CodeMirror", () => {
    const view = setup("朝|");
    const data = new DataTransfer();
    data.setData("text/plain", "\n\n");
    view.contentDOM.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
    expect(view.state.doc.toString()).toBe("朝\n\n");
  });

  test("a double line break in the middle of a line is left to CodeMirror", () => {
    const view = setup("朝|傘");
    expect(handled(view, 1, 1, "\n\n")).toBe(false);
    expect(view.state.doc.toString()).toBe("朝傘");
  });

  test("a double line break that replaces a selection is left to CodeMirror", () => {
    const view = setup("朝傘|");
    view.dispatch({ selection: EditorSelection.range(0, 2) });
    expect(handled(view, 2, 2, "\n\n")).toBe(false);
    expect(handled(view, 0, 2, "\n\n")).toBe(false);
  });

  test("a double line break during a composition is left to CodeMirror", () => {
    const view = setup("朝|");
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(handled(view, 1, 1, "\n\n")).toBe(false);
    expect(view.state.doc.toString()).toBe("朝");
  });

  test("a double line break at a line end is taken as one Enter", () => {
    const view = setup("朝|");
    expect(handled(view, 1, 1, "\n\n")).toBe(true);
    expect(withCursor(view)).toBe("朝\n|");
  });
});
