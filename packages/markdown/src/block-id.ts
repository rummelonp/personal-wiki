import { tags as highlightTags } from "@lezer/highlight";
import { type MarkdownConfig, parser } from "@lezer/markdown";
import { Frontmatter } from "./frontmatter";
import { WikiLink } from "./wikilink";

const CARET = 94;
const BLOCK_ID_BODY = /[A-Za-z0-9-]+/y;

export const blockIdNodes = {
  marker: "BlockId",
  mark: "BlockIdMark",
  name: "BlockIdName",
} as const;

/**
 * 段落末尾の `^blockid` を inline node として解析する MarkdownConfig。
 *
 * block id の付与位置は段落（inline content）の末尾に限定する。`nameEnd !== cx.end` で
 * 弾くことで、本文中に現れる一般的な `^` 記号（べき乗の記法など）を誤って block id と
 * 認識しない。
 *
 * `[[Title^blockid]]` 内部の `^` とは衝突しない。WikiLink が `[[` の位置で自身の span を
 * まるごと消費するため、この rule がその内部の `^` の位置で呼ばれることがない
 * （wikilink.ts 参照）。
 */
export const BlockId: MarkdownConfig = {
  defineNodes: [
    { name: blockIdNodes.marker, style: highlightTags.processingInstruction },
    { name: blockIdNodes.mark, style: highlightTags.processingInstruction },
    { name: blockIdNodes.name, style: highlightTags.labelName },
  ],
  parseInline: [
    {
      name: blockIdNodes.marker,
      parse(cx, next, pos) {
        if (next !== CARET) return -1;
        BLOCK_ID_BODY.lastIndex = 0;
        const match = BLOCK_ID_BODY.exec(cx.slice(pos + 1, cx.end));
        if (!match) return -1;

        const nameEnd = pos + 1 + match[0].length;
        if (nameEnd !== cx.end) return -1;

        const children = [
          cx.elt(blockIdNodes.mark, pos, pos + 1),
          cx.elt(blockIdNodes.name, pos + 1, nameEnd),
        ];
        return cx.addElement(cx.elt(blockIdNodes.marker, pos, nameEnd, children));
      },
    },
  ],
};

// GFM Table は入れない（理由は wikilink.ts の wikiLinkParser）。入れるとセル末尾でも
// `nameEnd === cx.end` が成り立ち、表の中の `^id` が block id になって、先勝ちの解決先が
// 既存ページで変わりうる。Editor の構文木（GFM 入り）ではセル末尾にも BlockId node が付くが、
// block id として扱うのはこの抽出の結果だけである。
const blockIdParser = parser.configure([Frontmatter, WikiLink, BlockId]);

export interface BlockIdRef {
  readonly id: string;
  /** `^` の位置。navigation のスクロール先に使う。 */
  readonly from: number;
  /** id 文字列の直後の位置。 */
  readonly to: number;
}

/**
 * 本文中の block id 付与マーカー（段落末尾の `^blockid`）を構文木から取り出す。
 * 返り値は文書内での出現順（重複解決の「先に現れるほう」の判定はこの順序を使う）。
 */
export function extractBlockIds(text: string): BlockIdRef[] {
  const refs: BlockIdRef[] = [];
  blockIdParser.parse(text).iterate({
    enter(node) {
      if (node.name !== blockIdNodes.name) return true;
      refs.push({ id: text.slice(node.from, node.to), from: node.from - 1, to: node.to });
      return false;
    },
  });
  return refs;
}
