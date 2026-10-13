import { tags } from "@lezer/highlight";
import { type MarkdownConfig, parser } from "@lezer/markdown";
import { Frontmatter } from "./frontmatter";

/**
 * `[[Title]]` / `[[Title|Label]]` の構文木ノード名。
 * decoration 側が文字列リテラルを直書きしないよう、ここを唯一の定義とする。
 */
export const wikiLinkNodes = {
  link: "WikiLink",
  mark: "WikiLinkMark",
  target: "WikiLinkTarget",
  separator: "WikiLinkSeparator",
  label: "WikiLinkLabel",
} as const;

const BANG = 33;
const BRACKET_OPEN = 91;
const BRACKET_CLOSE = 93;
const NEWLINE = 10;

type LabelSeparator = "|" | "\\|";

/**
 * `[[` と `]]` の間の生テキストで、target と label を分ける区切りの位置（content の中の offset）。
 * 最初の `|` が区切りで、直前に `\` があれば `\|` の 2 文字を区切りとする。
 *
 * `\|` は Obsidian が表のセルの中で label の区切りに使う書き方である。抽出の parser は表を
 * 解析しない（`wikiLinkParser` の注記）ので、表の外でも同じく区切りとして読む。
 * `\\|` のように `\` 自体を escape した形も区別せず `\|` の区切りとして読む。Obsidian は
 * ファイル名に `\` を許さないので、`\` で終わる target を区別して読む必要は無い。
 */
function findLabelSeparator(
  content: string,
): { from: number; to: number; text: LabelSeparator } | null {
  const pipe = content.indexOf("|");
  if (pipe < 0) return null;
  if (pipe > 0 && content[pipe - 1] === "\\") return { from: pipe - 1, to: pipe + 1, text: "\\|" };
  return { from: pipe, to: pipe + 1, text: "|" };
}

/**
 * `[[` と `]]` の間の生テキストを target・heading・blockId・label に分ける。
 * 最初の `|`（または `\|`）だけを区切りとして label を切り出し、残った target 側から
 * 最初の `#`（heading）または `^`（blockId）で target 本体を分ける。
 * link として成立しない場合は null を返す。
 */
