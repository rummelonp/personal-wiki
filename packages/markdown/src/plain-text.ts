import type { SyntaxNode, Tree } from "@lezer/common";
import { parser } from "@lezer/markdown";
import { blockIdNodes } from "./block-id";
import { commentNodes } from "./comment";
import { BODY_EXTENSIONS } from "./display-parser";
import { Frontmatter, frontmatterEnd, frontmatterNodes } from "./frontmatter";
import { Tag, tagNodes } from "./tag";
import { isEmbedWikiLink, wikiLinkNodes } from "./wikilink";

/** 記号だけの node。中身を持たないので、node を落とせば記法が消えて前後の文字がつながる。 */
const MARK_NODES = new Set([
  "HeaderMark",
  "ListMark",
  "QuoteMark",
  "TaskMarker",
  "EmphasisMark",
  "StrikethroughMark",
  "HighlightMark",
  "CodeMark",
  "CodeInfo",
  "LinkMark",
  "LinkTitle",
  // `[text][ref]` の `[ref]`。リンク参照の定義側の LinkLabel は LinkReference ごと落とす
  "LinkLabel",
  // `<b>` のような inline の HTML タグ。タグの間の文字は本文として残る
  "HTMLTag",
  blockIdNodes.marker,
]);

/** 本文に含めない block・inline。空白に置き換え、前後の語がくっつかないようにする。 */
const DROPPED_NODES = new Set([
  frontmatterNodes.frontmatter,
  commentNodes.inline,
  commentNodes.block,
  // `<!-- -->`
  "Comment",
  "CommentBlock",
  "Image",
  "HorizontalRule",
  "LinkReference",
]);

// 表示用の displayParser は Tag を持たない（`#tag` を本文の語として扱うため）。ここは末尾のタグを
// 抜粋から除くために範囲が要るので、Tag を足した parser を別に持つ。Tag は WikiLink と同じ parser に
// 入れる必要がある（`[[T#H]]` の `#H` を WikiLink より先に拾わないため）。
const plainTextParser = parser.configure([Frontmatter, ...BODY_EXTENSIONS, Tag]);
const plainTextFragmentParser = parser.configure([...BODY_EXTENSIONS, Tag]);

interface Edit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

interface TagRange {
  readonly from: number;
  readonly to: number;
  /** タグを含む段落か見出しの終わり。それらに含まれない（表のセルなど）なら null */
  readonly blockEnd: number | null;
}

// 末尾のタグを判定する単位。抜粋で意味のある文章を持つ block に限り、表のセルは含めない
const INLINE_BLOCK = /^(?:Paragraph|ATXHeading[1-6]|SetextHeading[12])$/;

