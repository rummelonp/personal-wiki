import { StateEffect, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  createMemoryPageIndex,
  isCompositionUnsettled,
  isDocReplacement,
  type LinkTargetSource,
} from "@personal-wiki/editor";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { BodyEditor, type BodyEditorHandle, type BodyEditorProps } from "./BodyEditor";

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

function render(props: BodyEditorProps): {
  view: () => EditorView;
  rerender: (next: Partial<BodyEditorProps>) => void;
  /** replaceDoc が出した transaction（isDocReplacement が true のもの） */
  replacements: Transaction[];
} {
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  let current = props;
  act(() => mounted.render(<BodyEditor {...current} />));
  const view = () => {
    const content = container?.querySelector<HTMLElement>(".cm-content");
    if (!content) throw new Error("エディタが無い");
    const found = EditorView.findFromDOM(content);
    if (!found) throw new Error("EditorView が無い");
    return found;
  };
  const replacements: Transaction[] = [];
  view().dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        for (const tr of update.transactions) if (isDocReplacement(tr)) replacements.push(tr);
      }),
    ),
  });
  return {
    view,
    replacements,
    rerender(next) {
      current = { ...current, ...next };
      act(() => mounted.render(<BodyEditor {...current} />));
    },
  };
}

/** 持ち主（PageEditor の EditorSession）の代わり。onChange を受けて value を返し直す */
function controlled(initial: string, props: Partial<BodyEditorProps> = {}) {
  let value = initial;
  const onChange = vi.fn((next: string) => {
    value = next;
    api.rerender({ value });
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

describe("本文の受け渡し", () => {
  it("入力を onChange に渡し、返ってきた value では replaceDoc を呼ばない", () => {
    const { view, onChange, replacements } = controlled("本文");
    typeAtEnd(view(), "です");
    expect(onChange).toHaveBeenLastCalledWith("本文です");
    expect(view().state.doc.toString()).toBe("本文です");
    expect(replacements).toHaveLength(0);
  });

  it("変換中の未確定文字も onChange に渡す（退避に残すため）", () => {
    const { view, onChange } = controlled("本文");
    view().contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    typeAtEnd(view(), "へんかん", "input.type.compose");
    expect(onChange).toHaveBeenLastCalledWith("本文へんかん");
    view().contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
  });

  it("外から変わった value は replaceDoc で差し替え、onChange には返さない", () => {
    const { view, rerender, onChange, replacements } = controlled("古い本文");
    rerender({ value: "新しい本文" });
    expect(replacements).toHaveLength(1);
    expect(view().state.doc.toString()).toBe("新しい本文");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("変換中に外から変わった value は、落ち着いてから差し替える", async () => {
    const { view, rerender, replacements } = controlled("下書き");
    const v = view();
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    rerender({ value: "サーバーの本文" });
    expect(v.state.doc.toString()).toBe("下書き");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("サーバーの本文"));
    expect(replacements).toHaveLength(1);
  });

  it("差し替えを保留している間に持ち主が入力を受け取ったら、持ち主の本文に合わせ直す", async () => {
    const { view, rerender, value } = controlled("下書き");
    const v = view();
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    rerender({ value: "サーバーの本文" });
    typeAtEnd(v, "と入力", "input.type.compose");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    expect(value()).toBe("下書きと入力");
    await settle();
    await vi.waitFor(() => expect(v.state.doc.toString()).toBe(value()));
  });

  it("再描画で EditorView を作り直さない", () => {
    const { view, rerender } = controlled("本文");
    const first = view();
    rerender({ value: "別の本文" });
    rerender({ readOnly: true });
    rerender({ readOnly: false, onBlur: () => {} });
    expect(view()).toBe(first);
  });

  it("フォーカスが外れたら onBlur を呼ぶ", () => {
    const onBlur = vi.fn();
    const { view } = controlled("本文", { onBlur });
    view().focus();
    view().contentDOM.blur();
    expect(onBlur).toHaveBeenCalledTimes(1);
  });
});

describe("読み取り専用", () => {
  it("キーボードの入力を受け付けない", async () => {
    const { view, onChange } = controlled("読むだけ", { readOnly: true });
    view().focus();
    await userEvent.keyboard("abc{Enter}");
    expect(view().state.doc.toString()).toBe("読むだけ");
    expect(view().state.readOnly).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("readOnly を見ない経路の dispatch も doc を変えない", () => {
    const { view, onChange } = controlled("読むだけ", { readOnly: true });
    typeAtEnd(view(), "!");
    expect(view().state.doc.toString()).toBe("読むだけ");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("外からの差し替えは受け付ける", () => {
    const { view, rerender, replacements } = controlled("古い", { readOnly: true });
    rerender({ value: "新しい" });
    expect(view().state.doc.toString()).toBe("新しい");
    expect(replacements).toHaveLength(1);
  });

  it("切り替えると入力できるようになる", async () => {
    const { view, rerender, onChange } = controlled("本文", { readOnly: true });
    rerender({ readOnly: false });
    view().focus();
    view().dispatch({ selection: { anchor: view().state.doc.length } });
    await userEvent.keyboard("x");
    expect(view().state.doc.toString()).toBe("本文x");
    expect(onChange).toHaveBeenLastCalledWith("本文x");
  });

  it("変換中に読み取り専用になったら、落ち着いてから切り替え、受け取られなかった確定文字を戻す", async () => {
    // 持ち主は読み取り専用の間の入力を受け取らない（EditorSession.edit と同じ）
    let value = "下書き";
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
    expect(isCompositionUnsettled(v)).toBe(true);
    expect(v.state.readOnly).toBe(false);

    await vi.waitFor(() => expect(v.state.readOnly).toBe(true));
    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("下書き"));
  });
});

describe("jumpTo", () => {
  it("カーソルを置いてフォーカスする", () => {
    const ref = createRef<BodyEditorHandle>();
    const { view } = controlled("# 見出し\n\n本文\n\n## 次", { ref });
    act(() => ref.current?.jumpTo(10));
    expect(view().state.selection.main.head).toBe(10);
    expect(view().hasFocus).toBe(true);
  });

  it("変換中は落ち着くまで待つ", async () => {
    const ref = createRef<BodyEditorHandle>();
    const { view } = controlled("# 見出し\n\n本文", { ref });
    const v = view();
    v.dispatch({ selection: { anchor: 0 } });
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    ref.current?.jumpTo(7);
    expect(v.state.selection.main.head).toBe(0);
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(v.state.selection.main.head).toBe(7));
  });
});

describe("[[ の補完", () => {
  const pageIndex = createMemoryPageIndex([{ id: "1", title: "Note" }], {
    normalize: (text) => text.toLowerCase(),
  });

  const optionTexts = () =>
    [...document.querySelectorAll(".cm-tooltip-autocomplete li")].map((li) => li.textContent);

  it("リンク先の見出しを候補に出す", async () => {
    const linkTargets: LinkTargetSource = {
      load: async () => ({ headings: ["概要", "使い方"], blocks: [] }),
    };
    const { view } = controlled("", { pageIndex, linkTargets });
    typeAtEnd(view(), "[[Note#");
    await vi.waitFor(() => expect(optionTexts()).toEqual(["概要", "使い方"]));
  });

  it("取得に失敗しても候補なしで閉じ、入力を続けられる", async () => {
    const load = vi.fn<LinkTargetSource["load"]>(async () => {
      throw new Error("network");
    });
    const { view, onChange } = controlled("", { pageIndex, linkTargets: { load } });
    typeAtEnd(view(), "[[Note#");
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    await settle();
    expect(optionTexts()).toEqual([]);

    typeAtEnd(view(), "見出し]]");
    expect(onChange).toHaveBeenLastCalledWith("[[Note#見出し]]");
    expect(view().state.doc.toString()).toBe("[[Note#見出し]]");
  });

  it("読み取り専用では候補を出さない", async () => {
    const load = vi.fn<LinkTargetSource["load"]>(async () => ({ headings: ["概要"], blocks: [] }));
    const { view, rerender } = controlled("[[Note#", { pageIndex, linkTargets: { load } });
    rerender({ readOnly: true });
    view().focus();
    view().dispatch({ selection: { anchor: view().state.doc.length } });
    await settle();
    expect(optionTexts()).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("候補を出している途中で読み取り専用になったら閉じる", async () => {
    const { view, rerender } = controlled("", { pageIndex });
    view().focus();
    typeAtEnd(view(), "[[No");
    await vi.waitFor(() => expect(optionTexts()).toEqual(["Note"]));
    rerender({ readOnly: true });
    await vi.waitFor(() => expect(optionTexts()).toEqual([]));
  });

  it("入力直後や取得の途中で読み取り専用になっても、補完の後始末で例外を出さない", async () => {
    // 補完の ViewPlugin は destroy で timer を止めないので、extension ごと外すと、残った timer が
    // 外れた StateField を読んで例外になる。出れば vitest が unhandled error として落とす
    let release: (() => void) | undefined;
    const load = vi.fn<LinkTargetSource["load"]>(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ headings: ["概要"], blocks: [] });
        }),
    );
    const { view, rerender } = controlled("", { pageIndex, linkTargets: { load } });
    view().focus();
    typeAtEnd(view(), "[[Note#");
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    rerender({ readOnly: true });
    release?.();
    typeAtEnd(view(), "x");
    rerender({ readOnly: false });
    typeAtEnd(view(), "y");
    rerender({ readOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(optionTexts()).toEqual([]);
  });
});