export function splitWikiLinkContent(content: string): WikiLinkParts | null {
  if (content.includes("[") || content.includes("]") || content.includes("\n")) return null;
  const separator = findLabelSeparator(content);
  const rawTarget = separator === null ? content : content.slice(0, separator.from);
  const label = separator === null ? "" : content.slice(separator.to).trim();

  // rawTarget は #/^ を含まない先頭部分に必ずマッチするので match は常に非 null。
  const match = /^([^#^]*)(?:([#^])(.*))?$/.exec(rawTarget) as RegExpExecArray;
  const target = (match[1] ?? "").trim();
  if (target.length === 0) return null;

  const marker = match[2];
  const restTrimmed = (match[3] ?? "").trim();
  const heading = marker === "#" && restTrimmed.length > 0 ? restTrimmed : null;
  const blockId = marker === "^" && restTrimmed.length > 0 ? restTrimmed : null;

  const hasLabel = separator !== null && label.length > 0;
  return {
    target,
    label: hasLabel ? label : null,
    labelSeparator: hasLabel ? separator.text : null,
    heading,
    blockId,
  };
}

export interface WikiLinkParts {
  readonly target: string;
  /** 区切りより後ろを trim したもの。`\|` などの escape は解かず、書かれたまま持つ */
  readonly label: string | null;
  /**
   * label の区切りの書き方。label を書き戻す処理（rename の Rewrite links）はこれを保つ。
   * 表の中の `\|` を `|` に書き換えると、そこでセルが分かれる。label が null なら null。
   * `[[A\|]]` のように区切りだけがあっても null になる。構文木には WikiLinkSeparator の node ができる
   * （Editor が区切りを隠すため）ので、区切りの有無はそちらで見る。
   */
  readonly labelSeparator: LabelSeparator | null;
  readonly heading: string | null;
  readonly blockId: string | null;
}

export interface WikiLinkRef extends WikiLinkParts {
  /** `[[` の位置 */
  readonly from: number;
  /** `]]` の直後の位置 */
  readonly to: number;
  /** `![[...]]` の embed 記法かどうか */
  readonly isEmbed: boolean;
}

/**
 * `[[Title]]` `[[Title|Label]]` を inline node として解析する MarkdownConfig。
 *
 * `Link` より前に登録する。後ろに置くと標準の Link parser が先頭の `[` を
 * delimiter として消費してしまい、`[[` に到達しない。
 * 既定の並びは Link の次に Image が続くため、`before: "Link"` を指定すれば
 * `!` から始まる `![[Embed]]` でも Image より先にこの parser が呼ばれる。
 */
export const WikiLink: MarkdownConfig = {
  defineNodes: [
    { name: wikiLinkNodes.link, style: tags.link },
    { name: wikiLinkNodes.mark, style: tags.processingInstruction },
    { name: wikiLinkNodes.target, style: tags.link },
    { name: wikiLinkNodes.separator, style: tags.processingInstruction },
    { name: wikiLinkNodes.label, style: tags.link },
  ],
  parseInline: [
    {
      name: wikiLinkNodes.link,
      before: "Link",
      parse(cx, next, pos) {
        // `![[Embed]]` の `!` は WikiLink node に含めない。標準の Image parser に
        // 先に `!` `[` を奪われないよう、ここで自分から先読みして両方消費する。
        const bracketPos = next === BANG ? pos + 1 : pos;
        if (cx.char(bracketPos) !== BRACKET_OPEN || cx.char(bracketPos + 1) !== BRACKET_OPEN) {
          return -1;
        }

        const contentStart = bracketPos + 2;
        let scan = contentStart;
        let closed = false;
        while (scan < cx.end) {
          const ch = cx.char(scan);
          // target / label は 1 行に閉じる。`[` を含めないことで
          // `[[a[[b]]c]]` が内側だけ link になり、解釈が一意に決まる。
          if (ch === NEWLINE || ch === BRACKET_OPEN) return -1;
          if (ch === BRACKET_CLOSE) {
            if (cx.char(scan + 1) !== BRACKET_CLOSE) return -1;
            closed = true;
            break;
          }
          scan += 1;
        }
        if (!closed) return -1;

        const contentEnd = scan;
        const to = contentEnd + 2;
        const content = cx.slice(contentStart, contentEnd);
        const parts = splitWikiLinkContent(content);
        if (!parts) return -1;

        // `\|` は `\` も separator に含める。Editor は separator の終わりまでを隠すので、
        // target に残すと簡略表示で `\` だけが見える。
        const separator = findLabelSeparator(content);
        const targetEnd = separator === null ? contentEnd : contentStart + separator.from;
        const children = [
          cx.elt(wikiLinkNodes.mark, bracketPos, contentStart),
          cx.elt(wikiLinkNodes.target, contentStart, targetEnd),
        ];
        if (separator !== null) {
          const separatorTo = contentStart + separator.to;
          children.push(cx.elt(wikiLinkNodes.separator, targetEnd, separatorTo));
          if (separatorTo < contentEnd) {
            children.push(cx.elt(wikiLinkNodes.label, separatorTo, contentEnd));
          }
        }
        children.push(cx.elt(wikiLinkNodes.mark, contentEnd, to));
        return cx.addElement(cx.elt(wikiLinkNodes.link, bracketPos, to, children));
      },
    },
  ],
};

/**
 * WikiLink node（`[[` から始まる）が `![[...]]` の embed かどうか。
 * `!` は node に含めないので、node の直前の 1 文字で決まる。
 */
export function isEmbedWikiLink(charBeforeLink: string): boolean {
  return charBeforeLink === "!";
}

// GFM Table は入れない。Editor の構文木（lang-markdown の GFM 入り）とは表の中だけ解析単位が
// ずれるが、入れると表がセル単位で解析され、保存済みのページから派生データを作り直したときに links が変わる
// （表の行の `[[A|B]]` が `|` でセルに分かれて link でなくなる）。block-id.ts・tag.ts も同じ構成。
const wikiLinkParser = parser.configure([Frontmatter, WikiLink]);

/**
 * 本文中の WikiLink を構文木から取り出す。
 * backlink 抽出と parser の unit test の両方がこの関数を入り口にする。
 */
export function extractWikiLinks(text: string): WikiLinkRef[] {
  const refs: WikiLinkRef[] = [];
  wikiLinkParser.parse(text).iterate({
    enter(node) {
      if (node.name !== wikiLinkNodes.link) return true;
      const parts = splitWikiLinkContent(text.slice(node.from + 2, node.to - 2));
      if (parts) {
        const isEmbed = isEmbedWikiLink(text[node.from - 1] ?? "");
        refs.push({ from: node.from, to: node.to, isEmbed, ...parts });
      }
      return false;
    },
  });
  return refs;
}
