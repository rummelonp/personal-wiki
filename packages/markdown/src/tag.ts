import { tags as highlightTags } from "@lezer/highlight";
import { type InlineContext, type MarkdownConfig, parser } from "@lezer/markdown";
import { Frontmatter } from "./frontmatter";
import { WikiLink } from "./wikilink";

const HASH = 35;
const SLASH = 47;
/**
 * タグ本体。`/` は文字の間に 1 つだけ置ける区切りで、`#/`、`#tag/`、`#a//b` は tag にしない。
 * 日本語（漢字・かな・カナ）と `#foo/bar` のようなネストを許す。
 */
const TAG_BODY_CHARS = String.raw`[\p{L}\p{N}_-]+(?:/[\p{L}\p{N}_-]+)*`;
const TAG_BODY = new RegExp(TAG_BODY_CHARS, "uy");
/**
 * 文字列全体がタグ本体であること。
 * `frontmatterTagName` が本文の `#tag` と同じ文字集合で判定するために、同じ定義から組み立てる。
 */
const WHOLE_TAG_BODY = new RegExp(`^${TAG_BODY_CHARS}$`, "u");
const HAS_LETTER = /\p{L}/u;
/**
 * `#` の直前に置ける空白。全角空白などの Unicode の空白を含む（JavaScript の `\s`）。
 * Obsidian のヘルプは `#` の直前の条件を述べていないが、日本語の文は全角空白で区切って書くことがある。
 * 全角空白は目に見える区切りで、URL や識別子の途中には現れないので、tag を取りこぼす側に倒す理由がない。
 */
const TAG_PRECEDER = /\s/u;
/** ハイライトとコメントの開き。Obsidian はこの中の tag も数えるので、直後の `#` は tag にする。 */
const OPENING_DELIMITERS = new Set(["==", "%%"]);

function startsTagBoundary(cx: InlineContext, pos: number): boolean {
  if (pos <= cx.offset) return true;
  if (TAG_PRECEDER.test(String.fromCharCode(cx.char(pos - 1)))) return true;
  return pos - 2 >= cx.offset && OPENING_DELIMITERS.has(cx.slice(pos - 2, pos));
}

/**
 * 文字（`\p{L}`）を 1 つ以上含む本体だけを tag にする。
 * Obsidian のヘルプは「数字以外の文字を 1 つ以上含む」ことを求め、`#1984` を tag にしない。
 * `#123` のような issue 参照を tags に入れないために、`/` や `-` を数字以外とは数えず、
 * `#2026/10` のような数字と記号だけの本体も tag にしない。`#_`、`#-` のような記号だけの語も同じ規則で落ちる。
 */
function isTagBody(body: string): boolean {
  return WHOLE_TAG_BODY.test(body) && HAS_LETTER.test(body);
}

export const tagNodes = {
  tag: "Tag",
  mark: "TagMark",
  name: "TagName",
} as const;

/**
 * `#tag` を inline node として解析する MarkdownConfig。
 *
 * `WikiLink` と同じ parser インスタンスで使うことを前提にしている（`extractTags` 参照）。
 * 別々の parser にすると、`[[Title#Heading]]` の `#Heading` を WikiLink が消費する前に
 * この Tag ルールが単独の tag として拾ってしまう。
 */
export const Tag: MarkdownConfig = {
  defineNodes: [
    { name: tagNodes.tag, style: highlightTags.labelName },
    { name: tagNodes.mark, style: highlightTags.processingInstruction },
    { name: tagNodes.name, style: highlightTags.labelName },
  ],
  parseInline: [
    {
      name: tagNodes.tag,
      parse(cx, next, pos) {
        if (next !== HASH) return -1;
        // 裸の URL の `#section` や `foo#bar` を拾わないよう、行頭か空白の直後だけを tag にする。
        if (!startsTagBoundary(cx, pos)) return -1;
        TAG_BODY.lastIndex = 0;
        const match = TAG_BODY.exec(cx.slice(pos + 1, cx.end));
        if (!match || !isTagBody(match[0])) return -1;
        // `#tag/` のように `/` が残る形は、Obsidian の挙動を確かめられないので tag にしない。
        if (cx.char(pos + 1 + match[0].length) === SLASH) return -1;

        const nameEnd = pos + 1 + match[0].length;
        const children = [
          cx.elt(tagNodes.mark, pos, pos + 1),
          cx.elt(tagNodes.name, pos + 1, nameEnd),
        ];
        return cx.addElement(cx.elt(tagNodes.tag, pos, nameEnd, children));
      },
    },
  ],
};

const tagParser = parser.configure([Frontmatter, WikiLink, Tag]);

/**
 * frontmatter の `tags` に書かれた 1 項目を tag の表示名にする。tag として読めなければ null。
 *
 * 判定の規約は「本文に `#値` と書いたときに tag になるか」で、本文と frontmatter で同じ tag に
 * なることを保証する。`a, b` のような空白や `,` を含む値、`~` のような記号だけの値は
 * ここで落ちる。`1984` のような数字だけの値も、Obsidian に合わせて tag にしない。
 *
 * 値の `#` は、本文の書き方に引きずられた `tags: [#仕事]` を受けるために 1 つだけ剥がす。
 * Obsidian の properties は `#` を付けずに書く。
 */
export function frontmatterTagName(value: string): string | null {
  const trimmed = value.trim();
  const name = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  return isTagBody(name) ? name : null;
}

/** 本文中の `#tag` を構文木から取り出す。表示名をそのまま返し、正規化は呼び出し側の責務。 */
export function extractTags(text: string): string[] {
  const names: string[] = [];
  tagParser.parse(text).iterate({
    enter(node) {
      if (node.name !== tagNodes.name) return true;
      names.push(text.slice(node.from, node.to));
      return false;
    },
  });
  return names;
}
