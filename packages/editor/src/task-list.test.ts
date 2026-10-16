import { undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CreateEditorOptions, createEditor } from "./create-editor";
import { isCompositionUnsettled } from "./ime";
import { setReadOnly } from "./read-only";
import { resetScheme, setScheme } from "./test-tokens";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  resetScheme();
});

function mount(doc: string, options: CreateEditorOptions = {}): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = createEditor(host, { doc, ...options });
  cleanups.push(() => {
    view.destroy();
    host.remove();
  });
  return view;
}

const checkboxes = (v: EditorView) => [
  ...v.contentDOM.querySelectorAll<HTMLInputElement>(".cm-lp-task-checkbox"),
];
const lineTexts = (v: EditorView) =>
  [...v.contentDOM.querySelectorAll(".cm-line")].map((line) => line.textContent ?? "");
const checkedTexts = (v: EditorView) =>
  [...v.contentDOM.querySelectorAll(".cm-lp-task-checked")].map((el) => el.textContent ?? "");

const placeCursor = (v: EditorView, ...positions: number[]) => {
  v.focus();
  v.dispatch({
    selection: EditorSelection.create(positions.map((p) => EditorSelection.cursor(p))),
  });
};

function press(checkbox: HTMLInputElement | undefined): void {
  if (!checkbox) throw new Error("checkbox is not drawn");
  checkbox.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
  );
}

const countTransactions = (onCount: () => void): Extension =>
  EditorView.updateListener.of((update) => {
    for (const _ of update.transactions) onCount();
  });

describe("task list checkbox name", () => {
  const names = (v: EditorView) => checkboxes(v).map((box) => box.getAttribute("aria-label"));

  it("タスクの本文を名前にする", () => {
    expect(names(mount("- [ ] 牛乳を買う\n- [x] 掃除"))).toEqual(["牛乳を買う", "掃除"]);
  });

  it("番号付きリストのタスクも本文を名前にする", () => {
    expect(names(mount("1. [ ] 手順"))).toEqual(["手順"]);
  });

  it("強調、リンク、WikiLink の記号は名前から除く", () => {
    const v = mount(
      "- [ ] **大事** な [リンク](https://example.com) と [[ページ|別名]] を `code` で",
    );
    expect(names(v)).toEqual(["大事 な リンク と 別名 を code で"]);
  });

  it("本文が空のタスクは「空のタスク」にする", () => {
    expect(names(mount("- [ ] \n- [ ] %%コメントだけ%%"))).toEqual(["空のタスク", "空のタスク"]);
  });

  it("行頭の記号に見える本文は、見えている文字のまま名前にする", () => {
    expect(
      names(mount("- [ ] 1. 手順\n- [ ] 2026. 年の目標\n- [ ] - 牛乳\n- [ ] # 見出し風")),
    ).toEqual(["1. 手順", "2026. 年の目標", "- 牛乳", "# 見出し風"]);
  });

  it("本文を書き換えると名前も変わる", () => {
    const v = mount("- [ ] 牛乳");
    v.dispatch({ changes: { from: "- [ ] 牛乳".length, insert: "を買う" } });
    expect(names(v)).toEqual(["牛乳を買う"]);
  });

  it("名前だけが変わるときは同じ checkbox の要素を使い続ける", () => {
    const v = mount("- [ ] 牛乳");
    const before = checkboxes(v)[0];
    v.dispatch({ changes: { from: "- [ ] 牛乳".length, insert: "を買う" } });
    expect(checkboxes(v)[0]).toBe(before);
    expect(before?.getAttribute("aria-label")).toBe("牛乳を買う");
  });

  it("チェックの状態が変わるときは checkbox の要素を作り直す", () => {
    const v = mount("- [ ] 牛乳");
    const before = checkboxes(v)[0];
    press(before);
    expect(checkboxes(v)[0]).not.toBe(before);
    expect(checkboxes(v)[0]?.checked).toBe(true);
  });
});

