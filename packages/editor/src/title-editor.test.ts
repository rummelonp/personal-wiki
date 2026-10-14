import { EditorSelection, StateEffect } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, test } from "vitest";
import { createEditor } from "./create-editor";
import { setReadOnly } from "./read-only";
import { replaceDoc } from "./replace-doc";
import { createTitleEditor } from "./title-editor";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function mount(create: (parent: HTMLElement) => EditorView): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = create(parent);
  cleanups.push(() => {
    view.destroy();
    parent.remove();
  });
  return view;
}

function setup(title = "題名", body = "一行目\n二行目") {
  const bodyView = mount((parent) => createEditor(parent, { doc: body }));
  const titleView = mount((parent) =>
    createTitleEditor(parent, { doc: title, bodyView: () => bodyView }),
  );
  titleView.dispatch({ selection: EditorSelection.cursor(title.length) });
  return { titleView, bodyView };
}

const press = (view: EditorView, key: string, init: KeyboardEventInit = {}) =>
  runScopeHandlers(view, new KeyboardEvent("keydown", { key, ...init }), "editor");

function placeholderOf(view: EditorView): string {
  const line = view.contentDOM.querySelector(".cm-line");
  if (!line) throw new Error("the title has no line");
  return getComputedStyle(line, "::before").content;
}

/** 空の alt text 付きの「タイトルを入力」。a11y ツリーには出ない */
const PLACEHOLDER = '"タイトルを入力" / ""';

