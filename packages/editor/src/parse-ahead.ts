import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";

/**
 * 1 回の先読みで本文の操作を止めてよい上限（ms）。1 フレームを少し越える程度にとどめ、
 * 越えたら背景の解析に任せる。
 */
const PARSE_AHEAD_TIMEOUT_MS = 30;

/** `pos` の行から下へ何画面分を解析しておくか。移した直後に見える範囲と、少しのスクロールの分 */
const SCREENS_BELOW = 1.5;

/**
 * 遠くの位置へスクロールする直前に、`pos` の行から画面 1 枚半ほど下までを今すぐ構文解析する。
 * 解析が届いていない行は Live Preview の装飾が付かず、背景の解析が追いつくまで Markdown の
 * 記号のまま見える（背景の解析は idle を待つので、requestIdleCallback の無い Safari では 1 秒ほどかかる）。
 *
 * 解析の結果は state の解析の文脈に残り、次の transaction が木として取り込む。scrollIntoView の
 * dispatch の直前に呼べば、余分な dispatch を出さずに、移した後の最初の描画から装飾が付く。
 * 上限の時間で終わらなければ、進んだ分を残して背景の解析に任せる（呼ばない場合と同じ見え方になる）。
 *
 * 範囲は高さでなく行の数で見積もる。画面の外の行の高さは測るまで推定で、測ると（同期の measure が
 * 走ると）位置と高さの対応がずれるため。どの行も既定の行の高さ以上あるとみなすので、折り返す行が
 * 多いほど多めに解析する。画面の高さは scroller と window の小さい方を取る。window でスクロールする
 * editor では scroller が本文の高さまで伸びるため。
 *
 * 解析が目標の行まで届いたかを返す。
 */
export function parseAhead(view: EditorView, pos: number): boolean {
  const win = view.dom.ownerDocument.defaultView;
  const screen = Math.min(
    view.scrollDOM.clientHeight,
    win?.innerHeight ?? Number.POSITIVE_INFINITY,
  );
  const lines = Math.ceil((screen * SCREENS_BELOW) / view.defaultLineHeight);
  const { doc } = view.state;
  const from = doc.lineAt(Math.min(Math.max(0, pos), doc.length));
  const upto = doc.line(Math.min(doc.lines, from.number + lines)).to;
  return ensureSyntaxTree(view.state, upto, PARSE_AHEAD_TIMEOUT_MS) !== null;
}
