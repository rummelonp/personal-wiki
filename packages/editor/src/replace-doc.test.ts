import { undo, undoDepth } from "@codemirror/commands";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "./create-editor";
import { isCompositionUnsettled } from "./ime";
import { changedRange, isDocReplacement, replaceDoc } from "./replace-doc";
import { createTitleEditor } from "./title-editor";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

function mount(
  doc: string,
  create: typeof createEditor | typeof createTitleEditor = createEditor,
): { v: EditorView; replacements: Transaction[] } {
  host = document.createElement("div");
  document.body.append(host);
  const replacements: Transaction[] = [];
  view = create(host, {
    doc,
    onUpdate: (update) => {
      for (const tr of update.transactions) if (isDocReplacement(tr)) replacements.push(tr);
    },
  });
  return { v: view, replacements };
}

function typeAt(v: EditorView, at: number, text: string): void {
  v.dispatch({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    userEvent: "input.type",
  });
}

describe("changedRange", () => {
  const state = (doc: string) => EditorState.create({ doc });

  it("covers only the span between the common prefix and suffix", () => {
    expect(changedRange(state("abc def ghi"), "abc XYZ ghi")).toEqual({
      from: 4,
      to: 7,
      insert: "XYZ",
    });
  });

  it("returns null when nothing changes, ignoring CRLF line breaks", () => {
    expect(changedRange(state("a\nb"), "a\nb")).toBeNull();
    expect(changedRange(state("a\nb"), "a\r\nb")).toBeNull();
  });

  it("does not split a surrogate pair", () => {
    // 😀 と 😁 は high surrogate が同じで low surrogate だけが違う
    const range = changedRange(state("a😀b"), "a😁b");
    expect(range).toEqual({ from: 1, to: 3, insert: "😁" });
  });

  it("handles a repeated character at the boundary without overlapping", () => {
    expect(changedRange(state("aaa"), "aaaa")).toEqual({ from: 3, to: 3, insert: "a" });
    expect(changedRange(state("aaaa"), "aa")).toEqual({ from: 2, to: 4, insert: "" });
  });
});

describe("replaceDoc", () => {
  it("applies at once outside composition", () => {
    const { v, replacements } = mount("one two three");
    replaceDoc(v, "one TWO three");
    expect(v.state.doc.toString()).toBe("one TWO three");
    expect(replacements).toHaveLength(1);
  });

  it("cuts the undo history so that undo does not bring back edits made before the replacement", () => {
    // 差し替えた本文にも残る編集（保存済みの入力など）。履歴が残ると、undo で新しい本文から消える
    const { v } = mount("one two three");
    typeAt(v, 0, "> ");
    expect(undoDepth(v.state)).toBe(1);

    replaceDoc(v, "> one TWO three");
    expect(undoDepth(v.state)).toBe(0);
    expect(undo(v)).toBe(false);
    expect(v.state.doc.toString()).toBe("> one TWO three");

    // 差し替えの後の入力は、差し替えた本文まで戻せる
    typeAt(v, v.state.doc.length, "!");
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("> one TWO three");
  });

  it("keeps the undo history when the text is the same as the doc", () => {
    const { v } = mount("one");
    typeAt(v, 3, " two");
    replaceDoc(v, "one two");
    expect(undoDepth(v.state)).toBe(1);
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("one");
  });

  it("cuts the undo history in the title view as well", () => {
    const { v } = mount("Title", createTitleEditor);
    typeAt(v, 0, "My ");
    replaceDoc(v, "My Title 2");
    expect(undoDepth(v.state)).toBe(0);
    expect(undo(v)).toBe(false);
    expect(v.state.doc.toString()).toBe("My Title 2");
  });

  it("cuts the undo history only when a held replacement is applied", async () => {
    const { v } = mount("draft");
    typeAt(v, 0, "> ");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    replaceDoc(v, "> draft 2");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    expect(undoDepth(v.state)).toBe(1);

    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("> draft 2"));
    expect(undoDepth(v.state)).toBe(0);
  });

  it("maps the selection through the changed span", () => {
    const { v } = mount("alpha beta gamma");
    const gamma = "alpha beta ".length;
    v.dispatch({ selection: EditorSelection.cursor(gamma + 2) });

    replaceDoc(v, "alpha BETA-BETA gamma");
    expect(v.state.selection.main.head).toBe("alpha BETA-BETA ".length + 2);
  });

  it("does nothing when the text is the same", () => {
    const { v, replacements } = mount("same");
    replaceDoc(v, "same");
    expect(replacements).toHaveLength(0);
  });

  it("applies to a read-only view", () => {
    host = document.createElement("div");
    document.body.append(host);
    view = createEditor(host, { doc: "old", readOnly: true });
    replaceDoc(view, "new");
    expect(view.state.doc.toString()).toBe("new");
  });

  it("holds the replacement during composition and applies the latest text once after it settles", async () => {
    const { v, replacements } = mount("draft");

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    replaceDoc(v, "first");
    replaceDoc(v, "second");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    // compositionend の直後は確定文字列がまだ doc に入っていないので、ここでも待つ
    expect(isCompositionUnsettled(v)).toBe(true);
    replaceDoc(v, "third");
    expect(v.state.doc.toString()).toBe("draft");
    expect(replacements).toHaveLength(0);

    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("third"));
    expect(replacements).toHaveLength(1);
  });

  it("keeps holding when the next composition starts before the flush", async () => {
    const { v, replacements } = mount("draft");

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    replaceDoc(v, "final");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(v.state.doc.toString()).toBe("draft");

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("final"));
    expect(replacements).toHaveLength(1);
  });

  it("holds the replacement in the title view as well", async () => {
    const { v, replacements } = mount("Old title", createTitleEditor);

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    replaceDoc(v, "New title");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    expect(v.state.doc.toString()).toBe("Old title");

    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("New title"));
    expect(replacements).toHaveLength(1);
  });

  it("drops a held replacement when the view is destroyed", async () => {
    const { v } = mount("draft");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    replaceDoc(v, "late");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    v.destroy();
    view = null;
    // 破棄済みの view へ dispatch すると例外になるので、何も起きないことを確かめる
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(v.state.doc.toString()).toBe("draft");
  });

  it("refuses a view without the extension", () => {
    host = document.createElement("div");
    document.body.append(host);
    view = new EditorView({ parent: host, state: EditorState.create({ doc: "x" }) });
    expect(() => replaceDoc(view as EditorView, "y")).toThrow();
  });
});
