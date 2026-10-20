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

let graphemeSegmenter: Intl.Segmenter | undefined;

const OPENING_BRACKET = /^[「『（【]$/u;
const CLOSING_BRACKET = /^[」』）】]$/u;
const NOT_SPACE = /^\S/u;
const STARTS_WITH_HIRAGANA = /^\p{Script=Hiragana}/u;

/**
 * 括弧と、それに接する文字（書記素 1 つ）。keep-all でも WebKit は開き括弧の直後と閉じ括弧の直後で折り返すので、
 * 開き括弧が行末に、「title」|の のように助詞が行頭に離れる。この 2 つを nobreak の span にまとめて離さない。
 * 隣を書記素でとるのは、国旗や ZWJ の絵文字、結合濁点を、WebKit が 2 文字に描いて括弧の側に残さないため。
 */
function bracketGroups(phrase: string): { index: number; text: string; opening: boolean }[] {
  graphemeSegmenter ??= new Intl.Segmenter("ja", { granularity: "grapheme" });
  const graphemes = [...graphemeSegmenter.segment(phrase)];
  const groups: { index: number; text: string; opening: boolean }[] = [];
  for (let at = 0; at < graphemes.length - 1; at++) {
    const { segment, index } = graphemes[at] as Intl.SegmentData;
    const next = (graphemes[at + 1] as Intl.SegmentData).segment;
    const opening = OPENING_BRACKET.test(segment) && NOT_SPACE.test(next);
    const closing = CLOSING_BRACKET.test(segment) && STARTS_WITH_HIRAGANA.test(next);
    if (!opening && !closing) continue;
    groups.push({ index, text: segment + next, opening });
    at++;
  }
  return groups;
}

/**
 * 文節の中の、括弧とそれに接する文字を nobreak の span にする。
 * WebKit は nowrap の span の手前の折り返しも許さなくなるので、文節の途中で開き括弧が始まるときは手前に <wbr> を置く
 * （「、」の直後の「 で折り返せず、括弧の中が語の途中で切れる）。
 */
function keepBracketsTogether(phrase: string, at: number): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const group of bracketGroups(phrase)) {
    if (group.index > last) parts.push(phrase.slice(last, group.index));
    if (group.index > 0 && group.opening) {
      parts.push(<wbr key={`o${at + group.index}`} />);
    }
    parts.push(
      <span key={`n${at + group.index}`} className="nobreak">
        {group.text}
      </span>,
    );
    last = group.index + group.text.length;
  }
  if (last < phrase.length) parts.push(phrase.slice(last));
  return parts;
}

/** 隣り合う文字列と数を 1 つの文字列にする。文節の継ぎ目に切れ目を置けるよう、区切る前につなぐ。 */
function joinAdjacentText(nodes: ReactNode[]): ReactNode[] {
  const joined: ReactNode[] = [];
  for (const node of nodes) {
    const last = joined[joined.length - 1];
    if (
      (typeof node === "string" || typeof node === "number") &&
      (typeof last === "string" || typeof last === "number")
    ) {
      joined[joined.length - 1] = `${last}${node}`;
    } else {
      joined.push(node);
    }
  }
  return joined;
}

/**
 * 子の文字列を文節ごとに区切って <wbr> でつなぎ、1 つの span（word-break: keep-all）にまとめる。
 * 利用者の入力も同じ規則で区切る（文字は増減しない）。
 * 配列の隣り合う文字列（「{title}」のページ のような埋め込み）は、1 つの文字列として区切る。
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
      const body = keepBracketsTogether(phrase, at);
      return index === 0 ? body : [<wbr key={`w${at}`} />, ...body];
    });
    return <span className="phrased">{parts}</span>;
  }
  if (Array.isArray(node)) {
    return Children.map(joinAdjacentText(Children.toArray(node)), (child: ReactNode) =>
      withPhraseBreaks(child),
    );
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    const hostOrFragment =
      node.type === Fragment || (typeof node.type === "string" && !LITERAL_TAGS.has(node.type));
    if (!hostOrFragment || node.props.children === undefined) return node;
    return cloneElement(node, undefined, withPhraseBreaks(node.props.children));
  }
  return node;
}

/**
 * 固定の文字列や title を、文節で切る必要がある描画のときだけ withPhraseBreaks にかける。
 * 文字列を span に包むので、flex の親の直下に置いても 1 つの項目になる。
 */
export function breakAtPhrases(text: string): ReactNode {
  return needsPhraseBreaks() ? withPhraseBreaks(text) : text;
}
