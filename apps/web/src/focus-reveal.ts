import { EditorView } from "@codemirror/view";
import { dispatchWhenSettled } from "@personal-wiki/editor";
import { NOTICE_CARET_GAP, noticeDockRect } from "./notice-dock";
import { scrollTopMargin } from "./sticky-header";

const revealKey = Symbol("revealFocusedCaret");

/**
 * カーソルの行が、scrollIntoView が置く範囲の中に入っているか。上はヘッダーの下（title の欄では、行の上に出る
 * 保存の状態の分も足した位置）、下は通知のドックの上（NOTICE_CARET_GAP を空けた位置）。
 */
function caretShown(view: EditorView): boolean {
  const caret = view.coordsAtPos(view.state.selection.main.head);
  if (caret === null) return false;
  const dock = noticeDockRect();
  const bottom = dock === null ? window.innerHeight : dock.top - NOTICE_CARET_GAP;
  return caret.top >= scrollTopMargin(view) && caret.bottom <= bottom;
}

/**
 * script から view に focus を移し、カーソルの行が見えていなければ見える位置へスクロールする。
 * CodeMirror の `view.focus()` はスクロールを抑えて focus を移すので、画面の外にある欄へ移すと、
 * 打鍵が見えない所に入る。見えていればスクロールを動かさない。ヘッダーと通知のドックを避ける余白は、
 * view の scrollMargins（sticky-header.ts）が持つ。
 * スクロールは、変換が落ち着くまで保留する。保留の間に focus が他の要素へ移っていたら、スクロールしない。
 */
export function focusAndRevealCaret(view: EditorView): void {
  view.focus();
  dispatchWhenSettled(view, revealKey, () => {
    // view.hasFocus は窓が背面のときも false になり、その間は移した focus が残っていても出さなくなる。
    // どの要素に focus があるかだけを見る
    if (view.root.activeElement !== view.contentDOM || caretShown(view)) return;
    view.dispatch({
      effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "nearest" }),
    });
  });
}
