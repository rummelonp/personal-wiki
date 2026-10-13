import { completionStatus } from "@codemirror/autocomplete";
import { undoDepth } from "@codemirror/commands";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { type CreateEditorOptions, createEditor } from "./create-editor";
import { isCompositionUnsettled } from "./ime";
import { createMemoryPageIndex } from "./page-index";
import { setReadOnly } from "./read-only";
import { replaceDoc } from "./replace-doc";
import type { LinkTargetSource } from "./wikilink-autocomplete";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

function mount(doc: string, options: CreateEditorOptions = {}): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, { doc, ...options });
  return view;
}

const pageIndex = createMemoryPageIndex([{ id: "p1", title: "Note" }], {
  normalize: (text) => text.toLowerCase(),
});

const optionTexts = () =>
  [...document.querySelectorAll(".cm-tooltip-autocomplete li")].map((li) => li.textContent);

/** autocomplete が source の結果を受けて dispatch しうる期間（`updateSyncTime` の 100ms）より長く待つ */
const afterCompletionWouldSettle = () => new Promise((resolve) => setTimeout(resolve, 200));

const pressModU = (v: EditorView) =>
  runScopeHandlers(
    v,
    new KeyboardEvent("keydown", {
      key: "u",
      ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
    }),
    "editor",
  );

describe("setReadOnly", () => {
  it("rejects keyboard input while read-only and accepts it again after switching back", async () => {
    const v = mount("本文");
    setReadOnly(v, true);
    expect(v.state.readOnly).toBe(true);
    v.focus();
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    await userEvent.keyboard("x");
    expect(v.state.doc.toString()).toBe("本文");

    setReadOnly(v, false);
    expect(v.state.readOnly).toBe(false);
    await userEvent.keyboard("y");
    expect(v.state.doc.toString()).toBe("本文y");
  });

  it("drops a change dispatched by a path that does not look at state.readOnly", () => {
    const v = mount("本文");
    setReadOnly(v, true);
    v.dispatch({ changes: { from: 2, insert: "!" }, userEvent: "input.type" });
    expect(v.state.doc.toString()).toBe("本文");
  });

  it("lets replaceDoc through and cuts the undo history", () => {
    const v = mount("古い");
    v.dispatch({ changes: { from: 2, insert: "!" }, userEvent: "input.type" });
    expect(undoDepth(v.state)).toBe(1);
    setReadOnly(v, true);
    replaceDoc(v, "新しい!");
    expect(v.state.doc.toString()).toBe("新しい!");
    expect(undoDepth(v.state)).toBe(0);
  });

  it("does not undo with Mod-u while read-only", () => {
    const v = mount("本文");
    v.dispatch({ changes: { from: 2, insert: "!" }, userEvent: "input.type" });
    setReadOnly(v, true);
    pressModU(v);
    expect(v.state.doc.toString()).toBe("本文!");

    // 書ける view では同じキーで取り消せる（キーの組み合わせが合っていることの確認）
    setReadOnly(v, false);
    pressModU(v);
    expect(v.state.doc.toString()).toBe("本文");
  });

  it("keeps the change filter when the view is created read-only", () => {
    const v = mount("本文", { readOnly: true });
    v.dispatch({ changes: { from: 2, insert: "!" }, userEvent: "input.type" });
    expect(v.state.doc.toString()).toBe("本文");
    setReadOnly(v, false);
    v.dispatch({ changes: { from: 2, insert: "!" }, userEvent: "input.type" });
    expect(v.state.doc.toString()).toBe("本文!");
  });

  it("holds the switch during composition and applies the latest one after it settles (IME invariant 1)", async () => {
    const v = mount("本文");
    let switched = 0;
    v.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          if (update.startState.readOnly !== update.state.readOnly) switched++;
        }),
      ),
    });

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    setReadOnly(v, false);
    setReadOnly(v, true);
    expect(v.state.readOnly).toBe(false);
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    expect(isCompositionUnsettled(v)).toBe(true);
    expect(v.state.readOnly).toBe(false);

    await vi.waitFor(() => expect(v.state.readOnly).toBe(true));
    expect(switched).toBe(1);
  });

  it("closes the open candidates when switching to read-only", async () => {
    const v = mount("", { pageIndex });
    v.focus();
    v.dispatch({
      changes: { from: 0, insert: "[[No" },
      selection: { anchor: 4 },
      userEvent: "input.type",
    });
    await vi.waitFor(() => expect(optionTexts()).toEqual(["Note"]));

    setReadOnly(v, true);
    expect(completionStatus(v.state)).toBeNull();
    await vi.waitFor(() => expect(optionTexts()).toEqual([]));
  });

  it("refuses a view not created by createEditor", () => {
    host = document.createElement("div");
    document.body.append(host);
    view = new EditorView({ parent: host, state: EditorState.create({ doc: "" }) });
    expect(() => setReadOnly(view as EditorView, true)).toThrow();
  });
});

describe("[[ completion while read-only", () => {
  function linkTargets() {
    return {
      load: vi.fn<LinkTargetSource["load"]>(async () => ({ headings: ["概要"], blocks: [] })),
    };
  }

  it("does not open the candidates or load the link targets on Ctrl-Space", async () => {
    const targets = linkTargets();
    const v = mount("[[Note#", { pageIndex, linkTargets: targets });
    setReadOnly(v, true);
    v.focus();
    v.dispatch({ selection: { anchor: v.state.doc.length } });

    await userEvent.keyboard("{Control>} {/Control}");
    await afterCompletionWouldSettle();
    expect(optionTexts()).toEqual([]);
    expect(completionStatus(v.state)).toBeNull();
    expect(targets.load).not.toHaveBeenCalled();

    // 同じ操作で、書ける view では候補が開く（キーの組み合わせが届いていることの確認）
    setReadOnly(v, false);
    await userEvent.keyboard("{Control>} {/Control}");
    await vi.waitFor(() => expect(optionTexts()).toEqual(["概要"]));
    expect(targets.load).toHaveBeenCalledTimes(1);
  });

  it("does not reopen the candidates after a composition settles", async () => {
    const targets = linkTargets();
    const v = mount("[[Note#", { pageIndex, linkTargets: targets, readOnly: true });
    // source が null を返して候補が出なくても、補完を始めたこと自体を見分けるために記録する
    const statuses: (string | null)[] = [];
    v.dispatch({
      selection: { anchor: v.state.doc.length },
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => statuses.push(completionStatus(update.state))),
      ),
    });
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(isCompositionUnsettled(v)).toBe(false));
    await afterCompletionWouldSettle();
    expect(optionTexts()).toEqual([]);
    expect(statuses.filter((status) => status !== null)).toEqual([]);
    expect(targets.load).not.toHaveBeenCalled();
  });
});
