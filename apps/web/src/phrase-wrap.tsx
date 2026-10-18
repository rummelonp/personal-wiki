import { Children, cloneElement, Fragment, isValidElement, type ReactNode } from "react";
import { splitPhrases } from "./phrase-breaks";

/**
 * 文節の切れ目に <wbr> を置く必要があるか。word-break: auto-phrase を解釈する描画は文節を自分で判定するので、
 * 置くとかえって文節の中で切れる。Intl.Segmenter が無ければ置けない。
 */
export function needsPhraseBreaks(): boolean {
  return (
    typeof Intl !== "undefined" &&
    typeof Intl.Segmenter === "function" &&
    typeof CSS !== "undefined" &&
    !CSS.supports("word-break", "auto-phrase")
  );
}

let segmenter: Intl.Segmenter | undefined;

/** 整形済みの内容は、空白と改行の位置を変えないよう分けない。 */
const LITERAL_TAGS = new Set(["code", "pre", "kbd", "samp", "textarea"]);

/**
 * 子の文字列を文節ごとに区切って <wbr> でつなぎ、1 つの span（word-break: keep-all）にまとめる。
 * 利用者の入力も同じ規則で区切る（文字は増減しない）。
 * 部品（関数）の子は、文字列を前提にしている部品があるので触らない。
 * keep-all を span にだけ当てるのは、<wbr> を置けない部品の中の文字列が、切れ目のないまま keep-all を継いで
 * 句読点以外で折り返せなくなるのを避けるため。span は文字列 1 つにつき 1 つで、flex の親の直下でも 1 つの項目になる。
 */
export function withPhraseBreaks(node: ReactNode): ReactNode {
  if (typeof node === "string") {
    if (node.trim() === "") return node;
    segmenter ??= new Intl.Segmenter("ja", { granularity: "word" });
    // key は文字列の中の位置。同じ文節が繰り返されても重ならない
    let offset = 0;
    const parts = splitPhrases(node, segmenter).flatMap((phrase, index) => {
      const at = offset;
      offset += phrase.length;
      return index === 0 ? [phrase] : [<wbr key={at} />, phrase];
    });
    return <span className="phrased">{parts}</span>;
  }
  if (Array.isArray(node)) return Children.map(node, (child: ReactNode) => withPhraseBreaks(child));
  if (isValidElement<{ children?: ReactNode }>(node)) {
    const hostOrFragment =
      node.type === Fragment || (typeof node.type === "string" && !LITERAL_TAGS.has(node.type));
    if (!hostOrFragment || node.props.children === undefined) return node;
    return cloneElement(node, undefined, withPhraseBreaks(node.props.children));
  }
  return node;
}
