import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assignBlockId, generateBlockId, pickUniqueBlockId, revealBlockId } from "./block-id";
import { createEditor } from "./create-editor";
import { isComposing } from "./ime";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc: string): EditorView {
  host = document.createElement("div");
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

const placeCursor = (v: EditorView, pos: number) => {
  v.dispatch({ selection: EditorSelection.cursor(pos) });
};

describe("generateBlockId", () => {
  it("returns an id made only of lowercase letters and digits", () => {
    expect(generateBlockId()).toMatch(/^[a-z0-9]{8}$/);
  });

  it("honors a custom length", () => {
    expect(generateBlockId(4)).toMatch(/^[a-z0-9]{4}$/);
  });
});

describe("assignBlockId", () => {
  it("appends a block id to the paragraph containing the cursor", () => {
    const DOC = "Title\n\nBody paragraph";
    const v = mount(DOC);
    placeCursor(v, DOC.indexOf("paragraph"));

    const handled = assignBlockId(v);

    expect(handled).toBe(true);
    expect(v.state.doc.toString()).toMatch(/^Title\n\nBody paragraph \^[a-z0-9]{8}$/);
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
  });

  it("does not append a second block id when the paragraph already has one", () => {
    const DOC = "Title\n\nBody paragraph ^existing";
    const v = mount(DOC);
    placeCursor(v, DOC.indexOf("paragraph"));

    const handled = assignBlockId(v);

    expect(handled).toBe(false);
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it("does not append a second block id when trailing whitespace follows the existing one", () => {
    const DOC = "Title\n\nBody paragraph ^existing  ";
    const v = mount(DOC);
    placeCursor(v, DOC.indexOf("paragraph"));

    const handled = assignBlockId(v);

    expect(handled).toBe(false);
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it("finds the enclosing paragraph even when the cursor sits at its very first offset", () => {
    const DOC = "Title\n\nBody paragraph";
    const v = mount(DOC);
    placeCursor(v, DOC.indexOf("Body"));

    const handled = assignBlockId(v);

    expect(handled).toBe(true);
    expect(v.state.doc.toString()).toMatch(/^Title\n\nBody paragraph \^[a-z0-9]{8}$/);
  });

  it("does not assign a block id outside a paragraph", () => {
    const DOC = "```\ncode\n```\n\nBody paragraph";
    const v = mount(DOC);
    placeCursor(v, DOC.indexOf("code"));

    const handled = assignBlockId(v);

    expect(handled).toBe(false);
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it("does not assign a block id inside a GFM table", () => {
    const DOC = "| a | b |\n| - | - |\n| c | d |";
    const v = mount(DOC);
    placeCursor(v, DOC.indexOf("d |"));

    const handled = assignBlockId(v);

    expect(handled).toBe(false);
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it.each(["- [ ] 未完了", "- [x] 完了", "- [-] 保留"])(
    "assigns a block id to the text of the task %j",
    (doc) => {
      const v = mount(doc);
      placeCursor(v, doc.length - 1);

      expect(assignBlockId(v)).toBe(true);
      const text = v.state.doc.toString();
      expect(text.startsWith(`${doc} `)).toBe(true);
      expect(text.slice(doc.length)).toMatch(/^ \^[a-z0-9]{8}$/);
    },
  );

  it("assigns a block id to a paragraph that contains pipes but is not a table", () => {
    const DOC = "a | b の段落";
    const v = mount(DOC);
    placeCursor(v, DOC.indexOf("b"));

    expect(assignBlockId(v)).toBe(true);
    expect(v.state.doc.toString()).toMatch(/^a \| b の段落 \^[a-z0-9]{8}$/);
  });
});

describe("revealBlockId", () => {
  it("moves the cursor to the paragraph holding the block id and highlights it", () => {
    const DOC = "Title\n\nFirst paragraph\n\nSecond paragraph ^target";
    const v = mount(DOC);
    const paragraphFrom = DOC.indexOf("Second paragraph");

    const handled = revealBlockId(v, "target");

    expect(handled).toBe(true);
    expect(v.state.selection.main.head).toBe(paragraphFrom);
    const highlight = v.contentDOM.querySelector(".cm-block-ref-highlight");
    expect(highlight?.textContent).toBe(DOC.slice(paragraphFrom));
  });

  it.each(["- [ ] 未完了 ^target", "- [-] 保留 ^target"])(
    "moves the cursor to the task holding the block id: %j",
    (task) => {
      const DOC = `前\n\n${task}`;
      const v = mount(DOC);

      expect(revealBlockId(v, "target")).toBe(true);
      expect(v.state.selection.main.head).toBe(DOC.indexOf("["));
      expect(v.contentDOM.querySelector(".cm-block-ref-highlight")).not.toBeNull();
    },
  );

  it("returns false when no block in the document has the given id", () => {
    const DOC = "Title\n\nBody paragraph ^other";
    const v = mount(DOC);

    expect(revealBlockId(v, "missing")).toBe(false);
    expect(v.contentDOM.querySelector(".cm-block-ref-highlight")).toBeNull();
  });

  describe("around a GFM table", () => {
    const TABLE = "| a | b |\n| - | - |\n| c | d |";

    it("moves to the table when the id follows the last pipe of the last row", () => {
      const DOC = `Intro\n\n${TABLE} ^trail`;
      const v = mount(DOC);

      expect(revealBlockId(v, "trail")).toBe(true);
      expect(v.state.selection.main.head).toBe(DOC.indexOf("| a"));
    });

    it("moves to the table when the id sits on the line right after it", () => {
      const DOC = `Intro\n\n${TABLE}\n^next`;
      const v = mount(DOC);

      expect(revealBlockId(v, "next")).toBe(true);
      expect(v.state.selection.main.head).toBe(DOC.indexOf("| a"));
    });

    it("moves to the id's own paragraph when it is separated from the table", () => {
      const DOC = `${TABLE}\n\n^tableid`;
      const v = mount(DOC);

      expect(revealBlockId(v, "tableid")).toBe(true);
      expect(v.state.selection.main.head).toBe(DOC.indexOf("^tableid"));
    });

    it("does not treat an id at the end of a table cell as a block id", () => {
      const DOC = "| a | b |\n| - | - |\n| c | d ^cellid |";
      const v = mount(DOC);

      expect(revealBlockId(v, "cellid")).toBe(false);
    });
  });

  it("resolves to the first occurrence when the id is duplicated", () => {
    const DOC = "First ^dup\n\nSecond ^dup";
    const v = mount(DOC);

    const handled = revealBlockId(v, "dup");

    expect(handled).toBe(true);
    expect(v.state.selection.main.head).toBe(0);
  });

  it("reveals a block id past what has synchronously parsed so far on a large document", () => {
    // @codemirror/language は文書全体を即座には parse しない。十分大きい文書なら、
    // mount 直後は末尾がまだ未parse のままのはずで、そこを ensureSyntaxTree で
    // 強制 parse できているかを確かめる。
    const filler = "填め草の段落です。".repeat(50);
    let doc = "";
    while (doc.length < 150_000) doc += `${filler}\n\n`;
    doc += "Target paragraph ^target";
    const v = mount(doc);
    const paragraphFrom = doc.indexOf("Target paragraph");

    const handled = revealBlockId(v, "target");

    expect(handled).toBe(true);
    expect(v.state.selection.main.head).toBe(paragraphFrom);
  });

  it("clears the highlight after the display duration", () => {
    vi.useFakeTimers();
    try {
      const DOC = "Body paragraph ^target";
      const v = mount(DOC);

      revealBlockId(v, "target");
      expect(v.contentDOM.querySelector(".cm-block-ref-highlight")).not.toBeNull();

      vi.advanceTimersByTime(2000);
      expect(v.contentDOM.querySelector(".cm-block-ref-highlight")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers clearing the highlight while IME composition is active", async () => {
    vi.useFakeTimers();
    try {
      const DOC = "Body paragraph ^target";
      const v = mount(DOC);

      revealBlockId(v, "target");
      v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
      expect(isComposing(v)).toBe(true);

      vi.advanceTimersByTime(2000);
      // 確定前の文字列がある間に dispatch すると IME 不変条件を破るので、
      // composition 中はタイマーが発火しても消してはいけない。
      expect(v.contentDOM.querySelector(".cm-block-ref-highlight")).not.toBeNull();

      v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
      // compositionend 通知 → measure の frame → microtask の compositionSettled dispatch →
      // setTimeout(0) 経由の setHighlight(null) dispatch、と連鎖する。間に microtask を挟むので
      // 同期の runAllTimers では辿りきれず、microtask も待つ runAllTimersAsync で消化する。
      await vi.runAllTimersAsync();
      expect(v.contentDOM.querySelector(".cm-block-ref-highlight")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pickUniqueBlockId", () => {
  it("returns the first candidate when it does not collide", () => {
    expect(pickUniqueBlockId(new Set(), () => "fresh")).toBe("fresh");
  });

  it("regenerates until the candidate is not already in use", () => {
    const seen = new Set(["dup"]);
    let calls = 0;
    const generate = () => (calls++ === 0 ? "dup" : "unique");

    expect(pickUniqueBlockId(seen, generate)).toBe("unique");
    expect(calls).toBe(2);
  });
});
