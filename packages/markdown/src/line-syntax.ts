import type { SyntaxNodeRef } from "@lezer/common";
import { blockIdNodes } from "./block-id";
import { commentNodes } from "./comment";
import { displayParser } from "./display-parser";
import { frontmatterNodes, isFrontmatterDelimiterLine } from "./frontmatter";
import { highlightNodes } from "./highlight";
import { taskListNodes } from "./task-list";
import { isEmbedWikiLink, wikiLinkNodes } from "./wikilink";

/** 行の中の区間。行頭からの UTF-16 の offset で、`to` は含まない。 */
export interface SyntaxRange {
  readonly from: number;
  readonly to: number;
}

export interface LineSyntax {
  /** 記法の文字の区間。重ならず、前から順に並ぶ。 */
  readonly marks: readonly SyntaxRange[];
  /** code block（fence の行を含む）と frontmatter の行。等幅で読むもの。 */
  readonly code: boolean;
}

/** 記号だけの node。表示では消えるか形を変える文字で、本文の語ではない。 */
const MARK_NODES = new Set([
  "HeaderMark",
  "ListMark",
  "QuoteMark",
  taskListNodes.marker,
  "EmphasisMark",
  "StrikethroughMark",
  highlightNodes.mark,
  "CodeMark",
  "CodeInfo",
  "LinkMark",
  "LinkTitle",
  "LinkLabel",
  "HTMLTag",
  "TableDelimiter",
  "HorizontalRule",
  wikiLinkNodes.mark,
  wikiLinkNodes.separator,
]);

/** 中身ごと表示に出ないもの。子の node は見ない。 */
const HIDDEN_NODES = new Set([
  commentNodes.inline,
  commentNodes.block,
  "Comment",
  "CommentBlock",
  "LinkReference",
  blockIdNodes.marker,
]);

/** 行ごと等幅で読むもの。 */
const CODE_NODES = new Set(["FencedCode", "CodeBlock", frontmatterNodes.frontmatter]);

/**
 * Markdown の本文の各行について、記法の文字の区間と、code として読む行かどうかを返す。
 * 行は `"\n"` で区切り、`diffLines` と同じ数え方をする（返す配列の長さは行数と等しい）。
 *
 * 行を 1 行ずつ parse すると、fence の内側の行や表の区切り行の文脈が失われるので、本文全体を
 * parse してから行へ割り付ける。記法として扱うのは見出し・リスト・引用・task の記号、強調・
 * 取り消し・ハイライト・code の記号、リンクの括弧と URL、WikiLink の括弧と区切り、表の区切り、
 * 水平線、inline の HTML タグ、escape の `\`。コメント、リンク参照の定義、block id は丸ごと記法に含める。
 * `#tag` は本文の語として扱う。
 */
export function syntaxByLine(markdown: string): LineSyntax[] {
  const lines = markdown.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lineOf = (pos: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((lineStarts[middle] as number) <= pos) low = middle;
      else high = middle - 1;
    }
    return low;
  };

  const marks: SyntaxRange[][] = lines.map(() => []);
  const code: boolean[] = lines.map(() => false);
  const mark = (from: number, to: number) => {
    for (let line = lineOf(from); line < lines.length; line++) {
      const start = lineStarts[line] as number;
      if (start >= to) break;
      const end = start + (lines[line] as string).length;
      const clippedFrom = Math.max(from, start) - start;
      const clippedTo = Math.min(to, end) - start;
      if (clippedTo > clippedFrom) marks[line]?.push({ from: clippedFrom, to: clippedTo });
    }
  };

  displayParser.parse(markdown).iterate({
    enter(node: SyntaxNodeRef) {
      const { name, from, to } = node;
      if (CODE_NODES.has(name)) {
        for (let line = lineOf(from); line <= lineOf(to); line++) {
          code[line] = true;
          const text = lines[line] as string;
          if (name === frontmatterNodes.frontmatter && isFrontmatterDelimiterLine(text)) {
            const delimiter = (lineStarts[line] as number) + text.indexOf("---");
            mark(delimiter, delimiter + 3);
          }
        }
        return true;
      }
      if (MARK_NODES.has(name) || HIDDEN_NODES.has(name)) {
        mark(from, to);
        return false;
      }
      if (name === wikiLinkNodes.link && isEmbedWikiLink(markdown[from - 1] ?? "")) {
        mark(from - 1, from);
        return true;
      }
      if (name === "URL") {
        const parent = node.node.parent?.name;
        if (parent === "Link" || parent === "Image") mark(from, to);
        return false;
      }
      if (name === "Escape") {
        mark(from, from + 1);
        return false;
      }
      return true;
    },
  });

  return lines.map((_, index) => ({
    marks: mergeRanges(marks[index] as SyntaxRange[]),
    code: code[index] as boolean,
  }));
}

function mergeRanges(ranges: SyntaxRange[]): SyntaxRange[] {
  ranges.sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ from: range.from, to: range.to });
  }
  return merged;
}
