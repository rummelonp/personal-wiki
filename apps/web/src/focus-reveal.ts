import { EditorView } from "@codemirror/view";
import { dispatchWhenSettled } from "@personal-wiki/editor";
import { NOTICE_CARET_GAP, noticeDockRect } from "./notice-dock";
import { stickyHeaderBottom } from "./sticky-header";

const revealKey = Symbol("revealFocusedCaret");

/** カーソルの行が、ヘッダーの下から通知のドックの上（NOTICE_CARET_GAP を空けた位置）の間に入っているか。 */
function caretShown(view: EditorView): boolean {
  const caret = view.coordsAtPos(view.state.selection.main.head);
  if (caret === null) return false;
  const dock = noticeDockRect();
  const bottom = dock === null ? window.innerHeight : dock.top - NOTICE_CARET_GAP;
  return caret.top >= stickyHeaderBottom() && caret.bottom <= bottom;
}

/**
 * script から view に focus を移し、カーソルの行が見えていなければ見える位置へスクロールする。
 * CodeMirror の `view.focus()` はスクロールを抑えて focus を移すので、画面の外にある欄へ移すと、
 * 打鍵が見えない所に入る。見えていればスクロールを動かさない。ヘッダーと通知のドックを避ける余白は、
 * view の scrollMargins（sticky-header.ts）が持つ。
 * スクロールは、変換が落ち着くまで保留する。
 */
export function focusAndRevealCaret(view: EditorView): void {
  view.focus();
  dispatchWhenSettled(view, revealKey, () => {
    if (caretShown(view)) return;
    view.dispatch({
      effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "nearest" }),
    });
  });
}
