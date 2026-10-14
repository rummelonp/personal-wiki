import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "./create-editor";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(onTagClick: (tag: { name: string }) => void): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, { doc: "本文 #仕事 です", onTagClick });
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

function press(v: EditorView, init: MouseEventInit): void {
  const tag = v.contentDOM.querySelector(".cm-tag");
  if (!tag) throw new Error("the tag is not drawn");
  tag.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, ...init }));
}

describe("tag のクリック", () => {
  it("素の左クリックだけが tag の名前を渡す", () => {
    const onTagClick = vi.fn();
    const v = mount(onTagClick);

    press(v, { button: 0 });
    expect(onTagClick).toHaveBeenCalledExactlyOnceWith({ name: "仕事" });
  });

  it("修飾キー付きと左以外のクリックは呼ばない", () => {
    const onTagClick = vi.fn();
    const v = mount(onTagClick);

    for (const init of [
      { button: 0, shiftKey: true },
      { button: 0, ctrlKey: true },
      { button: 0, metaKey: true },
      { button: 0, altKey: true },
      { button: 1 },
      { button: 2 },
    ]) {
      press(v, init);
    }
    expect(onTagClick).not.toHaveBeenCalled();
  });
});
