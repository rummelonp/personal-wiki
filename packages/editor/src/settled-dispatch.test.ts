import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchWhenSettled, settledDispatch } from "./settled-dispatch";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

function mount(): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({ doc: "", extensions: settledDispatch }),
  });
  return view;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("dispatchWhenSettled", () => {
  it("runs at once outside composition", () => {
    const v = mount();
    const action = vi.fn();
    dispatchWhenSettled(v, "a", action);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("holds actions during composition (IME invariant 1) and runs the latest per key once, in the order the keys were first held", async () => {
    const v = mount();
    const calls: string[] = [];
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    dispatchWhenSettled(v, "a", () => calls.push("a1"));
    dispatchWhenSettled(v, "b", () => calls.push("b1"));
    dispatchWhenSettled(v, "a", () => calls.push("a2"));
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    expect(calls).toEqual([]);

    await vi.waitFor(() => expect(calls).toEqual(["a2", "b1"]));
    await settle();
    expect(calls).toEqual(["a2", "b1"]);
  });

  it("does not run a held action that an earlier action has already superseded", async () => {
    const v = mount();
    const calls: string[] = [];
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    dispatchWhenSettled(v, "a", () => {
      calls.push("a");
      // 落ち着いた後なので、その場で実行され、保留していた b の古い action を置き換える
      dispatchWhenSettled(v, "b", () => calls.push("b-new"));
    });
    dispatchWhenSettled(v, "b", () => calls.push("b-old"));
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));

    await vi.waitFor(() => expect(calls).toEqual(["a", "b-new"]));
    await settle();
    expect(calls).toEqual(["a", "b-new"]);
  });

  it("drops held actions when the view is destroyed", async () => {
    const v = mount();
    const action = vi.fn();
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    dispatchWhenSettled(v, "a", action);
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    v.destroy();
    view = null;
    await settle();
    expect(action).not.toHaveBeenCalled();
  });

  it("refuses a view without the extension", () => {
    host = document.createElement("div");
    document.body.append(host);
    view = new EditorView({ parent: host, state: EditorState.create({ doc: "" }) });
    expect(() => dispatchWhenSettled(view as EditorView, "a", () => {})).toThrow();
  });
});
