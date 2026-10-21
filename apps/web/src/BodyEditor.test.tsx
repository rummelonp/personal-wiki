import { StateEffect, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  createMemoryPageIndex,
  isCompositionUnsettled,
  isDocReplacement,
  type LinkTargetSource,
  type PageEmbedContent,
} from "@personal-wiki/editor";
import { act, createRef, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { BodyEditor, type BodyEditorHandle, type BodyEditorProps } from "./BodyEditor";
import { NOTICE_CARET_GAP, NOTICE_DOCK_RESIZE } from "./notice-dock";
import type { WikiLinkSources } from "./wiki-links";

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
    // `.cm-content` から探すと、展開した embed の中の view に当たることがある
    // （findFromDOM は渡した要素の子孫の `.cm-content` を先に探す）
    const editor = container?.querySelector<HTMLElement>(".cm-editor");
    if (!editor) throw new Error("エディタが無い");
    const found = EditorView.findFromDOM(editor);
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

/**
 * 持ち主（PageEditor の EditorSession）の代わり。onChange を受けて value を返し直す。
 * `echo: "microtask"` は本番と同じ時機（useSyncExternalStore の通知は microtask で描く）で描き直す。
 */
function controlled(
  initial: string,
  props: Partial<BodyEditorProps> = {},
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

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

// CodeMirror の窓の測り直しは描画の前と、ResizeObserver 経由の 50ms の遅延で起きる。
// その遅延より長い間、矩形が動かなければ測り直しは残っていないとみなす
const STILL_FRAMES = 12;
const MAX_FRAMES = 300;

/** `read` が返す矩形が `STILL_FRAMES` 回続けて描画をまたいで変わらなくなるのを待つ */
async function untilRectStill(read: () => DOMRect): Promise<void> {
  const key = () => {
    const { top, left, width, height } = read();
    return [top, left, width, height].join("|");
  };
  let last = key();
  let still = 0;
  for (let frame = 0; frame < MAX_FRAMES; frame++) {
    await nextFrame();
    const current = key();
    still = current === last ? still + 1 : 0;
    last = current;
    if (still >= STILL_FRAMES) return;
  }
  throw new Error("the rectangle keeps moving");
}

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

  it("再描画で EditorView を作り直さない", () => {
    const { view, rerender } = controlled("本文");
    const first = view();
    rerender({ value: "別の本文" });
    rerender({ readOnly: true });
    rerender({ readOnly: false, onBlur: () => {} });
    expect(view()).toBe(first);
  });

  it("autoFocus は作った時点の 1 回だけ、編集できるときに効く", () => {
    expect(render({ value: "本文", autoFocus: true }).view().hasFocus).toBe(true);
    act(() => root?.unmount());
    container?.remove();
    expect(render({ value: "本文", autoFocus: true, readOnly: true }).view().hasFocus).toBe(false);
  });

  it("フォーカスが外れたら onBlur を呼ぶ", () => {
    const onBlur = vi.fn();
    const { view } = controlled("本文", { onBlur });
    view().focus();
    view().contentDOM.blur();
    expect(onBlur).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  ["同期で描き直す持ち主", "sync"],
  ["microtask で描き直す持ち主", "microtask"],
] as const)("変換中の差し替え（%s）", (_, echo) => {
  /** 変換が落ち着き、保留していた dispatch の task まで済むのを待つ */
  async function settleComposition(v: EditorView) {
    await vi.waitFor(() => expect(isCompositionUnsettled(v)).toBe(false));
    await settle();
  }

  it("変換中に外から変わった value は、落ち着いてから差し替える", async () => {
    const { view, rerender, replacements } = controlled("下書き", {}, echo);
    const v = view();
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    rerender({ value: "サーバーの本文" });
    expect(v.state.doc.toString()).toBe("下書き");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("サーバーの本文"));
    expect(replacements).toHaveLength(1);
  });

  it("差し替えを保留している間に持ち主が入力を受け取ったら、持ち主の本文のまま差し替えない", async () => {
    const { view, rerender, value, replacements } = controlled("下書き", {}, echo);
    const v = view();
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    rerender({ value: "サーバーの本文" });
    typeAtEnd(v, "と入力", "input.type.compose");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    expect(value()).toBe("下書きと入力");
    await settleComposition(v);
    expect(v.state.doc.toString()).toBe("下書きと入力");
    expect(v.state.selection.main.head).toBe("下書きと入力".length);
    expect(replacements).toHaveLength(0);
  });

  it("変換中に value が A → S → A と動いたら、途中の S を入れない", async () => {
    const { view, rerender, replacements } = controlled("下書きの本文", {}, echo);
    const v = view();
    v.dispatch({ selection: { anchor: 2 } });
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    rerender({ value: "サーバー" });
    rerender({ value: "下書きの本文" });
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await settleComposition(v);
    expect(v.state.doc.toString()).toBe("下書きの本文");
    expect(v.state.selection.main.head).toBe(2);
    expect(replacements).toHaveLength(0);
  });
});

describe("StrictMode", () => {
  it("EditorView を 1 つだけ残し、入力と readOnly の切り替えが効く", async () => {
    container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    let value = "本文";
    let readOnly = false;
    const draw = () =>
      act(() =>
        mounted.render(
          <StrictMode>
            <BodyEditor value={value} onChange={onChange} readOnly={readOnly} />
          </StrictMode>,
        ),
      );
    const onChange = vi.fn((next: string) => {
      value = next;
      queueMicrotask(draw);
    });
    draw();

    expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
    const content = container.querySelector<HTMLElement>(".cm-content");
    const v = content ? EditorView.findFromDOM(content) : null;
    if (!v) throw new Error("EditorView が無い");

    v.focus();
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    await userEvent.keyboard("x");
    expect(onChange).toHaveBeenLastCalledWith("本文x");
    expect(v.state.doc.toString()).toBe("本文x");

    readOnly = true;
    draw();
    expect(v.state.readOnly).toBe(true);
    await userEvent.keyboard("y");
    expect(v.state.doc.toString()).toBe("本文x");

    readOnly = false;
    draw();
    expect(v.state.readOnly).toBe(false);
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
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

  it("変換中に外から本文が変わってから読み取り専用になったら、落ち着いてから持ち主の本文にして切り替える", async () => {
    // 差し替えが readOnly の切り替えより先に保留される順。持ち主は読み取り専用の間の入力を受け取らない
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
    value = "サーバーの本文";
    api.rerender({ value });
    locked = true;
    api.rerender({ readOnly: true });
    typeAtEnd(v, "かくてい", "input.type.compose");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    expect(v.state.doc.toString()).toBe("下書きかくてい");
    expect(v.state.readOnly).toBe(false);

    await vi.waitFor(() => expect(v.state.readOnly).toBe(true));
    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("サーバーの本文"));
    await settle();
    expect(v.state.doc.toString()).toBe("サーバーの本文");
    expect(v.state.readOnly).toBe(true);
  });
});

describe("jumpTo", () => {
  it("カーソルを移すが、focus はしない。focus 中なら外す", () => {
    const ref = createRef<BodyEditorHandle>();
    const { view } = controlled("# 見出し\n\n本文\n\n## 次", { ref });
    act(() => ref.current?.jumpTo(10));
    expect(view().state.selection.main.head).toBe(10);
    expect(view().hasFocus).toBe(false);

    act(() => view().focus());
    act(() => ref.current?.jumpTo(0));
    expect(view().hasFocus).toBe(false);
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

describe("通知のドック", () => {
  const DOCK_HEIGHT = 200;
  const body = Array.from({ length: 120 }, (_, i) => `行 ${i}`).join("\n\n");
  let dock: HTMLElement | null = null;

  beforeEach(() => {
    window.scrollTo(0, 0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dock?.remove();
    dock = null;
    window.scrollTo(0, 0);
  });

  function showDock() {
    dock = document.createElement("div");
    dock.className = "notice-dock";
    dock.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${DOCK_HEIGHT}px`;
    dock.append(document.createElement("div"));
    document.body.append(dock);
    document.dispatchEvent(new Event(NOTICE_DOCK_RESIZE));
  }

  /** 画面の下端の近く（ドックが出れば覆う位置）に見えている行の先頭 */
  function offsetNearBottom(v: EditorView): number {
    const target = window.innerHeight - DOCK_HEIGHT / 2;
    let found = -1;
    for (let line = 1; line <= v.state.doc.lines; line++) {
      const from = v.state.doc.line(line).from;
      const top = v.coordsAtPos(from)?.top;
      if (top !== undefined && top >= target) {
        found = from;
        break;
      }
    }
    expect(found).toBeGreaterThanOrEqual(0);
    return found;
  }

  it("見えているカーソルの行がドックに覆われたら、ドックの上へ逃がす", async () => {
    const { view } = controlled(body);
    const v = view();
    act(() => v.focus());
    const at = offsetNearBottom(v);
    v.dispatch({ selection: { anchor: at } });
    showDock();
    await vi.waitFor(() => {
      const bottom = v.coordsAtPos(at)?.bottom ?? Number.NaN;
      expect(bottom).toBeLessThanOrEqual(window.innerHeight - DOCK_HEIGHT - NOTICE_CARET_GAP);
    });
  });

  it("窓が背面で view.hasFocus が false でも、view に focus があればドックの上へ逃がす", async () => {
    const { view } = controlled(body);
    const v = view();
    act(() => v.focus());
    const at = offsetNearBottom(v);
    v.dispatch({ selection: { anchor: at } });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    expect(v.hasFocus).toBe(false);
    expect(v.root.activeElement).toBe(v.contentDOM);
    showDock();
    await vi.waitFor(() => {
      const bottom = v.coordsAtPos(at)?.bottom ?? Number.NaN;
      expect(bottom).toBeLessThanOrEqual(window.innerHeight - DOCK_HEIGHT - NOTICE_CARET_GAP);
    });
  });

  it("ドックには覆われなくても、行とドックの間が空いていなければ、間を空けるまで逃がす", async () => {
    const { view } = controlled(body);
    const v = view();
    act(() => v.focus());
    const at = offsetNearBottom(v);
    v.dispatch({ selection: { anchor: at } });
    // 行の下端をドックの上端のすぐ上（間 4px）に置く。覆われてはいないが、間が足りない
    const bottom = v.coordsAtPos(at)?.bottom ?? Number.NaN;
    window.scrollBy(0, bottom - (window.innerHeight - DOCK_HEIGHT - 4));
    await vi.waitFor(() => {
      const now = v.coordsAtPos(at)?.bottom ?? Number.NaN;
      expect(now).toBeCloseTo(window.innerHeight - DOCK_HEIGHT - 4, 0);
    });
    showDock();
    await vi.waitFor(() => {
      const now = v.coordsAtPos(at)?.bottom ?? Number.NaN;
      expect(now).toBeLessThanOrEqual(window.innerHeight - DOCK_HEIGHT - NOTICE_CARET_GAP);
    });
  });

  it("画面の外にあるカーソルの所へは、上の方を読んでいる人を引き戻さない", async () => {
    const { view } = controlled(body);
    const v = view();
    act(() => v.focus());
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    window.scrollTo(0, 0);
    showDock();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(window.scrollY).toBe(0);
  });

  it("ドックに覆われない行のカーソルは動かさない", async () => {
    const { view } = controlled(body);
    const v = view();
    act(() => v.focus());
    v.dispatch({ selection: { anchor: 0 } });
    showDock();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(window.scrollY).toBe(0);
  });

  it("focus が無ければ動かさない", async () => {
    const { view } = controlled(body);
    const v = view();
    v.dispatch({ selection: { anchor: offsetNearBottom(v) } });
    showDock();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(window.scrollY).toBe(0);
  });

  it("変換中は落ち着くまで待ち、doc と selection は変えない", async () => {
    const { view } = controlled(body);
    const v = view();
    act(() => v.focus());
    const at = offsetNearBottom(v);
    v.dispatch({ selection: { anchor: at } });
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    showDock();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(window.scrollY).toBe(0);
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(window.scrollY).toBeGreaterThan(0));
    expect(v.state.doc.toString()).toBe(body);
    expect(v.state.selection.main.head).toBe(at);
  });
});

describe("jumpToFragment", () => {
  const BODY = "# 先頭\n\n本文\n\n## 次の見出し\n\n段落 ^blk1\n\n### 入れ子\n\n終わり";

  it("見出しの行頭にカーソルを置く。focus はせず、focus 中なら外す", () => {
    const ref = createRef<BodyEditorHandle>();
    const { view } = controlled(BODY, { ref });
    act(() => ref.current?.jumpToFragment({ kind: "heading", heading: "次の見出し" }));
    expect(view().state.selection.main.head).toBe(BODY.indexOf("## 次の見出し"));
    expect(view().hasFocus).toBe(false);

    act(() => view().focus());
    act(() => ref.current?.jumpToFragment({ kind: "heading", heading: "先頭" }));
    expect(view().state.selection.main.head).toBe(0);
    expect(view().hasFocus).toBe(false);
  });

  it("入れ子の見出しの path をたどる", () => {
    const ref = createRef<BodyEditorHandle>();
    const { view } = controlled(BODY, { ref });
    act(() => ref.current?.jumpToFragment({ kind: "heading", heading: "次の見出し#入れ子" }));
    expect(view().state.selection.main.head).toBe(BODY.indexOf("### 入れ子"));
  });

  it("見出しの大文字小文字が違っても移り、完全一致があればそちらを選ぶ", () => {
    const text = "## Foo\n\n大文字\n\n## foo\n\n小文字\n\n## Bar";
    const ref = createRef<BodyEditorHandle>();
    const { view } = controlled(text, { ref });
    act(() => ref.current?.jumpToFragment({ kind: "heading", heading: "BAR" }));
    expect(view().state.selection.main.head).toBe(text.indexOf("## Bar"));
    act(() => ref.current?.jumpToFragment({ kind: "heading", heading: "foo" }));
    expect(view().state.selection.main.head).toBe(text.indexOf("## foo"));
  });

  it("block の段落へ移り、一時的にハイライトする。focus はせず、focus 中なら外す", () => {
    const ref = createRef<BodyEditorHandle>();
    const { view } = controlled(BODY, { ref });
    act(() => ref.current?.jumpToFragment({ kind: "block", id: "blk1" }));
    expect(view().state.selection.main.head).toBe(BODY.indexOf("段落"));
    expect(view().hasFocus).toBe(false);

    act(() => view().focus());
    act(() => ref.current?.jumpToFragment({ kind: "block", id: "blk1" }));
    expect(view().hasFocus).toBe(false);
  });

  it("見つからなければカーソルもフォーカスも動かさない", () => {
    const ref = createRef<BodyEditorHandle>();
    const { view } = controlled(BODY, { ref });
    act(() => {
      ref.current?.jumpToFragment({ kind: "heading", heading: "無い" });
      ref.current?.jumpToFragment({ kind: "block", id: "none" });
    });
    expect(view().state.selection.main.head).toBe(0);
    expect(view().hasFocus).toBe(false);
  });

  it("見出しを画面の上端の近くへスクロールする", () => {
    const filler = Array.from({ length: 80 }, (_, i) => `行 ${i}`).join("\n\n");
    const body = `${filler}\n\n## 末尾の見出し\n\n${filler}`;
    const ref = createRef<BodyEditorHandle>();
    const { view } = controlled(body, { ref });
    act(() => ref.current?.jumpToFragment({ kind: "heading", heading: "末尾の見出し" }));
    const v = view();
    return vi.waitFor(() => {
      const top = v.coordsAtPos(body.indexOf("## 末尾の見出し"))?.top ?? Number.NaN;
      expect(top).toBeGreaterThanOrEqual(0);
      // y: "start" と yMargin の 16px で、行は画面の上端のすぐ下に来る
      expect(top).toBeLessThan(100);
    });
  });

  it("背景の解析を待たずに、遠くの見出しを移した直後の描画から装飾する", () => {
    // 作った直後に解析される先頭の数千字より、ずっと先まで続く本文
    const body = Array.from(
      { length: 2000 },
      (_, i) => `${i % 10 === 0 ? `## 見出し ${i}` : `段落 ${i} の本文。`}\n`,
    ).join("\n");
    const ref = createRef<BodyEditorHandle>();
    const { view } = controlled(body, { ref });
    // 先読みの解析は時間の上限で打ち切られる。見るのは移す前に解析することなので、Date.now を止めて
    // 機械の速さに左右されないようにする。作るときの解析まで止めると先読みが無くても装飾されるので、
    // 作った後に止める
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      act(() => ref.current?.jumpToFragment({ kind: "heading", heading: "見出し 1990" }));
    } finally {
      now.mockRestore();
    }
    const v = view();
    // measure を同期に走らせ、背景の解析（idle を待つ）が動く前に、移した先の描画を見る
    v.coordsAtPos(body.indexOf("## 見出し 1990"), 1);
    const line = [...v.contentDOM.querySelectorAll(".cm-line")].find(
      (element) => element.textContent?.trim() === "見出し 1990",
    );
    if (line === undefined) throw new Error("見出し 1990 の行が装飾されていない");
    expect(line.classList).toContain("cm-lp-h2");
  });

  describe("画面の上端に残るヘッダーがあるとき", () => {
    const HEADER_HEIGHT = 80;
    let stickyHeader: HTMLElement | null = null;

    beforeEach(() => {
      window.scrollTo(0, 0);
      stickyHeader = document.createElement("header");
      stickyHeader.className = "header";
      stickyHeader.style.cssText = `position:sticky;top:0;z-index:1;height:${HEADER_HEIGHT}px`;
      document.body.prepend(stickyHeader);
    });

    afterEach(() => {
      stickyHeader?.remove();
      stickyHeader = null;
      window.scrollTo(0, 0);
    });

    const filler = Array.from({ length: 80 }, (_, i) => `行 ${i}`).join("\n\n");
    const body = `${filler}\n\n## 末尾の見出し\n\n${filler}`;

    it("見出しの行はヘッダーの下に来る", async () => {
      const ref = createRef<BodyEditorHandle>();
      const { view } = controlled(body, { ref });
      act(() => ref.current?.jumpToFragment({ kind: "heading", heading: "末尾の見出し" }));
      const v = view();
      await vi.waitFor(() => {
        const top = v.coordsAtPos(body.indexOf("## 末尾の見出し"))?.top ?? Number.NaN;
        expect(top).toBeGreaterThanOrEqual(HEADER_HEIGHT);
        expect(top).toBeLessThan(HEADER_HEIGHT + 100);
      });
    });

    it("離れた行へカーソルを動かしたときも、その行はヘッダーの下に来る", async () => {
      const { view } = controlled(body);
      const v = view();
      const at = body.indexOf("## 末尾の見出し");
      act(() => v.dispatch({ selection: { anchor: at }, scrollIntoView: true }));
      await vi.waitFor(() => {
        const top = v.coordsAtPos(at)?.top ?? Number.NaN;
        expect(top).toBeGreaterThanOrEqual(HEADER_HEIGHT);
      });
      // 画面の上端のすぐ下にある行へ戻っても、ヘッダーに隠れない
      act(() => v.dispatch({ selection: { anchor: 0 }, scrollIntoView: true }));
      await vi.waitFor(() => {
        const top = v.coordsAtPos(0)?.top ?? Number.NaN;
        expect(top).toBeGreaterThanOrEqual(HEADER_HEIGHT);
      });
    });

    describe("[[ の補完の窓", () => {
      const DOCK_HEIGHT = 200;
      const pageIndex = createMemoryPageIndex([{ id: "1", title: "Note" }], {
        normalize: (text) => text.toLowerCase(),
      });
      const long = `\n${filler}\n\n## 末尾の見出し\n\n${filler}`;

      /** 窓が実際に見える位置にあるか。置けないときの CodeMirror は画面の外へ追いやる */
      const tooltipRect = () => {
        const tooltip = document.querySelector(".cm-tooltip-autocomplete");
        if (tooltip === null) throw new Error("窓が無い");
        return tooltip.getBoundingClientRect();
      };

      it("scroll 0 の 1 行目で打っても、ヘッダーの下に見える", async () => {
        const { view } = controlled(long, { pageIndex });
        const v = view();
        act(() => v.focus());
        v.dispatch({
          changes: { from: 0, insert: "[[No" },
          selection: { anchor: 4 },
          userEvent: "input.type",
        });
        await vi.waitFor(() => {
          const rect = tooltipRect();
          expect(rect.top).toBeGreaterThanOrEqual(HEADER_HEIGHT);
          expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
        });
      });

      it("目次への移動のあと scroll 0 に戻っても、1 行目で窓が見える", async () => {
        const ref = createRef<BodyEditorHandle>();
        const { view } = controlled(long, { pageIndex, ref });
        const v = view();
        act(() => ref.current?.jumpToFragment({ kind: "heading", heading: "末尾の見出し" }));
        await vi.waitFor(() => expect(window.scrollY).toBeGreaterThan(0));
        window.scrollTo(0, 0);
        act(() => v.focus());
        v.dispatch({
          changes: { from: 0, insert: "[[No" },
          selection: { anchor: 4 },
          userEvent: "input.type",
        });
        await vi.waitFor(() => {
          const rect = tooltipRect();
          expect(rect.top).toBeGreaterThanOrEqual(HEADER_HEIGHT);
          expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
        });
      });

      describe("通知のドックがあるとき", () => {
        let dock: HTMLElement | null = null;

        beforeEach(() => {
          // ドックの高さ分の文書末尾の余白（styles.css が --notice-height で取る）
          document.documentElement.style.paddingBottom = `${DOCK_HEIGHT}px`;
          dock = document.createElement("div");
          dock.className = "notice-dock";
          dock.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${DOCK_HEIGHT}px`;
          dock.append(document.createElement("div"));
          document.body.append(dock);
        });

        afterEach(() => {
          dock?.remove();
          dock = null;
          document.documentElement.style.removeProperty("padding-bottom");
        });

        it("最後の行で打っても、窓はドックと重ならずに見える", async () => {
          const { view } = controlled(long, { pageIndex });
          const v = view();
          act(() => v.focus());
          const end = v.state.doc.length;
          v.dispatch({
            changes: { from: end, insert: "\n\n[[No" },
            selection: { anchor: end + 6 },
            scrollIntoView: true,
            userEvent: "input.type",
          });
          await vi.waitFor(() => {
            const rect = tooltipRect();
            expect(rect.top).toBeGreaterThanOrEqual(HEADER_HEIGHT);
            expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight - DOCK_HEIGHT);
          });
        });

        it("窓を開いた後にドックが出たら、窓はドックの上へ置き直される", async () => {
          dock?.replaceChildren();
          const { view } = controlled(long, { pageIndex });
          const v = view();
          act(() => v.focus());
          const at = long.indexOf("## 末尾の見出し");
          v.dispatch({
            changes: { from: at, insert: "[[No\n\n" },
            selection: { anchor: at + 4 },
            userEvent: "input.type",
          });
          // ドックが出れば覆う位置（ドックの上端より下）に窓が開くよう、カーソルの行を画面の下寄りに置く
          const caretTop = v.coordsAtPos(at + 4)?.top ?? Number.NaN;
          window.scrollBy(0, caretTop - (window.innerHeight - DOCK_HEIGHT - 40));
          await vi.waitFor(() => {
            const rect = tooltipRect();
            expect(rect.top).toBeGreaterThanOrEqual(HEADER_HEIGHT);
            expect(rect.bottom).toBeGreaterThan(window.innerHeight - DOCK_HEIGHT);
          });

          // スクロールの後の再測定が済むまで待つ。ドックの出入りだけを契機にして置き直されることを確かめる
          await untilRectStill(tooltipRect);
          dock?.append(document.createElement("div"));
          document.dispatchEvent(new Event(NOTICE_DOCK_RESIZE));
          await vi.waitFor(() => {
            const rect = tooltipRect();
            expect(rect.top).toBeGreaterThanOrEqual(HEADER_HEIGHT);
            expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight - DOCK_HEIGHT);
          });
        });
      });
    });
  });

  it("変換中は落ち着くまで待つ", async () => {
    const ref = createRef<BodyEditorHandle>();
    const { view } = controlled(BODY, { ref });
    const v = view();
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    ref.current?.jumpToFragment({ kind: "heading", heading: "次の見出し" });
    expect(v.state.selection.main.head).toBe(0);
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(v.state.selection.main.head).toBe(BODY.indexOf("## 次の見出し")));
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

/** 取得の結果を外から差し込める WikiLinkSources。 */
function fakeLinks() {
  const missing = new Set<string>();
  const embeds = new Map<string, PageEmbedContent>();
  const hrefs = new Map<string, string>();
  const drafts = new Set<string>();
  const listeners = new Set<() => void>();
  const sources: WikiLinkSources = {
    resolveWikiLink: (target) => !missing.has(target),
    resolvePageEmbed: (target) => embeds.get(target) ?? { kind: "loading" },
    hrefFor: (link) => hrefs.get(link.target) ?? null,
    isDraft: (target) => drafts.has(target),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    sources,
    missing,
    embeds,
    hrefs,
    drafts,
    listeners,
    changed: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

const unresolvedTargets = (v: EditorView) =>
  [...v.dom.querySelectorAll(".cm-wikilink-unresolved")].map((e) => e.textContent);

describe("wikilink の存在の印", () => {
  it("存在しない link だけを未解決にし、取得の結果が届いたら組み直す", async () => {
    const links = fakeLinks();
    const { view } = controlled("[[有る]] と [[無い]]", { links: links.sources });
    expect(unresolvedTargets(view())).toEqual([]);

    links.missing.add("無い");
    links.changed();
    await vi.waitFor(() => expect(unresolvedTargets(view())).toEqual(["無い"]));
  });

  it("解決先の URL が届いた link だけを <a href> にする", async () => {
    const links = fakeLinks();
    const { view } = controlled("[[有る]] と [[無い]]", { links: links.sources });
    expect(view().dom.querySelectorAll("a.cm-wikilink")).toHaveLength(0);

    links.hrefs.set("有る", "/%E6%9C%89%E3%82%8B");
    links.missing.add("無い");
    links.changed();
    await vi.waitFor(() => {
      const anchors = [...view().dom.querySelectorAll<HTMLAnchorElement>("a.cm-wikilink")];
      expect(anchors.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
        ["有る", "/%E6%9C%89%E3%82%8B"],
      ]);
    });
  });

  it("変換中に届いた結果は、落ち着くまで装飾に反映しない", async () => {
    const links = fakeLinks();
    const { view } = controlled("[[無い]]", { links: links.sources });
    const v = view();
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    typeAtEnd(v, "か", "input.type.compose");

    links.missing.add("無い");
    const before = v.state;
    links.changed();
    // dispatch していなければ state は同じオブジェクトのまま
    expect(v.state).toBe(before);
    expect(unresolvedTargets(v)).toEqual([]);

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(unresolvedTargets(v)).toEqual(["無い"]));
  });

  it("markDraftLinks の間だけ、draft への link に下書きの印を付ける", async () => {
    const links = fakeLinks();
    links.drafts.add("下書き");
    const badges = (v: EditorView) =>
      [...v.dom.querySelectorAll(".cm-wikilink-draft-badge")].map((e) => e.textContent);
    const { view, rerender } = controlled("[[下書き]] と [[公開]]", { links: links.sources });
    expect(badges(view())).toEqual([]);

    rerender({ markDraftLinks: true });
    await vi.waitFor(() => expect(badges(view())).toEqual(["下書き"]));

    // 取得の結果で draft になった link にも付く
    links.drafts.add("公開");
    links.changed();
    await vi.waitFor(() => expect(badges(view())).toEqual(["下書き", "下書き"]));

    rerender({ markDraftLinks: false });
    await vi.waitFor(() => expect(badges(view())).toEqual([]));
  });

  it("markDraftLinks の間だけ、展開した draft の embed のタイトルにも下書きの印を付ける", async () => {
    const links = fakeLinks();
    links.drafts.add("下書き");
    links.embeds.set("下書き", { kind: "resolved", title: "下書き", text: "本文" });
    const badges = (v: EditorView) =>
      [...v.dom.querySelectorAll(".cm-embed-page-title .cm-wikilink-draft-badge")].map(
        (e) => e.textContent,
      );
    const resolve = vi.spyOn(links.sources, "resolveWikiLink");
    const { view, rerender } = controlled("![[下書き]]\n\n後", { links: links.sources });
    await vi.waitFor(() =>
      expect(
        view().dom.querySelector('.cm-embed-page[data-embed-state="resolved"]'),
      ).not.toBeNull(),
    );
    expect(badges(view())).toEqual([]);
    // 印を付けない間は、解決先を取りに行かない
    expect(resolve).not.toHaveBeenCalled();

    rerender({ markDraftLinks: true });
    await vi.waitFor(() => expect(badges(view())).toEqual(["下書き"]));
    expect(resolve).toHaveBeenCalledWith("下書き");

    rerender({ markDraftLinks: false });
    await vi.waitFor(() => expect(badges(view())).toEqual([]));
  });

  it("変換中に公開範囲が変わっても、落ち着くまで印を組み直さない", async () => {
    const links = fakeLinks();
    links.drafts.add("下書き");
    const { view, rerender } = controlled("[[下書き]] ", { links: links.sources });
    const v = view();
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    typeAtEnd(v, "か", "input.type.compose");

    const before = v.state;
    rerender({ markDraftLinks: true });
    expect(v.state).toBe(before);
    expect(v.dom.querySelector(".cm-wikilink-draft-badge")).toBeNull();

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(v.dom.querySelector(".cm-wikilink-draft-badge")).not.toBeNull());
  });

  it("links を渡さなければ印を付けず、ページ embed は展開しない", () => {
    const { view } = controlled("[[無い]] ![[別]]");
    expect(unresolvedTargets(view())).toEqual([]);
    expect(view().dom.querySelector(".cm-embed-page")).toBeNull();
  });

  it("アンマウントで購読を外す", () => {
    const links = fakeLinks();
    controlled("[[a]]", { links: links.sources });
    expect(links.listeners.size).toBe(1);
    act(() => root?.unmount());
    expect(links.listeners.size).toBe(0);
  });

  it("StrictMode でも購読は 1 つだけ残る", () => {
    const links = fakeLinks();
    container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    act(() =>
      mounted.render(
        <StrictMode>
          <BodyEditor value="[[無い]]" links={links.sources} />
        </StrictMode>,
      ),
    );
    expect(links.listeners.size).toBe(1);
  });
});

describe("ページ embed", () => {
  const embedOf = (v: EditorView) => v.dom.querySelector<HTMLElement>(".cm-embed-page");

  it("取得の結果に合わせて loading から本文の展開に変わる", async () => {
    const links = fakeLinks();
    const { view } = controlled("![[別]]", { links: links.sources });
    expect(embedOf(view())?.getAttribute("data-embed-state")).toBe("loading");

    links.embeds.set("別", { kind: "resolved", title: "別", text: "埋め込まれた本文" });
    links.changed();
    await vi.waitFor(() =>
      expect(embedOf(view())?.getAttribute("data-embed-state")).toBe("resolved"),
    );
    expect(embedOf(view())?.textContent).toContain("埋め込まれた本文");
  });

  it("展開した embed の本文の中の link にも、存在しない印が付く", async () => {
    const links = fakeLinks();
    links.embeds.set("別", { kind: "resolved", title: "別", text: "[[無い]]" });
    controlled("![[別]]", { links: links.sources });
    await vi.waitFor(() => expect(container?.querySelector(".cm-embed-page-body")).not.toBeNull());

    links.missing.add("無い");
    links.changed();
    await vi.waitFor(() =>
      expect(
        [...(container?.querySelectorAll(".cm-embed-page-body .cm-wikilink-unresolved") ?? [])].map(
          (e) => e.textContent,
        ),
      ).toEqual(["無い"]),
    );
  });
});

describe("wikilink のクリック", () => {
  const clickLink = (v: EditorView, text: string) => {
    const link = [...v.dom.querySelectorAll(".cm-wikilink")].find((e) => e.textContent === text);
    if (!link) throw new Error(`${text} の link が無い`);
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  };

  it("素のクリックで onWikiLinkClick に target を渡す", () => {
    const onWikiLinkClick = vi.fn();
    const { view } = controlled("[[有る|表示]] [[Note^abc]]", { onWikiLinkClick });
    clickLink(view(), "表示");
    expect(onWikiLinkClick).toHaveBeenLastCalledWith({
      target: "有る",
      label: "表示",
      blockId: null,
      heading: null,
    });
    clickLink(view(), "Note^abc");
    expect(onWikiLinkClick).toHaveBeenLastCalledWith({
      target: "Note",
      label: null,
      blockId: "abc",
      heading: null,
    });
  });

  it("再描画で渡し直した関数を呼ぶ", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { view, rerender } = controlled("[[有る]]", { onWikiLinkClick: first });
    rerender({ onWikiLinkClick: second });
    clickLink(view(), "有る");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("展開した embed の title のクリックも同じ関数に届く", async () => {
    const links = fakeLinks();
    links.embeds.set("別", { kind: "resolved", title: "別", text: "本文" });
    const onWikiLinkClick = vi.fn();
    const { view } = controlled("![[別]]", { links: links.sources, onWikiLinkClick });
    const title = await vi.waitFor(() => {
      const found = view().dom.querySelector<HTMLElement>(".cm-embed-page-title");
      if (!found) throw new Error("title が無い");
      return found;
    });
    title.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
    );
    expect(onWikiLinkClick).toHaveBeenCalledWith({
      target: "別",
      label: null,
      blockId: null,
      heading: null,
    });
  });
});

describe("本文の tag", () => {
  it("onTagClick を渡すと、tag の一覧を指す <a> にして、素のクリックは onTagClick に渡す", () => {
    const onTagClick = vi.fn();
    const { view } = controlled("本文 #仕事 です", { onTagClick });
    const tag = view().contentDOM.querySelector(".cm-tag");
    if (!(tag instanceof HTMLAnchorElement)) throw new Error("tag が <a> でない");
    expect(tag.getAttribute("href")).toBe(`/?tag=${encodeURIComponent("仕事")}`);
    tag.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(onTagClick).toHaveBeenCalledExactlyOnceWith({ name: "仕事" });
  });

  it("onTagClick を渡さなければ <a> にしない", () => {
    const { view } = controlled("本文 #仕事 です");
    expect(view().contentDOM.querySelector(".cm-tag")?.tagName).toBe("SPAN");
  });
});
