import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { assignBlockId } from "./block-id";
import { createEditor } from "./create-editor";
import { createMemoryPageIndex } from "./page-index";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc: string): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, { doc, readOnly: true });
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

function dataTransferWithText(text: string): DataTransfer {
  const dataTransfer = new DataTransfer();
  dataTransfer.setData("text/plain", text);
  return dataTransfer;
}

function dispatchPaste(v: EditorView, dataTransfer: DataTransfer) {
  v.contentDOM.dispatchEvent(
    new ClipboardEvent("paste", { bubbles: false, cancelable: true, clipboardData: dataTransfer }),
  );
}

function dispatchDrop(v: EditorView, dataTransfer: DataTransfer) {
  v.contentDOM.dispatchEvent(
    new DragEvent("drop", {
      bubbles: false,
      cancelable: true,
      clientX: 0,
      clientY: 0,
      dataTransfer,
    }),
  );
}

// 閲覧のみの view も focus・カーソル移動はできる（`EditorView.editable` は true のまま）。
// `EditorState.readOnly` が入力側の transaction だけを拒む。IME の確定を拒むことは、
// 本物の composition を作れないこのテストでは確かめられない。CDP で IME 入力を流す E2E を
// 足すまでは未確認のまま残る。
describe("createEditor({ readOnly: true })", () => {
  it("keeps the view focusable so the cursor can move in", async () => {
    const v = mount("本文");
    expect(v.contentDOM.getAttribute("contenteditable")).toBe("true");
    expect(v.hasFocus).toBe(false);

    await userEvent.click(v.contentDOM);
    expect(v.hasFocus).toBe(true);
  });

  it("rejects typed keyboard input", async () => {
    const doc = "本文";
    const v = mount(doc);
    await userEvent.click(v.contentDOM);
    await userEvent.keyboard("あ");
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("rejects a paste", () => {
    const doc = "本文";
    const v = mount(doc);
    v.dispatch({ selection: { anchor: 1 } });
    dispatchPaste(v, dataTransferWithText("差し込み"));
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("rejects a drop", () => {
    const doc = "本文";
    const v = mount(doc);
    dispatchDrop(v, dataTransferWithText("差し込み"));
    expect(v.state.doc.toString()).toBe(doc);
  });

  // Mod-Alt-b は Prec.highest の keymap で無条件に入るので、コマンド自身が readOnly を見ないと
  // ` ^xxxxxx` が保存されない編集として入ってしまう。Mod キーの実キー組み合わせはプラットフォーム
  // 依存なので、keymap 経由ではなくコマンドを直接呼んで検証する
  it("does not assign a block id when the view is read-only", () => {
    const doc = "本文";
    const v = mount(doc);
    v.dispatch({ selection: { anchor: 1 } });
    expect(assignBlockId(v)).toBe(false);
    expect(v.state.doc.toString()).toBe(doc);
  });

  // pageIndex を渡していても readOnly なら wikiLinkAutocomplete 自体を
  // 積まない（tooltip の mousedown は acceptCompletion と違い readOnly を見ないため、候補 UI を
  // 出さないことで塞ぐ）。閉じた [[Foo]] の ]] 直前は OPEN_LINK にも一致するため、readOnly で
  // 到達しうる（readOnly でも focus できるため）。
  it("does not offer wikilink autocomplete when the view is read-only", () => {
    host = document.createElement("div");
    document.body.append(host);
    const doc = "[[Cod";
    view = createEditor(host, {
      doc,
      readOnly: true,
      pageIndex: createMemoryPageIndex([{ id: "p1", title: "Code" }], {
        normalize: (text) => text.toLowerCase(),
      }),
    });
    view.dispatch({ selection: { anchor: doc.length } });
    startCompletion(view);
    expect(completionStatus(view.state)).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
  });
});
