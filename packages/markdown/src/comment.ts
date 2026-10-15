import { tags } from "@lezer/highlight";
import type { Line, MarkdownConfig } from "@lezer/markdown";

/**
 * `%%comment%%` の構文木ノード名。decoration 側が文字列リテラルを直書きしないよう、ここを唯一の定義とする。
 * @lezer/markdown は HTML コメント（`<!-- -->`）に `Comment`、`CommentBlock` を使うので、名前を分ける。
 */
export const commentNodes = {
  /** 段落の中の `%%...%%` */
  inline: "ObsidianComment",
  /** `%%` で始まり同じ行で閉じない行から、次に `%%` が現れる行まで */
  block: "ObsidianCommentBlock",
  mark: "ObsidianCommentMark",
} as const;

const PERCENT = 37;
const DELIMITER = "%%";
/** 文書の最上位での `BlockContext.depth`。Document も親の block に数える */
const TOP_LEVEL_DEPTH = 1;

// 同じ行で閉じるものは段落の中の inline コメントとして読むので、block にしない。
function opensCommentBlock(line: Line): boolean {
  return (
    line.indent - line.baseIndent < 4 &&
    line.text.startsWith(DELIMITER, line.pos) &&
    !line.text.includes(DELIMITER, line.pos + DELIMITER.length)
  );
}

/**
 * 段落の文字 `text` の中で、inline のコメントが開いたまま終わっているか。inline parser と同じく、
 * 開きの `%%` から次の `%%` までを 1 つのコメントとして数える。コードの中の `%%` と `\%%` も数える
 * 近似で、それらを含む段落では、後続の `%%` の行を block の開きとして読まないことがある。
 */
function hasOpenComment(text: string): boolean {
  let open = false;
  for (let i = text.indexOf(DELIMITER); i >= 0; i = text.indexOf(DELIMITER, i + DELIMITER.length)) {
    open = !open;
  }
  return open;
}

/**
 * Obsidian のコメント `%%text%%` を解析する MarkdownConfig。
 *
 * 段落の中の `%%...%%`（改行をまたいでよい）は inline の node、`%%` で始まり同じ行で閉じない
 * 行は、次に `%%` が現れる行までを block の node にする。block は空行をまたげ、閉じなければ
 * 文書末まで続く。どちらも中身を 1 つの node として消費し、中の WikiLink、tag、強調は node にしない。
 * `%%` の前後の文字による制約（flanking）は無い。
 *
 * Obsidian より狭くしているところ:
 * - block は文書の最上位でだけ認識する。引用やリストの中では、同じ段落の中で閉じる inline
 *   コメントだけを読む。container が終わったかを block parser から判定する口（`Line.depth`）が
 *   @lezer/markdown の公開 API に無いため。
 * - 段落の途中で開いて閉じない `%%` は source のまま残す。inline parser からは段落の外を読めない。
 * - 閉じ `%%` の後ろに同じ行で続く文字は、どの node にも入らない（inline として解析しない）。
 *
 * links/tags/block id の抽出には載せない。
 */
export const ObsidianComment: MarkdownConfig = {
  defineNodes: [
    { name: commentNodes.inline },
    { name: commentNodes.block, block: true },
    { name: commentNodes.mark, style: tags.processingInstruction },
  ],
  parseBlock: [
    {
      name: commentNodes.block,
      before: "FencedCode",
      parse(cx, line) {
        if (cx.depth !== TOP_LEVEL_DEPTH || !opensCommentBlock(line)) return false;
        const from = cx.lineStart + line.pos;
        const marks = [cx.elt(commentNodes.mark, from, from + DELIMITER.length)];
        let to: number | null = null;
        while (cx.nextLine()) {
          const close = line.text.indexOf(DELIMITER);
          if (close < 0) continue;
          to = cx.lineStart + close + DELIMITER.length;
          marks.push(cx.elt(commentNodes.mark, to - DELIMITER.length, to));
          cx.nextLine();
          break;
        }
        cx.addElement(cx.elt(commentNodes.block, from, to ?? cx.prevLineEnd(), marks));
        return true;
      },
      // 段落の直後の行でも block を開けるようにする（Obsidian の例は `%%` だけの行で囲む）。
      // ただし段落の中で開いた `%%` が閉じていなければ、その行は閉じとして段落に残す。打ち切ると
      // 閉じの `%%` が開きとして読まれ、後ろの本文がコメントに、コメントの中身が本文になる。
      endLeaf: (cx, line, leaf) =>
        cx.depth === TOP_LEVEL_DEPTH && opensCommentBlock(line) && !hasOpenComment(leaf.content),
    },
  ],
  parseInline: [
    {
      name: commentNodes.inline,
      parse(cx, next, pos) {
        if (next !== PERCENT || cx.char(pos + 1) !== PERCENT) return -1;
        const close = cx.slice(pos + DELIMITER.length, cx.end).indexOf(DELIMITER);
        if (close < 0) return -1;
        const end = pos + DELIMITER.length + close + DELIMITER.length;
        return cx.addElement(
          cx.elt(commentNodes.inline, pos, end, [
            cx.elt(commentNodes.mark, pos, pos + DELIMITER.length),
            cx.elt(commentNodes.mark, end - DELIMITER.length, end),
          ]),
        );
      },
    },
  ],
};
