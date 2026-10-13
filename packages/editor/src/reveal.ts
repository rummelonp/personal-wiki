import { type EditorState, Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * source を出す範囲の広さ。
 *
 * `"range"` は記法そのものと selection の交差だけを見る既定。
 * `"line"` は交差判定をカーソル行全体まで広げる。IME が記法の隣で壊れる場合の
 * 緩和策を、各 extension を書き換えずに切り替えるための口。
 */
export type RevealPolicy = "range" | "line";

export const revealPolicy = Facet.define<RevealPolicy, RevealPolicy>({
  combine: (values) => values[0] ?? "range",
});

/**
 * `from`..`to` の記法を source のまま見せるべきか。
 *
 * 端点を含めて交差とみなす。`**bold**` の直後にカーソルがある状態でも source に戻すため、
 * IME の変換開始位置の隣に `Decoration.replace` が残らない（IME 不変条件 2）。
 */
export function shouldRevealSource(state: EditorState, from: number, to: number): boolean {
  const policy = state.facet(revealPolicy);
  for (const range of state.selection.ranges) {
    if (policy === "line") {
      if (state.doc.lineAt(range.from).from <= to && state.doc.lineAt(range.to).to >= from) {
        return true;
      }
    } else if (range.from <= to && range.to >= from) {
      return true;
    }
  }
  return false;
}

/**
 * view 全体を簡略表示にするか。readonly の view も含め、focus の無い view では
 * selection の位置に関わらず記法を隠す（readonly でも `EditorView.editable` は保つため focus できる。
 * create-editor.ts の `readOnly` オプションの説明を参照）。
 */
export function isSimplifiedView(view: EditorView): boolean {
  return !view.hasFocus;
}

/**
 * 1 回の decoration 構築で使う判定関数を作る。
 *
 * 簡略表示の view（`isSimplifiedView`）では常に隠す側を返す。
 * この focus の扱いも含めて、source を出すかどうかの判断はこのファイルだけが持つ。
 */
export function createRevealTest(view: EditorView): (from: number, to: number) => boolean {
  if (isSimplifiedView(view)) return () => false;
  const { state } = view;
  return (from, to) => shouldRevealSource(state, from, to);
}
