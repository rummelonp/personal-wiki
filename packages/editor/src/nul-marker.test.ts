import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { createEditor } from "./create-editor";
import type { ImeEvent } from "./ime";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

function mount(doc: string, options: Parameters<typeof createEditor>[1] = {}): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, { doc, ...options });
  return view;
}

const marks = (v: EditorView) => [...v.contentDOM.querySelectorAll(".cm-nul")];

it("NUL の 1 文字ずつに印を付け、doc の文字は変えない", () => {
  const v = mount("a\u0000b\n\u0000\u0000");
  expect(marks(v).map((mark) => mark.textContent)).toEqual(["\u0000", "\u0000", "\u0000"]);
  expect(v.state.doc.toString()).toBe("a\u0000b\n\u0000\u0000");
  expect(getComputedStyle(marks(v)[0] as Element, "::after").content).toContain("NUL");
});

it("source の表示（livePreview なし）でも印を付ける", () => {
  const v = mount("a\u0000", { livePreview: false });
  expect(marks(v)).toHaveLength(1);
});

it("カーソルを NUL の前後に置ける", () => {
  const v = mount("a\u0000b");
  for (const pos of [1, 2]) {
    v.dispatch({ selection: EditorSelection.cursor(pos) });
    expect(v.state.selection.main.head).toBe(pos);
  }
});

/** IME 不変条件 1。変換中に入った NUL の印は、変換が落ち着いてから 1 回で付ける */
it("変換中は組み直さず、落ち着いた後に印を付ける", async () => {
  const events: ImeEvent[] = [];
  const v = mount("abc", { onImeEvent: (event) => events.push(event) });
  v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
  v.dispatch({ changes: { from: 3, insert: "\u0000" }, userEvent: "input.type.compose" });
  expect(marks(v)).toHaveLength(0);
  expect(events.some((e) => e.kind === "decoration-skipped" && e.detail === "nul")).toBe(true);

  v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
  await vi.waitFor(() => expect(marks(v)).toHaveLength(1));
  expect(
    events.filter((e) => e.kind === "decoration-rebuild" && e.detail === "nul").length,
  ).toBeGreaterThan(0);
});
