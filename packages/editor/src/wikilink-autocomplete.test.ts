import {
  acceptCompletion,
  completionStatus,
  currentCompletions,
  startCompletion,
} from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import type { LinkTargets } from "@personal-wiki/markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "./create-editor";
import { createMemoryPageIndex } from "./page-index";
import type { LinkTargetSource } from "./wikilink-autocomplete";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

function mount(
  doc = "",
  linkTargets?: LinkTargetSource,
): { view: EditorView; transactions: () => number } {
  let transactions = 0;
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, {
    doc,
    ...(linkTargets ? { linkTargets } : {}),
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
async function typeQuery(v: EditorView, query: string, prefix = ""): Promise<void> {
  const text = `${prefix}[[${query}`;
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

const NOTE_TARGETS: LinkTargets = {
  headings: ["概要", "使い方", "あいう"],
  blocks: [
    { id: "intro", preview: "最初の段落" },
    { id: "usage", preview: "- 使い方の項目" },
  ],
};

/** `Note` の page だけが見出しと block id を持つ取得元 */
function noteTargets(): LinkTargetSource & { load: ReturnType<typeof vi.fn> } {
  return {
    load: vi.fn(async (title: string) => (title === "Note" ? NOTE_TARGETS : null)),
  };
}

describe("heading and block completion", () => {
  it("lists the headings of the page named before the #", async () => {
    const targets = noteTargets();
    const { view: v } = mount("", targets);
    await typeQuery(v, "Note#");

    expect(labels(v)).toEqual(["概要", "使い方", "あいう"]);
    expect(targets.load).toHaveBeenCalledWith("Note", expect.any(AbortSignal));
  });

  it("narrows the headings as the query after the # is typed", async () => {
    const { view: v } = mount("", noteTargets());
    await typeQuery(v, "Note#使");

    expect(labels(v)).toEqual(["使い方"]);
  });

  it("inserts [[Title#heading]] with the caret after it", async () => {
    const { view: v } = mount("", noteTargets());
    await typeQuery(v, "Note#使");
    await afterInteractionDelay();

    expect(acceptCompletion(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("[[Note#使い方]]");
    expect(v.state.selection.main.head).toBe("[[Note#使い方]]".length);
  });

  it("uses the title without surrounding spaces to look the page up", async () => {
    const targets = noteTargets();
    const { view: v } = mount("", targets);
    await typeQuery(v, " Note #");

    expect(targets.load).toHaveBeenCalledWith("Note", expect.any(AbortSignal));
    expect(labels(v)).toHaveLength(3);
  });

  it("lists the block ids with a preview after #^", async () => {
    const { view: v } = mount("", noteTargets());
    await typeQuery(v, "Note#^");

    expect(labels(v)).toEqual(["intro", "usage"]);
    expect(currentCompletions(v.state).map((option) => option.detail)).toEqual([
      "最初の段落",
      "- 使い方の項目",
    ]);
  });

  it("inserts [[Title#^id]]", async () => {
    const { view: v } = mount("", noteTargets());
    await typeQuery(v, "Note#^us");
    await afterInteractionDelay();

    expect(acceptCompletion(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("[[Note#^usage]]");
    expect(v.state.selection.main.head).toBe("[[Note#^usage]]".length);
  });

  it("does not add a second ]] to a link that is already closed", async () => {
    const { view: v } = mount("[[Note#使]]", noteTargets());
    v.dispatch({ selection: { anchor: "[[Note#使".length } });
    startCompletion(v);
    await vi.waitFor(() => expect(labels(v)).toEqual(["使い方"]));
    await afterInteractionDelay();

    acceptCompletion(v);
    expect(v.state.doc.toString()).toBe("[[Note#使い方]]");
    expect(v.state.selection.main.head).toBe("[[Note#使い方]]".length);
  });

  it("offers nothing for a page the source does not know", async () => {
    const { view: v } = mount("", noteTargets());
    await typeQuery(v, "Missing#");
    expect(completionStatus(v.state)).toBeNull();
  });

  it("offers nothing when the source fails", async () => {
    const { view: v } = mount("", {
      load: async () => {
        throw new Error("network");
      },
    });
    await typeQuery(v, "Note#");
    expect(completionStatus(v.state)).toBeNull();
  });

  it("offers nothing for another page when no source is given", async () => {
    const { view: v } = mount();
    await typeQuery(v, "Note#");
    expect(completionStatus(v.state)).toBeNull();
  });

  it("offers nothing for a nested heading path", async () => {
    const targets = noteTargets();
    const { view: v } = mount("", targets);
    await typeQuery(v, "Note#概要#");
    expect(completionStatus(v.state)).toBeNull();
    expect(targets.load).not.toHaveBeenCalled();
  });

  it("does not offer to create a page for a query with a #", async () => {
    const { view: v } = mount("", noteTargets());
    await typeQuery(v, "Note#zzz");
    expect(completionStatus(v.state)).toBeNull();
  });

  it("lists the headings of the current page after [[#, without a source", async () => {
    const { view: v } = mount();
    const body = "# 最初\n\n自分の段落 ^mine\n\nSetext\n---\n\n";
    await typeQuery(v, "#", body);

    expect(labels(v)).toEqual(["最初", "Setext"]);
  });

  it("lists the block ids of the current page after [[#^", async () => {
    const { view: v } = mount();
    const body = "# 最初\n\n自分の段落 ^mine\n\n";
    await typeQuery(v, "#^", body);

    expect(labels(v)).toEqual(["mine"]);
    expect(currentCompletions(v.state)[0]?.detail).toBe("自分の段落");
  });

  it("does not ask the source for the current page", async () => {
    const targets = noteTargets();
    const { view: v } = mount("", targets);
    await typeQuery(v, "#", "# 最初\n\n");

    expect(labels(v)).toEqual(["最初"]);
    expect(targets.load).not.toHaveBeenCalled();
  });
});

/**
 * IME 不変条件 1 と 4。ここでは composition 中の view を作れないので、compose の userEvent と
 * `compositionstart` / `compositionend` の DOM event で遷移を模す。
 */
describe("heading and block completion and the IME invariants", () => {
  it("does not ask the source for composition input after the #", async () => {
    const targets = noteTargets();
    const { view: v, transactions } = mount("[[Note#", targets);
    v.dispatch({ selection: { anchor: "[[Note#".length } });
    const before = transactions();

    v.dispatch({
      changes: { from: 7, insert: "あ" },
      selection: { anchor: 8 },
      userEvent: "input.type.compose.start",
    });
    await afterCompletionWouldSettle();

    expect(targets.load).not.toHaveBeenCalled();
    expect(completionStatus(v.state)).toBeNull();
    expect(transactions()).toBe(before + 1);
  });

  it("drops a result that arrives after a composition has started", async () => {
    let resolve: (targets: LinkTargets) => void = () => {};
    const slow: LinkTargetSource = {
      load: () =>
        new Promise((r) => {
          resolve = r;
        }),
    };
    const { view: v, transactions } = mount("", slow);
    v.dispatch({
      changes: { from: 0, insert: "[[Note#" },
      selection: { anchor: 7 },
      userEvent: "input.type",
    });
    await vi.waitFor(() => expect(completionStatus(v.state)).toBe("pending"));

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    v.dispatch({
      changes: { from: 7, insert: "あ" },
      selection: { anchor: 8 },
      userEvent: "input.type.compose.start",
    });
    const before = transactions();
    resolve(NOTE_TARGETS);
    await afterCompletionWouldSettle();

    expect(completionStatus(v.state)).toBeNull();
    expect(currentCompletions(v.state)).toEqual([]);
    expect(transactions()).toBe(before);
  });

  it("aborts the pending request when the cursor leaves the link", async () => {
    let signal: AbortSignal | undefined;
    const slow: LinkTargetSource = {
      load: (_title, s) => {
        signal = s;
        return new Promise(() => {});
      },
    };
    const { view: v } = mount("", slow);
    v.dispatch({
      changes: { from: 0, insert: "[[Note#" },
      selection: { anchor: 7 },
      userEvent: "input.type",
    });
    await vi.waitFor(() => expect(signal).toBeDefined());

    v.dispatch({ selection: { anchor: 0 } });

    expect(signal?.aborted).toBe(true);
  });

  it("reopens the headings once after the composition settles", async () => {
    const { view: v } = mount("", noteTargets());
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    v.dispatch({
      changes: { from: 0, insert: "[[Note#あ" },
      selection: { anchor: 8 },
      userEvent: "input.type.compose.start",
    });
    expect(completionStatus(v.state)).toBeNull();

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(labels(v)).toEqual(["あいう"]));
  });
});