describe("task list checkbox", () => {
  it.each([
    ["- [ ] 未完了", false, " 未完了"],
    ["- [x] 完了", true, " 完了"],
    ["- [X] 大文字", true, " 大文字"],
    ["- [-] 取り消し", true, " 取り消し"],
    ["- [?] 疑問", true, " 疑問"],
    ["- [😀] 絵文字", true, " 絵文字"],
    ["1. [x] 番号付き", true, "1.  番号付き"],
  ])("draws %j as a checkbox in place of the brackets and the bullet", (doc, checked, text) => {
    const v = mount(doc);
    expect(checkboxes(v).map((box) => box.checked)).toEqual([checked]);
    expect(lineTexts(v)).toEqual([text]);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("strikes through only the text of checked tasks", () => {
    const v = mount("- [ ] 未完了\n- [x] 完了\n- [-] 保留");
    expect(checkedTexts(v)).toEqual([" 完了", " 保留"]);
  });

  it.each([
    ["a fenced code block", "```\n- [ ] a\n```"],
    ["a paragraph outside a list", "[ ] a"],
    ["a bracket without trailing whitespace", "- [ ]"],
    ["two characters in the bracket", "- [xx] a"],
    ["a backtick in the bracket", "- [`] #tag `x`"],
  ])("draws no checkbox in %s", (_, doc) => {
    const v = mount(doc);
    expect(checkboxes(v)).toHaveLength(0);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("draws nested tasks and tasks in a blockquote", () => {
    const v = mount("- [ ] 親\n  - [x] 子\n> - [-] 引用");
    expect(checkboxes(v).map((box) => box.checked)).toEqual([false, true, true]);
  });

  it("reveals the bullet and the brackets together when a cursor touches either and keeps the checkbox at the start of the text", () => {
    const doc = "- [ ] a";
    const v = mount(doc);
    for (const pos of [0, 2, 3, 5]) {
      placeCursor(v, pos);
      expect(checkboxes(v)).toHaveLength(0);
      // 記号とブラケットの片方だけが source に戻った `[ ] a` や `- ☐ a` にならない
      expect(lineTexts(v)).toEqual([doc]);
    }
    // 本文の先頭（`] ` の後ろ）では隠したまま。IME で本文の頭から打つときに replace が隣に来ない
    placeCursor(v, doc.indexOf("a"));
    expect(checkboxes(v)).toHaveLength(1);
  });

  it("reveals only the task each cursor touches", () => {
    const doc = "- [ ] a\n- [x] b\n- [ ] c";
    const v = mount(doc, { extensions: EditorState.allowMultipleSelections.of(true) });
    placeCursor(v, doc.indexOf("[x]") + 1, doc.lastIndexOf("[ ]"));
    // 触れていない 1 行目だけが checkbox のまま
    expect(lineTexts(v)).toEqual([" a", "- [x] b", "- [ ] c"]);
  });

  it.each([
    ["- [ ] a", "- [x] a"],
    ["- [x] a", "- [ ] a"],
    ["- [X] a", "- [ ] a"],
    ["- [-] a", "- [ ] a"],
    ["- [?] a", "- [ ] a"],
    ["- [😀] a", "- [ ] a"],
    ["1. [ ] a", "1. [x] a"],
    ["> - [x] a", "> - [ ] a"],
  ])("toggles %j to %j on mousedown without moving the selection", (doc, toggled) => {
    const v = mount(`${doc}\n\n後`);
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    press(checkboxes(v)[0]);
    expect(v.state.doc.toString()).toBe(`${toggled}\n\n後`);
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
    expect(checkboxes(v).map((box) => box.checked)).toEqual([toggled.includes("[x]")]);
  });

  it("toggles only the task whose checkbox was pressed", () => {
    const v = mount("- [ ] a\n- [ ] b\n- [x] c");
    press(checkboxes(v)[1]);
    expect(v.state.doc.toString()).toBe("- [ ] a\n- [x] b\n- [x] c");
  });

  it("keeps the browser from toggling the checkbox on its own", () => {
    const v = mount("- [ ] a");
    const box = checkboxes(v)[0];
    if (!box) throw new Error("checkbox is not drawn");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    box.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(box.checked).toBe(false);
    expect(v.state.doc.toString()).toBe("- [ ] a");
  });

  it("ignores buttons other than the primary one", () => {
    const v = mount("- [ ] a");
    checkboxes(v)[0]?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 }),
    );
    expect(v.state.doc.toString()).toBe("- [ ] a");
  });

  it("undoes the toggle on its own, leaving the text typed just before", () => {
    const v = mount("- [-] a");
    v.dispatch({ changes: { from: v.state.doc.length, insert: "b" }, userEvent: "input.type" });
    press(checkboxes(v)[0]);
    expect(v.state.doc.toString()).toBe("- [ ] ab");
    undo(v);
    // 元の文字（`-`）に戻る。`x` に戻したり、打った `b` まで消したりしない
    expect(v.state.doc.toString()).toBe("- [-] ab");
  });

  it("ignores the checkbox until the composition settles", async () => {
    let transactions = 0;
    const v = mount("- [ ] a", { extensions: countTransactions(() => (transactions += 1)) });
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    press(checkboxes(v)[0]);
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    press(checkboxes(v)[0]);
    expect(transactions).toBe(0);
    expect(v.state.doc.toString()).toBe("- [ ] a");

    await vi.waitFor(() => expect(isCompositionUnsettled(v)).toBe(false));
    press(checkboxes(v)[0]);
    expect(v.state.doc.toString()).toBe("- [x] a");
  });

  it("disables the checkbox and never writes in a read-only editor", () => {
    const v = mount("- [ ] a", { readOnly: true });
    expect(checkboxes(v).map((box) => box.disabled)).toEqual([true]);
    press(checkboxes(v)[0]);
    expect(v.state.doc.toString()).toBe("- [ ] a");
  });

  it("redraws the checkbox when setReadOnly switches the mode", () => {
    const v = mount("- [ ] a");
    expect(checkboxes(v).map((box) => box.disabled)).toEqual([false]);
    setReadOnly(v, true);
    expect(checkboxes(v).map((box) => box.disabled)).toEqual([true]);
    setReadOnly(v, false);
    expect(checkboxes(v).map((box) => box.disabled)).toEqual([false]);
  });

  it.each(["light", "dark"] as const)(
    "%s: colors the checkbox with the accent token instead of the browser default",
    (scheme) => {
      setScheme(scheme);
      const v = mount("- [x] a");
      const box = checkboxes(v)[0];
      if (!box) throw new Error("checkbox is not drawn");
      const probe = document.createElement("span");
      probe.style.color = "var(--ui-color-accent)";
      v.dom.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      expect(getComputedStyle(box).accentColor).toBe(accent);
    },
  );

  it("draws no checkbox when Live Preview is off", () => {
    const v = mount("- [ ] a", { livePreview: false });
    expect(checkboxes(v)).toHaveLength(0);
  });
});

describe("task list checkbox after an external edit", () => {
  it("toggles the pressed task even after the edit moved it", () => {
    const v = mount("- [ ] a\n- [ ] b\n- [ ] c");
    const box = checkboxes(v)[2];
    v.dispatch({
      changes: [
        { from: 0, to: "- [ ] a\n".length, insert: "" },
        { from: 0, insert: "- [ ] 新しい行\n- [ ] もう 1 行\n" },
      ],
    });
    expect(v.state.doc.toString()).toBe("- [ ] 新しい行\n- [ ] もう 1 行\n- [ ] b\n- [ ] c");
    // 描いた後に位置がずれた widget の DOM でも、押した task を state から取り直す
    expect(box?.isConnected).toBe(true);

    press(box);
    expect(v.state.doc.toString()).toBe("- [ ] 新しい行\n- [ ] もう 1 行\n- [ ] b\n- [x] c");
  });
});
