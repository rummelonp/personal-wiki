import { Compartment, EditorState } from "@codemirror/state";
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

  it("does nothing once the view is destroyed", () => {
    const looked = mount();
    const before = vi.fn();
    // 破棄の前に 1 度引いておく view と、破棄の前に 1 度も引かない view の両方を確かめる
    dispatchWhenSettled(looked, "a", before);
    expect(before).toHaveBeenCalledTimes(1);
    looked.destroy();
    host?.remove();
    const fresh = mount();
    fresh.destroy();
    view = null;

    const after = vi.fn();
    expect(() => dispatchWhenSettled(looked, "a", after)).not.toThrow();
    expect(() => dispatchWhenSettled(fresh, "a", after)).not.toThrow();
    expect(after).not.toHaveBeenCalled();
  });

  it("keeps working in a view whose extension was removed and added back by reconfigure", () => {
    host = document.createElement("div");
    document.body.append(host);
    const compartment = new Compartment();
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: "", extensions: compartment.of(settledDispatch) }),
    });
    const before = vi.fn();
    dispatchWhenSettled(view, "a", before);
    expect(before).toHaveBeenCalledTimes(1);

    view.dispatch({ effects: compartment.reconfigure([]) });
    // view は生きているので、破棄済みとして黙って捨てず、extension が無いことを知らせる
    const during = vi.fn();
    expect(() => dispatchWhenSettled(view as EditorView, "a", during)).toThrow();
    expect(during).not.toHaveBeenCalled();

    view.dispatch({ effects: compartment.reconfigure(settledDispatch) });
    const after = vi.fn();
    dispatchWhenSettled(view, "a", after);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("drops held actions when the extension is removed by reconfigure", async () => {
    host = document.createElement("div");
    document.body.append(host);
    const compartment = new Compartment();
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: "", extensions: compartment.of(settledDispatch) }),
    });
    const action = vi.fn();
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    dispatchWhenSettled(view, "a", action);
    view.dispatch({ effects: compartment.reconfigure([]) });
    await settle();
    expect(action).not.toHaveBeenCalled();
  });

  it("releases held actions even when the measure skips its write phase", async () => {
    const v = mount();
    const action = vi.fn();
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    dispatchWhenSettled(v, "a", action);
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    // read と write の間で更新が例外を投げると、CodeMirror は write を呼ばずに measure を抜ける。
    // その状況を、保留中の request から write を外して作る
    const requests = (v as unknown as { measureRequests: { key?: unknown; write?: unknown }[] })
      .measureRequests;
    const request = requests.find((r) => String(r.key) === "Symbol(compositionSettled)");
    expect(request).toBeDefined();
    (request as { write?: unknown }).write = undefined;

    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });

  it("refuses a view without the extension", () => {
    host = document.createElement("div");
    document.body.append(host);
    view = new EditorView({ parent: host, state: EditorState.create({ doc: "" }) });
    expect(() => dispatchWhenSettled(view as EditorView, "a", () => {})).toThrow();
  });
});