const COLLAPSIBLE_WHITESPACE = /\s+/g;
const LEADING_FRONTMATTER_DELIMITER = /^---[ \t]*(?:\r?\n|$)/;
// 末尾で閉じていない `[[...` と `![[...`（閉じ `]` が 1 つだけ届いたものも含む）
const TRAILING_PARTIAL_WIKILINK = /!?\[\[[^[\]\n]*\]?$/;
// 先頭行が表の行（`| a | b |`）か。行頭と行末の両方に `|` を要求して地の文の縦棒を残す近似で、
// `|x| は絶対値` のような行は残るが、`|x| + |y|` のように両端が `|` の行は表の行とみなす。
const TABLE_ROW_LINE = /^ {0,3}\|.*\|[ \t]*(?:\r?\n|$)/;
// 先頭行が表の区切り行（`|---|:-:|`、両端の `|` を省いた `---|---`）か。見出し行を補うかを決める入口の近似で、
// 表かどうかは補った木を lezer で読んで決める。`|` を 1 つ以上要るので、水平線の `---` や setext 見出しの下線は当たらない。
const TABLE_DELIMITER_LINE =
  /^ {0,3}\|?(?:[ \t]*:?-+:?[ \t]*\|)+(?:[ \t]*:?-+:?)?[ \t]*(?:\r?\n|$)/;

interface ExtractPlainTextOptions {
  /**
   * `markdown` が本文の先頭だけを切り出したもので、続きがあるとき true。
   * 末尾で途中切れになった `[[読書メ` のような WikiLink の断片を落とす。閉じ `---` まで届かなかった
   * 先頭の frontmatter は、本文として読むと設定の行が見出しや段落になって混ざるので、全体を落とす。
   */
  readonly truncated?: boolean;
  /**
   * `markdown` が本文の途中から切り出したもので、先頭が本文の先頭でないとき true。
   * 先頭の `---` を frontmatter の区切りとして読まない（水平線や setext 見出しの下線でありうる）。
   */
  readonly fragment?: boolean;
}

/**
 * Markdown の本文を、記法を除いた 1 行の plain text にする。検索結果の抜粋と全文検索の索引の元になる。
 * 一覧の抜粋は行末のタグを除くので、extractPlainTextParts の textWithoutTrailingTags を使う。
 *
 * 構文木から記号の node を落とす。見出しの `#`・リストの記号・引用の `>`・task の checkbox・
 * 強調／取り消し／ハイライト／inline code の記号・code fence の行・水平線・コメント（`%%`、
 * `<!-- -->`）・block id・frontmatter・リンク参照の定義を除き、リンクは表示文字だけを残す。
 * 画像と embed（`![[...]]`）は丸ごと落とす。code の中身は落とさない（読み物の一部として残す）。
 * `#tag` は本文の語としてそのまま残す（タグの語でも検索できるように）。
 *
 * WikiLink は Editor の簡略表示と同じ規則で、label があれば label、無ければ target を `#heading`
 * や `^blockId` も含めて書かれたまま出す。
 *
 * 改行と連続する空白は 1 つの空白に畳む。block の境目には必ず改行があるので、語がくっつくことはない。
 */
export function extractPlainText(markdown: string, options: ExtractPlainTextOptions = {}): string {
  return extractPlainTextParts(markdown, options).text;
}

export interface PlainTextParts {
  /** extractPlainText と同じ。`#tag` を語として残す */
  readonly text: string;
  /**
   * text から、段落や見出しの最後に並ぶ `#tag` と、タグだけの行の `#tag` を除いたもの。
   * 一覧の抜粋はタグを別にチップで出すので、抜粋に同じ語を重ねない。
   * `今日は #メモ を書いた` や `今日は #メモ\nを書いた` のように文の途中にあるタグと、
   * `本文 #メモ。` のように後ろに文字が続くタグは、文の一部なので残す。
   * 全文検索の索引は text から作る（タグの語でも引けるように）。
   */
  readonly textWithoutTrailingTags: string;
}

/** 1 回の構文解析から、タグを残した text と、末尾のタグを除いた text の両方を作る。 */
export function extractPlainTextParts(
  markdown: string,
  options: ExtractPlainTextOptions = {},
): PlainTextParts {
  const fragment = options.fragment === true;
  const source =
    options.truncated === true ? withoutTruncationDebris(markdown, fragment) : markdown;
  if (source === null) return { text: "", textWithoutTrailingTags: "" };

  const markdownParser = fragment ? plainTextFragmentParser : plainTextParser;
  let readable = source;
  let tree = markdownParser.parse(readable);
  if (fragment && !startsWithTable(tree)) {
    // 補っても先頭が表にならなかった（表の行の後ろの `---` / `===` が setext 見出しの下線になったなど）
    // ときは、補った行が文字として出るので、補う前の木のまま使う。
    const supplemented = withTableHeader(source);
    if (supplemented !== source) {
      const supplementedTree = markdownParser.parse(supplemented);
      if (startsWithTable(supplementedTree)) {
        readable = supplemented;
        tree = supplementedTree;
      }
    }
  }
  const edits: Edit[] = [];
  const tagRanges: TagRange[] = [];
  tree.iterate({
    enter(ref) {
      if (ref.name === tagNodes.tag) {
        tagRanges.push({ from: ref.from, to: ref.to, blockEnd: inlineBlockEnd(ref.node) });
        return false;
      }
      const edit = editFor(ref.node, readable);
      if (edit === null) return true;
      edits.push(edit);
      return false;
    },
  });
  const trailingTags = trailingTagRanges(tagRanges, readable, edits);

  return {
    text: applyEdits(readable, edits),
    textWithoutTrailingTags: applyEdits(
      readable,
      [...edits, ...trailingTags.map((range) => ({ ...range, insert: " " }))].sort(
        (a, b) => a.from - b.from,
      ),
    ),
  };
}

function applyEdits(readable: string, edits: readonly Edit[]): string {
  let text = "";
  let cursor = 0;
  for (const edit of edits) {
    text += readable.slice(cursor, edit.from) + edit.insert;
    cursor = edit.to;
  }
  text += readable.slice(cursor);
  return text.replace(COLLAPSIBLE_WHITESPACE, " ").trim();
}

function inlineBlockEnd(tag: SyntaxNode): number | null {
  for (let node = tag.parent; node !== null; node = node.parent) {
    if (INLINE_BLOCK.test(node.name)) return node.to;
  }
  return null;
}

/** JavaScript の `\s`（trim の空白）と同じ範囲か。 */
const UNICODE_WHITESPACE = /\s/;
const isWhitespace = (code: number) =>
  code < 128 ? code <= 32 : UNICODE_WHITESPACE.test(String.fromCharCode(code));

/**
 * 抜粋から除くタグ。次のどちらかを満たす。
 * - 段落か見出しの最後に並ぶ（後ろに続くのが、空白と、同じ条件で除くタグだけ）
 * - タグだけの行にある（`段落。\n#a #b\n続き` のように、改行で区切られた行の途中でも）
 *
 * 後ろの判定では、edit で消える範囲（強調の記号、コメント、block id など）を空白として扱う。
 * `今日は #メモ\nを書いた` の `#メモ` は、同じ段落の後ろに文字が続くので残す。
 * `本文 #メモ。` も、タグの後ろに文字があるので残す。
 *
 * 範囲の判定は、空白でない文字の累積数を 1 回の走査で作って引くので、本文の長さに対して線形。
 */
function trailingTagRanges(
  tags: readonly TagRange[],
  source: string,
  edits: readonly Edit[],
): TagRange[] {
  if (tags.length === 0) return [];

  const ink = new Uint32Array(source.length + 1);
  let editIndex = 0;
  for (let i = 0; i < source.length; i += 1) {
    while (editIndex < edits.length && (edits[editIndex] as Edit).to <= i) editIndex += 1;
    const edit = edits[editIndex];
    const erased = edit !== undefined && edit.from <= i && edit.insert.trim() === "";
    ink[i + 1] = (ink[i] as number) + (erased || isWhitespace(source.charCodeAt(i)) ? 0 : 1);
  }
  const inkBetween = (from: number, to: number) => (ink[to] as number) - (ink[from] as number);

  const onlyTagsInLine: boolean[] = [];
  for (let i = 0; i < tags.length; ) {
    const first = tags[i] as TagRange;
    const newline = source.indexOf("\n", first.to);
    const lineEnd = newline === -1 ? source.length : newline;
    const lineStart = first.from === 0 ? 0 : source.lastIndexOf("\n", first.from - 1) + 1;
    let tagChars = 0;
    let end = i;
    while (end < tags.length && (tags[end] as TagRange).to <= lineEnd) {
      const tag = tags[end] as TagRange;
      tagChars += tag.to - tag.from;
      end += 1;
    }
    const only = inkBetween(lineStart, lineEnd) === tagChars;
    for (; i < end; i += 1) {
      onlyTagsInLine.push(only);
    }
  }

  const trailing: TagRange[] = [];
  // 後ろから見て、次のタグを除くなら、そこまでの間が空白だけであればよい
  let next: TagRange | null = null;
  for (let i = tags.length - 1; i >= 0; i -= 1) {
    const tag = tags[i] as TagRange;
    const { blockEnd } = tag;
    const limit =
      next !== null && blockEnd !== null && next.from <= blockEnd ? next.from : blockEnd;
    if (onlyTagsInLine[i] === true || (limit !== null && inkBetween(tag.to, limit) === 0)) {
      trailing.push(tag);
      next = tag;
    } else {
      next = null;
    }
  }
  return trailing.reverse();
}

/** 切り出しの切り口で壊れた部分を落とした source。全体が frontmatter の途中なら null。 */
function withoutTruncationDebris(markdown: string, fragment: boolean): string | null {
  if (
    !fragment &&
    LEADING_FRONTMATTER_DELIMITER.test(markdown) &&
    frontmatterEnd(markdown) === null
  ) {
    return null;
  }
  return markdown.replace(TRAILING_PARTIAL_WIKILINK, "");
}

function startsWithTable(tree: Tree): boolean {
  return tree.topNode.firstChild?.name === "Table";
}

/**
 * 断片の先頭が表の途中の行なら、見出し行と区切り行を補った source。補う必要が無ければ source のまま返す。
 * 見出し行と区切り行が無い `| a | b |` は表として読まれず、`|` が本文に残る。窓の先頭は行頭なので、
 * 先頭の行が表の行や区切り行なら、それは表の途中から始まっていると近似する（長い行の途中から始まる窓は
 * 行頭に届かず、この前提が崩れる）。補った行の cell は空で、空白に畳まれる。
 * 補った結果が表になるか（区切り行の書き方、字下げ、列数の一致）は、呼び出し側が lezer で読んだ木で判定する。
 * ここの正規表現は補うかどうかの入口の絞り込みで、lezer の判定を写し切ったものではないため。
 */
function withTableHeader(source: string): string {
  const firstEnd = source.search(/\r?\n|$/);
  const line = source.slice(0, firstEnd);
  if (TABLE_DELIMITER_LINE.test(source)) {
    // 区切り行の列数が見出し行の列数になる。両端の `|` は省かれていることがあるので、あれば除いて数える
    const columns = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length;
    return `|${" |".repeat(columns)}\n${source}`;
  }
  if (!TABLE_ROW_LINE.test(source)) return source;
  const columns = line.replace(/\\./g, "").split("|").length - 2;
  if (columns < 1) return source;
  const header = `|${" |".repeat(columns)}\n`;
  return `${header}|${"-|".repeat(columns)}\n${source}`;
}

/** node を置き換える書き換え。null なら node は残し、子を見に降りる。 */
function editFor(node: SyntaxNode, source: string): Edit | null {
  const { name, from, to } = node;

  if (name === wikiLinkNodes.link) {
    if (isEmbedWikiLink(source[from - 1] ?? "")) return { from: from - 1, to, insert: " " };
    return { from, to, insert: wikiLinkText(node, source) };
  }
  if (DROPPED_NODES.has(name)) return { from, to, insert: " " };
  if (MARK_NODES.has(name)) return { from, to, insert: "" };
  if (name === "URL") return node.parent?.name === "Link" ? { from, to, insert: "" } : null;
  if (name === "Escape") return { from, to: from + 1, insert: "" };
  if (name === "HardBreak") return { from, to, insert: " " };
  if (name === "TableDelimiter") {
    // 区切り行（`|---|---|`）は Table の直下に 1 つ、行の `|` は TableHeader／TableRow の子として並ぶ
    return { from, to, insert: node.parent?.name === "Table" ? "" : " " };
  }
  return null;
}

function wikiLinkText(node: SyntaxNode, source: string): string {
  const label = node.getChild(wikiLinkNodes.label);
  const labelText = label === null ? "" : source.slice(label.from, label.to).trim();
  if (labelText.length > 0) return labelText;
  const target = node.getChild(wikiLinkNodes.target);
  return target === null ? "" : source.slice(target.from, target.to).trim();
}
