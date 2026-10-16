import { StateEffect, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isCompositionUnsettled, isDocReplacement } from "@personal-wiki/editor";
import { act, createRef, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { TitleEditor, type TitleEditorHandle, type TitleEditorProps } from "./TitleEditor";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const noop = () => {};

function findView(): EditorView {
  const editor = container?.querySelector<HTMLElement>(".cm-editor");
  const found = editor ? EditorView.findFromDOM(editor) : null;
  if (!found) throw new Error("EditorView が無い");
  return found;
}

function render(props: Partial<TitleEditorProps> & Pick<TitleEditorProps, "value">): {
  view: () => EditorView;
  rerender: (next: Partial<TitleEditorProps>) => void;
  /** replaceDoc が出した transaction（isDocReplacement が true のもの） */
  replacements: Transaction[];
} {
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  let current: TitleEditorProps = {
    onChange: noop,
    onCommit: noop,
    onBlur: noop,
    readOnly: false,
    bodyView: () => null,
    ...props,
  };
  act(() => mounted.render(<TitleEditor {...current} />));
  const replacements: Transaction[] = [];
  findView().dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        for (const tr of update.transactions) if (isDocReplacement(tr)) replacements.push(tr);
      }),
    ),
  });
  return {
    view: findView,
    replacements,
    rerender(next) {
      current = { ...current, ...next };
      act(() => mounted.render(<TitleEditor {...current} />));
    },
  };
}

/**
 * 持ち主（PageEditor の EditorSession）の代わり。onChange を受けて value を返し直す。
 * `echo: "microtask"` は本番と同じ時機（useSyncExternalStore の通知は microtask で描く）で描き直す。
 */
function controlled(
  initial: string,
  props: Partial<TitleEditorProps> = {},
  echo: "sync" | "microtask" = "sync",
) {
  let value = initial;
  const onChange = vi.fn((next: string) => {
    value = next;
    if (echo === "sync") api.rerender({ value });
    else queueMicrotask(() => api.rerender({ value }));
  });
  const api = render({ value, onChange, ...props });
  return { ...api, onChange, value: () => value };
}

function typeAtEnd(view: EditorView, text: string, userEventName = "input.type"): void {
  const end = view.state.doc.length;
  view.dispatch({
    changes: { from: end, insert: text },
    selection: { anchor: end + text.length },
    userEvent: userEventName,
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** 変換が落ち着き、保留していた dispatch の task まで済むのを待つ */
async function settleComposition(v: EditorView) {
  await vi.waitFor(() => expect(isCompositionUnsettled(v)).toBe(false));
  await settle();
}

describe("StrictMode", () => {
  it("EditorView を 1 つだけ残し、入力と readOnly の切り替えが効く", async () => {
    container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    let value = "題";
    let readOnly = false;
    const draw = () =>
      act(() =>
        mounted.render(
          <StrictMode>
            <TitleEditor
              value={value}
              onChange={onChange}
              onCommit={noop}
              onBlur={noop}
              readOnly={readOnly}
              bodyView={() => null}
            />
          </StrictMode>,
        ),
      );
    const onChange = vi.fn((next: string) => {
      value = next;
      queueMicrotask(draw);
    });
    draw();

    expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
    const v = findView();
    v.focus();
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    await userEvent.keyboard("x");
    expect(onChange).toHaveBeenLastCalledWith("題x");
    expect(v.state.doc.toString()).toBe("題x");

    readOnly = true;
    draw();
    expect(v.state.readOnly).toBe(true);
    await userEvent.keyboard("y");
    expect(v.state.doc.toString()).toBe("題x");

    readOnly = false;
    draw();
    expect(v.state.readOnly).toBe(false);
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
  });
});

describe("貼り付け", () => {
  it("保存で拒まれる制御文字は取り除き、改行とタブは空白にして持ち主に渡す", () => {
    const { view, onChange } = controlled("題");
    typeAtEnd(view(), "\u0000a\tb\nc\u007f", "input.paste");
    expect(onChange).toHaveBeenLastCalledWith("題a b c");
    expect(view().state.selection.main.head).toBe("題a b c".length);
  });
});

describe.each([
  ["同期で描き直す持ち主", "sync"],
  ["microtask で描き直す持ち主", "microtask"],
] as const)("変換中の差し替え（%s）", (_, echo) => {
  it("変換中に外から変わった value は保留し、落ち着いてから持ち主の title に合わせる", async () => {
    const { view, rerender, replacements } = controlled("打ちかけ", {}, echo);
    const v = view();
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    rerender({ value: "他で変えた" });
    expect(v.state.doc.toString()).toBe("打ちかけ");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("他で変えた"));
    await settle();
    expect(replacements).toHaveLength(1);
  });

  it("差し替えを保留している間に持ち主が入力を受け取ったら、持ち主の title のまま差し替えない", async () => {
    const { view, rerender, value, replacements } = controlled("題", {}, echo);
    const v = view();
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    rerender({ value: "他で変えた" });
    typeAtEnd(v, "へんかん", "input.type.compose");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    expect(value()).toBe("題へんかん");
    await settleComposition(v);
    expect(v.state.doc.toString()).toBe("題へんかん");
    expect(replacements).toHaveLength(0);
  });
});

describe("読み取り専用", () => {
  it("変換中に読み取り専用になったら、落ち着いてから切り替え、受け取られなかった確定文字を戻す", async () => {
    // 持ち主は読み取り専用の間の入力を受け取らない（EditorSession.editTitle と同じ）
    let value = "題";
    let locked = false;
    const onChange = vi.fn((next: string) => {
      if (locked) return;
      value = next;
      api.rerender({ value });
    });
    const api = render({ value, onChange });
    const v = api.view();

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    locked = true;
    api.rerender({ readOnly: true });
    expect(v.state.readOnly).toBe(false);
    typeAtEnd(v, "かくてい", "input.type.compose");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    expect(v.state.doc.toString()).toBe("題かくてい");

    await vi.waitFor(() => expect(v.state.readOnly).toBe(true));
    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("題"));
    await settle();
    expect(v.state.doc.toString()).toBe("題");
  });

  it("変換中に外から title が変わってから読み取り専用になったら、落ち着いてから持ち主の title にする", async () => {
    let value = "題";
    let locked = false;
    const onChange = vi.fn((next: string) => {
      if (locked) return;
      value = next;
      api.rerender({ value });
    });
    const api = render({ value, onChange });
    const v = api.view();

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    value = "サーバーの題";
    api.rerender({ value });
    locked = true;
    api.rerender({ readOnly: true });
    typeAtEnd(v, "かくてい", "input.type.compose");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    expect(v.state.doc.toString()).toBe("題かくてい");

    await vi.waitFor(() => expect(v.state.readOnly).toBe(true));
    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("サーバーの題"));
    await settle();
    expect(v.state.doc.toString()).toBe("サーバーの題");
  });
});

describe("whenSettled", () => {
  it("落ち着いていればすぐに、変換中なら落ち着いてから resolve する", async () => {
    const ref = createRef<TitleEditorHandle>();
    const { view } = render({ value: "題", ref });
    await ref.current?.whenSettled();

    const v = view();
    let settled = false;
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    void ref.current?.whenSettled().then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(settled).toBe(true));
  });

  it("変換中に破棄しても resolve する", async () => {
    const ref = createRef<TitleEditorHandle>();
    const { view } = render({ value: "題", ref });
    view().contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    const waiting = ref.current?.whenSettled();
    act(() => root?.unmount());
    root = null;
    await expect(waiting).resolves.toBeUndefined();
  });
});
