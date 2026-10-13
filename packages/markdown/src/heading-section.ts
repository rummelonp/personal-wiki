import type { SyntaxNode } from "@lezer/common";
import { parser, Table } from "@lezer/markdown";
import { ObsidianComment } from "./comment";
import { Frontmatter } from "./frontmatter";

const ATX_HEADING = /^ATXHeading([1-6])$/;
const SETEXT_HEADING = /^SetextHeading([12])$/;
const HEADER_MARK = "HeaderMark";

// 切り出した本文は Editor（lang-markdown の GFM 入り）が描くので、block の構造を Editor に揃える。
// 抽出系の parser（wikilink.ts）が GFM Table を外す理由は派生データ（links など）の結果を変えないためで、
// 表示にしか使わないここには当たらない。
const sectionParser = parser.configure([Frontmatter, ObsidianComment, Table]);

interface Heading {
  readonly level: number;
  readonly text: string;
  readonly from: number;
}

function headingOf(node: SyntaxNode, text: string): Heading | null {
  const atx = ATX_HEADING.exec(node.name);
  if (atx) {
    const open = node.firstChild;
    const last = node.lastChild;
    const contentFrom = open?.name === HEADER_MARK ? open.to : node.from;
    // SyntaxNode は取り出すたびに別のオブジェクトになるので、開きの mark かどうかは位置で見る
    const closing = last?.name === HEADER_MARK && last.from >= contentFrom ? last : null;
    return {
      level: Number(atx[1]),
      text: text.slice(contentFrom, closing?.from ?? node.to).trim(),
      from: node.from,
    };
  }
  const setext = SETEXT_HEADING.exec(node.name);
  if (setext) {
    const underline = node.lastChild;
    const contentTo = underline?.name === HEADER_MARK ? underline.from : node.to;
    // 見出しの文が複数行にわたっても、WikiLink は 1 行にしか書けないので 1 行に畳んで比べる
    const content = text
      .slice(node.from, contentTo)
      .trim()
      .replace(/[ \t]*\n[ \t]*/g, " ");
    return { level: Number(setext[1]), text: content, from: node.from };
  }
  return null;
}

// 文書の最上位の見出しだけを数える。引用やリストの中の見出しで区切ると、その block の途中で
// 本文が切れ、切り出した本文を描き直したときに block の読み方が変わる。
function topLevelHeadings(text: string): Heading[] {
  const headings: Heading[] = [];
  for (let node = sectionParser.parse(text).topNode.firstChild; node; node = node.nextSibling) {
    const heading = headingOf(node, text);
    if (heading) headings.push(heading);
  }
  return headings;
}

function headingPath(heading: string): string[] {
  return heading
    .split("#")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * WikiLink の heading（`splitWikiLinkContent` の heading）がブロック参照を指すか。
 * `[[Note#^id]]` は Obsidian のブロック参照の書き方で、`#` の後ろが `^` で始まる。
 */
export function isBlockReferenceHeading(heading: string): boolean {
  return heading.split("#").some((segment) => segment.trim().startsWith("^"));
}

/**
 * 本文 `text` の見出しのうち、`[[Note#見出し]]` で指せるものの文を、現れる順に返す。
 * `extractHeadingSection` が同じ文で見つけられる見出しだけを返す（`#`、`|`、`[`、`]` を含む見出しと
 * `^` で始まる見出しは指せないので除く）。同じ文の見出しは先に現れる 1 つにまとめる。
 * 補完の候補に使う。候補が指す先は `extractHeadingSection` が解決する先と一致する。
 */
export function extractLinkableHeadings(text: string): string[] {
  const seen = new Set<string>();
  for (const heading of topLevelHeadings(text)) {
    if (heading.text.length === 0 || /[#|[\]]/.test(heading.text) || heading.text.startsWith("^")) {
      continue;
    }
    seen.add(heading.text);
  }
  return [...seen];
}

/**
 * 本文 `text` から、WikiLink の heading（`[[Note#A#B]]` の `A#B`）が指す見出しの範囲を返す。
 * 範囲は見出しの行から、次に現れる同じか上の level の見出しの直前まで（Obsidian と同じ）。
 * `A#B` は A の範囲の中にある B を指す。同じ文の見出しが複数あれば先に現れるほうを使う。
 * 範囲の外にある link reference definition と脚注の定義は、切り出した本文に入らない。
 *
 * 見出しの文は前後の空白を除いてそのまま比べ、大文字小文字や記号を畳まない。
 * `#`、`|`、`[`、`]` を含む見出しと `^` で始まる見出しは WikiLink で指せない（`#` の後ろが
 * `^` で始まる区切りはブロック参照として読む）。途中に `^` を含む見出し（`A^b`）は指せる。
 * コード、コメント（`%%`）、frontmatter の中の `#` と、文書の最上位にない見出しは数えない。
 *
 * 見つからなければ null を返す。そのときの表示は呼び出し側が決める。
 * 同じ本文から複数の見出しを切り出すなら `createHeadingSectionExtractor` を使う。
 */
export function extractHeadingSection(text: string, heading: string): string | null {
  return createHeadingSectionExtractor(text)(heading);
}

/**
 * `extractHeadingSection` を同じ本文 `text` に繰り返し使うための関数を返す。本文は最初の
 * 呼び出しで 1 回だけ解析し、以降の見出しは解析の結果から引く。
 */
export function createHeadingSectionExtractor(text: string): (heading: string) => string | null {
  let headings: readonly Heading[] | null = null;
  return (heading) => {
    const path = headingPath(heading);
    if (path.length === 0) return null;
    headings ??= topLevelHeadings(text);
    return sectionOf(text, headings, path);
  };
}

function sectionOf(text: string, headings: readonly Heading[], path: string[]): string | null {
  let start = 0;
  let end = headings.length;
  let found = -1;
  for (const segment of path) {
    found = -1;
    for (let i = start; i < end; i++) {
      if (headings[i]?.text === segment) {
        found = i;
        break;
      }
    }
    if (found < 0) return null;
    const level = (headings[found] as Heading).level;
    let next = found + 1;
    while (next < end && (headings[next] as Heading).level > level) next++;
    start = found + 1;
    end = next;
  }

  const from = (headings[found] as Heading).from;
  const to = end < headings.length ? (headings[end] as Heading).from : text.length;
  return text.slice(from, to).trimEnd();
}
