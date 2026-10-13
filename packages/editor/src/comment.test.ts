import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CreateEditorOptions, createEditor } from "./create-editor";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc: string, options: CreateEditorOptions = {}): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, { ...options, doc });
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

const placeCursor = (v: EditorView, pos: number) => {
  v.focus();
  v.dispatch({ selection: EditorSelection.cursor(pos) });
};

const lines = (v: EditorView) => [...v.contentDOM.querySelectorAll<HTMLElement>(".cm-line")];

/** 畳んでいない行のテキスト */
const shownLines = (v: EditorView) =>
  lines(v)
    .filter((line) => !line.classList.contains("cm-lp-comment-hidden"))
    .map((line) => line.textContent);

const collapsedLines = (v: EditorView) =>
  lines(v).filter((line) => line.classList.contains("cm-lp-comment-hidden"));

describe("comment decoration", () => {
  it("hides an inline comment while the editor is not focused", () => {
    const doc = "本文 %%メモ%% です";
    const v = mount(doc);
    expect(v.hasFocus).toBe(false);
    expect(shownLines(v)).toEqual(["本文  です"]);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("shows the comment with its markup wherever the cursor is while focused", () => {
    const doc = "本文 %%メモ%% です\n\n末尾";
    const v = mount(doc);
    for (const pos of [
      doc.length,
      doc.indexOf("%%メモ"),
      doc.indexOf("モ"),
      doc.indexOf(" です"),
    ]) {
      placeCursor(v, pos);
      expect(shownLines(v)[0]).toBe("本文 %%メモ%% です");
      expect(v.contentDOM.querySelector(".cm-lp-comment")?.textContent).toBe("%%メモ%%");
    }
  });

  it("collapses the lines of a block comment while the editor is not focused", () => {
    const v = mount("前\n%%\nメモ\n\n[[リンク]] #tag\n%%\n後");
    expect(shownLines(v)).toEqual(["前", "後"]);
    const collapsed = collapsedLines(v);
    expect(collapsed).toHaveLength(5);
    for (const line of collapsed) {
      expect(line.textContent).toBe("");
      expect(getComputedStyle(line).display).toBe("none");
    }
    // コメントの中身は WikiLink や tag として装飾しない
    expect(v.contentDOM.querySelector("[data-wikilink-target]")).toBeNull();
    expect(v.contentDOM.querySelector(".cm-tag")).toBeNull();
  });

  it("shows every line of a block comment while focused", () => {
    const doc = "前\n%%\nメモ\n%%\n後";
    const v = mount(doc);
    placeCursor(v, doc.length);
    expect(shownLines(v)).toEqual(["前", "%%", "メモ", "%%", "後"]);
    expect(collapsedLines(v)).toHaveLength(0);
  });

  it("shows comments in a read-only editor once it gains focus, and hides them again on blur", async () => {
    const doc = "本文 %%メモ%% です";
    const v = mount(doc, { readOnly: true });
    expect(v.hasFocus).toBe(false);
    expect(shownLines(v)).toEqual(["本文  です"]);

    v.focus();
    await vi.waitFor(() => expect(v.hasFocus).toBe(true));
    await vi.waitFor(() => expect(shownLines(v)).toEqual([doc]));

    v.contentDOM.blur();
    await vi.waitFor(() => expect(shownLines(v)).toEqual(["本文  です"]));
  });

  it("keeps a comment closed by a %% line hidden and the text after it shown in a read-only editor that is not focused", () => {
    const v = mount("Some text %%\nmulti\n%%\n\n後", { readOnly: true });
    expect(shownLines(v)).toEqual(["Some text ", "", "後"]);
    expect(collapsedLines(v).map((line) => line.textContent)).toEqual(["", ""]);
  });

  // CodeMirror は focus の変化を、dispatch が無ければ少し遅れて（setTimeout で）view に反映する。
  it("shows and hides comments as the same view gains and loses focus", async () => {
    const doc = "前 %%メモ%% 後\n%%\nブロック\n%%\n末尾";
    const v = mount(doc);
    const hidden = ["前  後", "末尾"];
    const shown = ["前 %%メモ%% 後", "%%", "ブロック", "%%", "末尾"];
    expect(shownLines(v)).toEqual(hidden);
    placeCursor(v, doc.length);
    expect(shownLines(v)).toEqual(shown);
    v.contentDOM.blur();
    await vi.waitFor(() => expect(shownLines(v)).toEqual(hidden));
    v.focus();
    await vi.waitFor(() => expect(shownLines(v)).toEqual(shown));
  });

  it("hides a comment across a soft break in a blockquote without touching the quote markup", () => {
    const v = mount("> 前 %%a\n> b%% 後");
    expect(shownLines(v)).toEqual(["前 ", " 後"]);
  });

  it("skips cursor motion over a hidden comment", () => {
    const doc = "abc %%def%% ghi";
    const v = mount(doc);
    v.contentDOM.blur();
    const start = doc.indexOf("%%");
    expect(v.moveByChar(EditorSelection.cursor(start), true).head).toBe(doc.indexOf(" ghi"));
  });
});