describe("createTitleEditor", () => {
  test("replaces newlines in pasted text with spaces", () => {
    const { titleView } = setup();
    titleView.dispatch({
      changes: { from: 2, insert: "a\nb\r\nc" },
      selection: { anchor: 7 },
      userEvent: "input.paste",
    });
    expect(titleView.state.doc.toString()).toBe("題名a b c");
    expect(titleView.state.doc.lines).toBe(1);
    expect(titleView.state.selection.main.head).toBe(7);
  });

  test("Enter moves to the end of the body's first line without touching the title", () => {
    const { titleView, bodyView } = setup();
    expect(press(titleView, "Enter")).toBe(true);
    expect(titleView.state.doc.toString()).toBe("題名");
    expect(document.activeElement).toBe(bodyView.contentDOM);
    expect(bodyView.state.selection.main.head).toBe("一行目".length);
  });

  test("Shift+Enter and Mod-Enter never insert a newline either", () => {
    const { titleView } = setup();
    press(titleView, "Enter", { shiftKey: true });
    press(titleView, "Enter", { ctrlKey: true });
    press(titleView, "Enter", { metaKey: true });
    expect(titleView.state.doc.toString()).toBe("題名");
  });

  test("Enter without a body view does not insert a newline", () => {
    const titleView = mount((parent) => createTitleEditor(parent, { doc: "題名" }));
    titleView.dispatch({ selection: EditorSelection.cursor(2) });
    expect(press(titleView, "Enter")).toBe(true);
    expect(titleView.state.doc.toString()).toBe("題名");
  });

  test("Enter calls onCommit before the body takes focus, and ArrowDown does not", () => {
    const bodyView = mount((parent) => createEditor(parent, { doc: "一行目" }));
    const focusedOnCommit: (Element | null)[] = [];
    const titleView = mount((parent) =>
      createTitleEditor(parent, {
        doc: "題名",
        bodyView: () => bodyView,
        onCommit: () => focusedOnCommit.push(document.activeElement),
      }),
    );

    titleView.dispatch({ selection: EditorSelection.cursor(2) });
    press(titleView, "ArrowDown");
    expect(focusedOnCommit).toHaveLength(0);

    titleView.focus();
    press(titleView, "Enter");
    expect(focusedOnCommit).toEqual([titleView.contentDOM]);
    expect(document.activeElement).toBe(bodyView.contentDOM);
  });

  test("Enter calls onCommit even without a body view to move to", () => {
    let commits = 0;
    const titleView = mount((parent) =>
      createTitleEditor(parent, {
        doc: "題名",
        onCommit: () => {
          commits += 1;
        },
      }),
    );
    press(titleView, "Enter");
    expect(commits).toBe(1);
  });

  // IME 不変条件 3。CodeMirror は DOM の変更を読んだ後の変換中の keydown を keymap より前に捨てるので、
  // 実際のキー入力ではこの guard に届かない。届くのは compositionstart の直後（まだ DOM の変更が無い）と、
  // Safari で compositionend と keydown の順序が入れ替わったときなので、keymap を直接呼んで確かめる
  test("Enter on an empty or blank title stays in the title without committing", () => {
    for (const title of ["", "   "]) {
      const bodyView = mount((parent) => createEditor(parent, { doc: "一行目" }));
      let commits = 0;
      const titleView = mount((parent) =>
        createTitleEditor(parent, {
          doc: title,
          bodyView: () => bodyView,
          onCommit: () => {
            commits += 1;
          },
        }),
      );
      titleView.focus();
      titleView.dispatch({ selection: EditorSelection.cursor(title.length) });
      expect(press(titleView, "Enter")).toBe(true);
      expect(commits).toBe(0);
      expect(document.activeElement).toBe(titleView.contentDOM);
      expect(titleView.state.doc.toString()).toBe(title);
    }
  });

  test("Enter and ArrowDown leave the keys to the IME during composition", () => {
    const bodyView = mount((parent) => createEditor(parent, { doc: "一行目" }));
    let commits = 0;
    const titleView = mount((parent) =>
      createTitleEditor(parent, {
        doc: "題名",
        bodyView: () => bodyView,
        onCommit: () => {
          commits += 1;
        },
      }),
    );
    titleView.focus();
    titleView.dispatch({ selection: EditorSelection.cursor(2) });
    titleView.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(titleView.compositionStarted).toBe(true);

    expect(press(titleView, "Enter")).toBe(false);
    press(titleView, "ArrowDown");
    expect(commits).toBe(0);
    expect(document.activeElement).toBe(titleView.contentDOM);
    expect(titleView.state.doc.toString()).toBe("題名");
  });

  // CodeMirror が compositionend の直後に捨てる Safari の Enter は Chromium では作れないので、
  // その窓の外で届いた keyCode 229 の Enter を、実際の keydown として流して確かめる
  test("an Enter keydown with keyCode 229 after the composition is left to the IME", () => {
    const bodyView = mount((parent) => createEditor(parent, { doc: "一行目" }));
    let commits = 0;
    const titleView = mount((parent) =>
      createTitleEditor(parent, {
        doc: "題名",
        bodyView: () => bodyView,
        onCommit: () => {
          commits += 1;
        },
      }),
    );
    titleView.focus();
    const keydown = (keyCode: number) =>
      titleView.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", keyCode, bubbles: true, cancelable: true }),
      );

    keydown(229);
    expect(commits).toBe(0);
    expect(document.activeElement).toBe(titleView.contentDOM);

    keydown(13);
    expect(commits).toBe(1);
    expect(document.activeElement).toBe(bodyView.contentDOM);
  });

  test("ArrowDown moves to the start of the body", () => {
    const { titleView, bodyView } = setup();
    bodyView.dispatch({ selection: EditorSelection.cursor(5) });
    expect(press(titleView, "ArrowDown")).toBe(true);
    expect(document.activeElement).toBe(bodyView.contentDOM);
    expect(bodyView.state.selection.main.head).toBe(0);
  });

  test("ArrowDown in a wrapped title moves between its lines before moving to the body", () => {
    const bodyView = mount((parent) => createEditor(parent, { doc: "本文" }));
    const title = "折り返す長いタイトル".repeat(4);
    const titleView = mount((parent) => {
      parent.style.width = "160px";
      return createTitleEditor(parent, { doc: title, bodyView: () => bodyView });
    });
    titleView.dispatch({ selection: EditorSelection.cursor(0) });

    press(titleView, "ArrowDown");
    expect(document.activeElement).not.toBe(bodyView.contentDOM);
    expect(titleView.state.selection.main.head).toBeGreaterThan(0);

    titleView.dispatch({ selection: EditorSelection.cursor(title.length) });
    expect(press(titleView, "ArrowDown")).toBe(true);
    expect(document.activeElement).toBe(bodyView.contentDOM);
  });

  test("line commands of the default keymap leave the title alone", () => {
    const { titleView } = setup();
    press(titleView, "ArrowDown", { shiftKey: true, altKey: true });
    press(titleView, "ArrowUp", { shiftKey: true, altKey: true });
    press(titleView, "o", { ctrlKey: true });
    expect(titleView.state.doc.toString()).toBe("題名");
  });

  test("shows the placeholder only while the title is empty, outside the document", () => {
    const titleView = mount((parent) => createTitleEditor(parent, { doc: "" }));
    expect(placeholderOf(titleView)).toBe(PLACEHOLDER);
    expect(titleView.contentDOM.getAttribute("aria-placeholder")).toBe("タイトルを入力");
    // 文字は疑似要素にしか無いので、選択やコピー、composition の DOM に入らない
    expect(titleView.contentDOM.textContent).toBe("");

    titleView.dispatch({ changes: { from: 0, insert: "題" }, userEvent: "input.type" });
    expect(placeholderOf(titleView)).toBe("none");

    titleView.dispatch({ changes: { from: 0, to: 1 }, userEvent: "delete.backward" });
    expect(placeholderOf(titleView)).toBe(PLACEHOLDER);
  });

  test("a read-only title shows no placeholder, judged from the state rather than the option", () => {
    const readOnly = mount((parent) => createTitleEditor(parent, { doc: "", readOnly: true }));
    expect(placeholderOf(readOnly)).toBe("none");
    expect(readOnly.contentDOM.getAttribute("aria-placeholder")).toBeNull();

    const titleView = mount((parent) => createTitleEditor(parent, { doc: "" }));
    expect(placeholderOf(titleView)).toBe(PLACEHOLDER);
    setReadOnly(titleView, true);
    expect(placeholderOf(titleView)).toBe("none");
    expect(titleView.contentDOM.getAttribute("aria-placeholder")).toBeNull();
    setReadOnly(titleView, false);
    expect(placeholderOf(titleView)).toBe(PLACEHOLDER);

    const notEditable = mount((parent) => createTitleEditor(parent, { doc: "" }));
    notEditable.dispatch({ effects: StateEffect.appendConfig.of(EditorView.editable.of(false)) });
    expect(placeholderOf(notEditable)).toBe("none");
  });

  test("setReadOnly switches the same view, still focusable, and keeps host replacements", () => {
    const titleView = mount((parent) => createTitleEditor(parent, { doc: "題名" }));
    setReadOnly(titleView, true);
    expect(titleView.state.readOnly).toBe(true);
    titleView.dispatch({ changes: { from: 2, insert: "追記" }, userEvent: "input.type" });
    expect(titleView.state.doc.toString()).toBe("題名");
    expect(titleView.contentDOM.getAttribute("contenteditable")).toBe("true");

    replaceDoc(titleView, "新しい題名");
    expect(titleView.state.doc.toString()).toBe("新しい題名");

    setReadOnly(titleView, false);
    titleView.dispatch({ changes: { from: 0, insert: "続" }, userEvent: "input.type" });
    expect(titleView.state.doc.toString()).toBe("続新しい題名");
  });

  test("undo does not change a read-only title", () => {
    const titleView = mount((parent) => createTitleEditor(parent, { doc: "題名" }));
    titleView.dispatch({ changes: { from: 2, insert: "追記" }, userEvent: "input.type" });
    setReadOnly(titleView, true);
    press(titleView, "z", { ctrlKey: true });
    press(titleView, "z", { metaKey: true });
    press(titleView, "u", { ctrlKey: true });
    press(titleView, "u", { metaKey: true });
    expect(titleView.state.doc.toString()).toBe("題名追記");
  });

  test("the placeholder takes no room, so the caret and the field height stay put", () => {
    const titleView = mount((parent) => createTitleEditor(parent, { doc: "" }));
    const emptyHeight = titleView.dom.getBoundingClientRect().height;
    const emptyCaret = titleView.coordsAtPos(0);

    titleView.dispatch({ changes: { from: 0, insert: "題" } });
    expect(titleView.dom.getBoundingClientRect().height).toBe(emptyHeight);
    expect(titleView.coordsAtPos(0)?.left).toBeCloseTo(emptyCaret?.left ?? Number.NaN, 0);
  });
});
