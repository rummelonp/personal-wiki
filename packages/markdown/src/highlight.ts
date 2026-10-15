import { tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";

/** `==text==` の構文木ノード名。decoration 側が文字列リテラルを直書きしないよう、ここを唯一の定義とする。 */
export const highlightNodes = {
  highlight: "Highlight",
  mark: "HighlightMark",
} as const;

const EQUALS = 61;

// @lezer/markdown が delimiter の flanking 判定に使う句読点の集合と同じもの。
const PUNCTUATION = /[\p{S}\p{P}]/u;

const HighlightDelimiter = { resolve: highlightNodes.highlight, mark: highlightNodes.mark };

/**
 * Obsidian の `==text==` を inline node として解析する MarkdownConfig。
 *
 * 開きと閉じの判定は GFM の Strikethrough（`~~`）と同じ flanking 規則に従う。
 * Obsidian の Reading view がこの規則で解釈し、`== text ==` のように内側が空白の
 * ものはハイライトにしない。Live Preview はこれを緩く扱うが、そちらは Reading view との
 * 不一致として報告されている挙動なので合わせない。
 *
 * `=` が 3 つ以上続く並び（`===`、`a !== b`）は記法にしない。3 つ目の `=` を
 * 開きか閉じのどちらに含めるかで結果が変わり、どちらを選んでも Obsidian との一致を
 * 確かめられないため、source のまま残す側に倒す。
 *
 * delimiter は中身を消費しないので、`==[[Title]]==` の中の WikiLink や tag はそのまま
 * それぞれの node になる。
 */
export const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: highlightNodes.highlight },
    { name: highlightNodes.mark, style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: highlightNodes.highlight,
      after: "Emphasis",
      parse(cx, next, pos) {
        if (next !== EQUALS || cx.char(pos + 1) !== EQUALS) return -1;
        if (cx.char(pos - 1) === EQUALS || cx.char(pos + 2) === EQUALS) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const spaceBefore = /\s|^$/.test(before);
        const spaceAfter = /\s|^$/.test(after);
        const punctBefore = PUNCTUATION.test(before);
        const punctAfter = PUNCTUATION.test(after);
        return cx.addDelimiter(
          HighlightDelimiter,
          pos,
          pos + 2,
          !spaceAfter && (!punctAfter || spaceBefore || punctBefore),
          !spaceBefore && (!punctBefore || spaceAfter || punctAfter),
        );
      },
    },
  ],
};
