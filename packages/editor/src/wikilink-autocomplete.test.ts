import { acceptCompletion, completionStatus, currentCompletions } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "./create-editor";
import { createMemoryPageIndex } from "./page-index";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

function mount(doc = ""): { view: EditorView; transactions: () => number } {
  let transactions = 0;
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, {
    doc,
    pageIndex: createMemoryPageIndex([{ id: "p1", title: "Code" }], {
      normalize: (text) => text.toLowerCase(),
    }),
    extensions: EditorView.updateListener.of((update) => {
      transactions += update.transactions.length;
    }),
  });
  return { view, transactions: () => transactions };
}

/** `[[` の後ろに `query` を打ち、候補が出そろうのを待つ */
async function typeQuery(v: EditorView, query: string): Promise<void> {
  const text = `[[${query}`;
  v.dispatch({
    changes: { from: 0, to: v.state.doc.length, insert: text },
    selection: { anchor: text.length },
    userEvent: "input.type",
  });
  // 候補の無い query は候補 UI を開かないので、status が落ち着くのを待つ
  await afterCompletionWouldSettle();
}

const labels = (v: EditorView) =>
  currentCompletions(v.state).map((option) => option.displayLabel ?? option.label);

/** 候補 UI が開いてから確定を受け付けるまで（`interactionDelay` の 75ms）より長く待つ */
const afterInteractionDelay = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("the create option", () => {
  it("is offered only when no page matches", async () => {
    const { view: v } = mount();
    await typeQuery(v, "Co");
    expect(labels(v)).toEqual(["Code"]);

    await typeQuery(v, "Zeta");
    expect(labels(v)).toEqual(["「Zeta」を作成"]);
    expect(host?.querySelector(".cm-tooltip-autocomplete li")?.textContent).toBe("「Zeta」を作成");
  });

  it("is not offered for a blank query or a heading or block reference", async () => {
    const { view: v } = mount();
    for (const query of [" ", "Zeta#見出し", "Zeta^abc"]) {
      await typeQuery(v, query);
      expect(completionStatus(v.state)).toBeNull();
    }
  });

  it("closes the link as [[query]] with the caret after it", async () => {
    const { view: v } = mount();
    await typeQuery(v, "Zeta");
    expect(acceptCompletion(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("[[Zeta]]");
    expect(v.state.selection.main.head).toBe("[[Zeta]]".length);
  });

  it("uses the query without its surrounding spaces as the title", async () => {
    const { view: v } = mount();
    await typeQuery(v, " Zeta ");
    expect(labels(v)).toEqual(["「Zeta」を作成"]);
    expect(acceptCompletion(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("[[Zeta]]");
    expect(v.state.selection.main.head).toBe("[[Zeta]]".length);
  });

  it("does not add a second ]] to a link that is already closed", async () => {
    const { view: v } = mount("[[Zet]]");
    v.dispatch({
      changes: { from: 5, insert: "a" },
      selection: { anchor: 6 },
      userEvent: "input.type",
    });
    await vi.waitFor(() => expect(labels(v)).toEqual(["「Zeta」を作成"]));
    await afterInteractionDelay();
    acceptCompletion(v);
    expect(v.state.doc.toString()).toBe("[[Zeta]]");
    expect(v.state.selection.main.head).toBe("[[Zeta]]".length);
  });
});

/** autocomplete が source の結果を受けて dispatch しうる期間（`updateSyncTime` の 100ms）より長く待つ */
const afterCompletionWouldSettle = () => new Promise((resolve) => setTimeout(resolve, 200));

/**
 * IME 不変条件 1 と 4。ここでは composition 中の view を作れないので、source の
 * composition 判定は働かない。compose の userEvent だけで source が起動しないことを確かめる。
 * `[[` の中で入力するので、source が起動すれば候補が返り、その結果の dispatch で落ちる。
 */
it("does not start the completion source for composition input", async () => {
  const { view: v, transactions } = mount("[[");

  v.dispatch({
    changes: { from: 2, insert: "か" },
    selection: { anchor: 3 },
    userEvent: "input.type.compose.start",
  });
  expect(completionStatus(v.state)).toBeNull();

  await afterCompletionWouldSettle();
  expect(transactions()).toBe(1);
});

it("closes open candidates within the composition transaction itself", async () => {
  const { view: v, transactions } = mount();
  v.dispatch({
    changes: { from: 0, insert: "[[Co" },
    selection: { anchor: 4 },
    userEvent: "input.type",
  });
  await vi.waitFor(() => expect(completionStatus(v.state)).toBe("active"));
  const before = transactions();

  v.dispatch({
    changes: { from: 4, insert: "か" },
    selection: { anchor: 5 },
    userEvent: "input.type.compose.start",
  });
  expect(completionStatus(v.state)).toBeNull();
  expect(currentCompletions(v.state)).toEqual([]);

  await afterCompletionWouldSettle();
  expect(transactions()).toBe(before + 1);
});
