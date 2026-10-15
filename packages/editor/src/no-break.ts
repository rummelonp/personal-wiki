import { findClusterBreak, type Range, type SelectionRange, type Text } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

/**
 * 隠した記法の記号と、隣り合う開き括弧、閉じ括弧、句読点の間で折り返さないための mark。
 * 隠した記号（インラインコードの `` ` `` や wikilink の `[[`、`]]`）は CodeMirror が atomic な inline の要素
 * （widget とその前後の buffer の img）で描き、要素の前後は折り返せる位置になるので、禁則が効かずに
 * 「）」だけが次の行頭へ、「（」だけが行末へ送られる。
 *
 * 開き括弧から句読点までを nowrap で囲み、長い本文の中の折り返しは、括弧に接する字を除いた部分
 * （`wrappable`）にだけ戻す。Chromium では、内側の要素を折り返せる指定にしておくと、外側が nowrap でも
 * その要素の直後で折り返す。
 * nowrap を記法の途中から始めないのは、CodeMirror が終わりの遅い mark を外側にするため、
 * 記法の要素が 2 つに割れて地や角丸に継ぎ目が出るから。
 */
const noBreak = Decoration.mark({ class: "cm-lp-nobreak" });
const wrappable = Decoration.mark({ class: "cm-lp-wrappable" });
const CLOSING_PUNCTUATION = /^[）」』】〕〉》、。，．：；！？)\]},.:;!?'"’”]+/;
const OPENING_PUNCTUATION = /[（「『【〔〈《([{'"‘“]+$/;
// 括弧、句読点の連なりとして見る長さの上限。行の残り全体を切り出さないための値
const PUNCTUATION_LOOKAHEAD = 8;

/**
 * `node` の前後に接する括弧、句読点を含めて折り返さない範囲の mark を返す。`inner` は記号を除いた
 * 本文の範囲で、折り返しを戻す範囲もこの中に取る。接する括弧、句読点が無ければ何も返さない。
 *
 * `selection` が nowrap の範囲に端を含めて触れるときも何も返さない。変換中は decoration を組み直さない
 * （ime.ts の不変条件 1）ので、nowrap の中で変換が始まると、確定まで未確定文字が折り返されずに行の外へ
 * はみ出す。変換は selection のある所で始まり、selection が動けば組み直されるので、変換の前に外れる。
 * focus の無い view は変換が起きないので、呼び出し側は空の配列を渡す。
 *
 * 括弧、句読点の連なりは、前後の構文の記号（リンクの `[` や `]` など）の手前と、親の端で止める。
 * nowrap がリンクの文の外へはみ出すと、CodeMirror がリンクの要素を 2 つに割る。
 */
export function noBreakDecorations(
  doc: Text,
  node: SyntaxNode,
  inner: { readonly from: number; readonly to: number },
  selection: readonly SelectionRange[],
): Range<Decoration>[] {
  const parent = node.parent;
  const previous = node.prevSibling;
  const next = node.nextSibling;
  const end = Math.min(
    node.to + PUNCTUATION_LOOKAHEAD,
    next ? next.from : Number.POSITIVE_INFINITY,
    parent ? parent.to : Number.POSITIVE_INFINITY,
  );
  const start = Math.max(
    node.from - PUNCTUATION_LOOKAHEAD,
    previous ? previous.to : 0,
    parent ? parent.from : 0,
  );
  const tail = CLOSING_PUNCTUATION.exec(doc.sliceString(node.to, end))?.[0] ?? "";
  const head = OPENING_PUNCTUATION.exec(doc.sliceString(start, node.from))?.[0] ?? "";
  if (!tail && !head) return [];
  const from = node.from - head.length;
  const to = node.to + tail.length;
  if (selection.some((range) => range.from <= to && range.to >= from)) return [];

  const body = doc.sliceString(inner.from, inner.to);
  const firstChar = head ? findClusterBreak(body, 0, true) : 0;
  const lastChar = tail ? findClusterBreak(body, body.length, false) : body.length;
  const decorations = [noBreak.range(from, to)];
  if (lastChar > firstChar) {
    decorations.push(wrappable.range(inner.from + firstChar, inner.from + lastChar));
  }
  return decorations;
}
