import type { Input, PartialParse, TreeFragment } from "@lezer/common";
import { tags } from "@lezer/highlight";
import type { BlockContext, MarkdownConfig, MarkdownParser } from "@lezer/markdown";

export const frontmatterNodes = {
  frontmatter: "Frontmatter",
} as const;

const DELIMITER = "---";
const READ_WINDOW = 256;

/** frontmatter の開きか閉じの行か。前後の空白と CRLF の `\r` は区切りの一部として許す。 */
export function isFrontmatterDelimiterLine(line: string): boolean {
  return line.trim() === DELIMITER;
}

type TextSource = Pick<Input, "length" | "read">;

function readLine(source: TextSource, from: number): string {
  let line = "";
  for (let pos = from; pos < source.length; pos += READ_WINDOW) {
    const chunk = source.read(pos, Math.min(source.length, pos + READ_WINDOW));
    const lineBreak = chunk.indexOf("\n");
    if (lineBreak >= 0) return line + chunk.slice(0, lineBreak);
    line += chunk;
  }
  return line;
}

// 入力全体でなく frontmatter の範囲だけを読む。wrap は editor の parse のたびに呼ばれる。
function findFrontmatterEnd(source: TextSource): number | null {
  const firstLine = readLine(source, 0);
  if (firstLine.length >= source.length || !isFrontmatterDelimiterLine(firstLine)) return null;

  let lineStart = firstLine.length + 1;
  for (;;) {
    const line = readLine(source, lineStart);
    const lineEnd = lineStart + line.length;
    if (isFrontmatterDelimiterLine(line)) return lineEnd;
    if (lineEnd >= source.length) return null;
    lineStart = lineEnd + 1;
  }
}

/**
 * 本文先頭の frontmatter block（1 行目の `---` から次の `---` 行まで）の終端を返す。
 * 終端は閉じ `---` 行の末尾で、直後の改行を含まない。
 * 閉じ `---` が無ければ frontmatter とは判定しない（先頭の `---` は区切り線のまま）。
 */
export function frontmatterEnd(text: string): number | null {
  return findFrontmatterEnd({ length: text.length, read: (from, to) => text.slice(from, to) });
}

// block parser は現在行より先を読めない（BlockContext の入力は @internal）。閉じ `---` の
// 有無が分かる前に行を消費すると引き返せないので、入力全体が見える wrap の段階で終端を
// 求めておき、同じ parse の block parser がそれを引く。
const frontmatterEnds = new WeakMap<object, number>();

// 先頭で再利用されうる node が、今の frontmatter の有無や終端と食い違っているか。
// lezer の incremental parse は block parser より先に fragment の node を再利用するので、
// 後から閉じ `---` を打つと、先頭の区切り線と setext 見出しがそのまま残ってしまう。
// 先頭の node が fragment に収まっていなければ（編集がその中にある）再利用されないので、
// frontmatter の中を打鍵するたびに全体を parse し直すことはない。
function isStartStale(fragments: readonly TreeFragment[], end: number | null): boolean {
  const first = fragments[0];
  if (first?.from !== 0) return false;
  const node = first.tree.topNode.firstChild;
  if (node?.from !== 0 || node.to > first.to) return false;
  const reusedEnd = node.type.name === frontmatterNodes.frontmatter ? node.to : null;
  return reusedEnd !== end;
}

type BlockContextConstructor = new (
  parser: MarkdownParser,
  input: Input,
  fragments: readonly TreeFragment[],
  ranges: readonly { from: number; to: number }[],
) => PartialParse;

// `instanceof BlockContext` は使えない。bundler が @lezer/markdown を呼び出し側と
// この package とで別の module instance にすると（Vite の依存の事前 bundle など）常に偽になる。
function isBlockContext(parse: PartialParse): parse is PartialParse & BlockContext {
  return "parser" in parse && "lineStart" in parse && "addElement" in parse;
}

// BlockContext の constructor は @internal で型定義に無い。引数は MarkdownParser.createParse
// が渡すものと同じ。createParse を呼び直すと後段の wrap が二重にかかるので使えない。
function withoutFragments(
  inner: PartialParse & BlockContext,
  input: Input,
  ranges: readonly { from: number; to: number }[],
): PartialParse {
  const FreshBlockContext = inner.constructor as BlockContextConstructor;
  return new FreshBlockContext(inner.parser, input, [], ranges);
}

/**
 * 本文先頭の frontmatter を 1 つの leaf block として認識する MarkdownConfig。
 *
 * CommonMark のままでは `---` が区切り線、続く行が setext 見出しになり、中の `[[...]]` と
 * `#tag` も link と tag として解釈される。この block の中は inline parse しない。
 *
 * `wrap` は、最初にかかる wrap のときだけ block parser の `cx` を受け取る。そうでないと
 * frontmatter を認識しない側に倒れる。lezer は 1 回の `configure` の中では後ろに並んだ
 * 拡張の wrap を内側に合成し、`configure` を重ねたときは先の呼び出しの wrap を内側に置く。
 * wrap を持つ他の拡張（lang-markdown の fenced code など）と併用するときは、
 * それより前の `configure` 呼び出しでこの config を足す。
 */
export const Frontmatter: MarkdownConfig = {
  defineNodes: [{ name: frontmatterNodes.frontmatter, block: true, style: tags.meta }],
  parseBlock: [
    {
      name: frontmatterNodes.frontmatter,
      before: "IndentedCode",
      parse(cx, line) {
        if (cx.lineStart !== 0) return false;
        const end = frontmatterEnds.get(cx);
        if (end === undefined) return false;

        while (cx.lineStart + line.text.length < end) {
          if (!cx.nextLine()) break;
        }
        cx.nextLine();
        cx.addElement(cx.elt(frontmatterNodes.frontmatter, 0, end));
        return true;
      },
    },
  ],
  wrap(inner, input, fragments, ranges) {
    if (ranges[0]?.from !== 0 || !isBlockContext(inner)) return inner;
    const end = findFrontmatterEnd(input);
    const parse = isStartStale(fragments, end) ? withoutFragments(inner, input, ranges) : inner;
    if (end !== null) frontmatterEnds.set(parse, end);
    return parse;
  },
};
