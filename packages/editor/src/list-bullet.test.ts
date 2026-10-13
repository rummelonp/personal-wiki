import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createEditor } from "./create-editor";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc: string, extensions: Extension = []): EditorView {
  host = document.createElement("div");
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

/** 画面に描かれた n 行目（0 始まり）のテキスト */
const lineText = (v: EditorView, n = 0) =>
  v.contentDOM.querySelectorAll(".cm-line")[n]?.textContent ?? "";

const placeCursor = (v: EditorView, ...positions: number[]) => {
  v.focus();
  v.dispatch({
    selection: EditorSelection.create(positions.map((p) => EditorSelection.cursor(p))),
  });
};

describe("list bullet decoration", () => {
  it.each(["-", "*", "+"])("replaces %j with a bullet", (marker) => {
    const v = mount(`${marker} 項目`);
    expect(lineText(v)).toBe("• 項目");
    expect(v.state.doc.toString()).toBe(`${marker} 項目`);
  });

  it("leaves ordered list markers untouched", () => {
    const v = mount("1. 項目\n2. 次");
    expect(lineText(v, 0)).toBe("1. 項目");
    expect(lineText(v, 1)).toBe("2. 次");
  });

  it("replaces the marker of nested items at every level", () => {
    const v = mount("- 親\n  - 子");
    expect(lineText(v, 0)).toBe("• 親");
    expect(lineText(v, 1)).toBe("  • 子");
  });

  it("hides the marker of a task list item and leaves only the checkbox", () => {
    const v = mount("- [ ] task\n  - [x] nested");
    const lines = v.contentDOM.querySelectorAll(".cm-line");
    for (const line of lines) {
      expect(line.querySelector(".cm-lp-list-bullet")).toBeNull();
      expect(line.querySelector(".cm-lp-task-checkbox")).not.toBeNull();
    }
    expect(lineText(v, 0)).toBe(" task");
    expect(lineText(v, 1)).toBe("   nested");
    expect(v.state.doc.toString()).toBe("- [ ] task\n  - [x] nested");
  });

  it("keeps the number of an ordered task list item next to the checkbox", () => {
    const v = mount("1. [ ] task");
    expect(lineText(v)).toBe("1.  task");
    expect(v.contentDOM.querySelector(".cm-lp-task-checkbox")).not.toBeNull();
  });

  it("leaves `-` inside a fenced code block as source", () => {
    const v = mount("```\n- 項目\n```");
    expect(lineText(v, 1)).toBe("- 項目");
  });
});

describe("list bullet reveal", () => {
  const DOC = "- 項目";

  it("shows the source while the cursor touches the marker", () => {
    const v = mount(DOC);
    placeCursor(v, 1);
    expect(lineText(v)).toBe(DOC);
  });

  it("keeps the bullet once the cursor moves past the marker into the content", () => {
    const v = mount(DOC);
    placeCursor(v, DOC.indexOf("項"));
    expect(lineText(v)).toBe("• 項目");
  });

  it("shows the source when any of multiple cursors touches the marker", () => {
    const v = mount(DOC, EditorState.allowMultipleSelections.of(true));
    placeCursor(v, DOC.length, 0);
    expect(v.state.selection.ranges).toHaveLength(2);
    expect(lineText(v)).toBe(DOC);
  });

  it("moves the cursor onto the marker when the bullet is clicked", () => {
    const v = mount(DOC);
    // マーカーから離れた位置から始める。0 は初期カーソル位置と重なり、クリックが効かなくても
    // 区別が付かない。
    placeCursor(v, DOC.length);
    const bullet = v.contentDOM.querySelector(".cm-lp-list-bullet");
    if (!bullet) throw new Error("bullet is not drawn");
    const rect = bullet.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    bullet.dispatchEvent(new MouseEvent("mousedown", init));
    bullet.dispatchEvent(new MouseEvent("mouseup", init));

    const { main } = v.state.selection;
    expect(main.empty).toBe(true);
    // クリック前にマーカーから離れた位置へ置いてから検証する。0 は初期カーソル位置でもあるため、
    // 動かさずに 0 のままでも旧 assertion（0〜1 の範囲）は素通りしていた。
    expect(main.head).toBe(0);
    expect(lineText(v)).toBe(DOC);
  });
});
