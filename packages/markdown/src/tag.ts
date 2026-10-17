import { tags as highlightTags } from "@lezer/highlight";
import { type InlineContext, type MarkdownConfig, parser } from "@lezer/markdown";
import { Frontmatter } from "./frontmatter";
import { WikiLink } from "./wikilink";

const HASH = 35;
const SLASH = 47;
/**
 * タグ本体の文字集合。日本語（漢字、かな、カナ）と `#foo/bar` のようなネストを許す。
 * `/` は文字の間にだけ置ける。先頭と連続の `/` はここで弾き、末尾の `/` は `parse` で弾く
 * （正規表現が `tag` まで取ってしまうので、直後の文字を見る必要がある）。
 */
const TAG_BODY_CHARS = String.raw`[\p{L}\p{N}_-]+(?:/[\p{L}\p{N}_-]+)*`;
const TAG_BODY = new RegExp(TAG_BODY_CHARS, "uy");
/**
 * 文字列全体がタグ本体であること。
 * `frontmatterTagName` が本文の `#tag` と同じ文字集合で判定するために、同じ定義から組み立てる。
 */
const WHOLE_TAG_BODY = new RegExp(`^${TAG_BODY_CHARS}$`, "u");
/**
 * Obsidian のヘルプは tag に「数字以外の文字を 1 つ以上含む」ことを求め、`#1984` を tag にしない。
 * `#123` のような issue 参照を tags に入れないために、`/` や `-` を数字以外とは数えず、文字を 1 つ以上含む
 * 本体だけを tag にする。`#2026/10` のような数字と記号だけの本体や、`#_`、`#-` のような記号だけの語も落ちる。
 * `\p{Nl}` はローマ数字 `Ⅻ` のように、数値でも文字として書かれるものを tag にするために入れる。
 */
const HAS_LETTER = /[\p{L}\p{Nl}]/u;
/**
 * `#` の直前に置ける空白。全角空白などの Unicode の空白を含む（JavaScript の `\s`）。
 * Obsidian のヘルプは `#` の直前の条件を述べていないが、日本語の文は全角空白で区切って書くことがある。
 * 全角空白は目に見える区切りで、URL や識別子の途中には現れないので、tag を取りこぼす側に倒す理由がない。
 */
const TAG_PRECEDER = /\s/u;
/**
 * `#` の直前に置ける開きの区切り記号。強調／取り消し／ハイライト／コメントの開きと開き括弧で、
 * Obsidian はこれらの中の tag も数える。
 * 区切り記号の直前が語の途中なら開きではなく閉じや語の一部なので（`==a==#b`、`?t=YWJj==#s`、`a_#b`）、
 * 区切り記号自体の直前も同じ判定にかける。長い記号を先に試す。
 */
const OPENING_DELIMITERS = ["**", "__", "~~", "==", "%%", "*", "_", "(", "[", "（", "「", "『"];

/** 開きの区切り記号を構成する文字。この文字が `#` の手前に続く範囲だけが、境界の判定で遡る対象になる。 */
const DELIMITER_CHARS = new Set(
  OPENING_DELIMITERS.flatMap((d) => [...d].map((c) => c.charCodeAt(0))),
);

/**
 * `pos` が tag の始まりになれる位置か。行頭、空白の直後、または境界に置かれた開きの区切り記号の直後。
 * `guard` は inline の解析で本文の前に足す文字列で、その直後を行頭として扱う。
 *
 * 区切り記号の連続の先頭は、行頭か空白の直後かだけで決まる。連続の中は先頭から順に表にして、
 * 長さに対して線形で済ませる。`**` と `*` のように重なる記号ごとに手前へ再帰すると、
 * 連続の長さに対して呼び出しが指数的に増える。
 */
function isTagBoundary(cx: InlineContext, pos: number, guard: string): boolean {
  const isStart = (at: number) =>
    at <= cx.offset || (guard !== "" && at === guard.length && cx.slice(0, at) === guard);
  const followsSpace = (at: number) => TAG_PRECEDER.test(cx.slice(at - 1, at));
  if (isStart(pos) || followsSpace(pos)) return true;

  let low = pos;
  while (low > cx.offset && DELIMITER_CHARS.has(cx.char(low - 1))) low -= 1;
  // memo[i] は位置 low + i が境界か
  const memo = new Uint8Array(pos - low + 1);
  memo[0] = isStart(low) || followsSpace(low) ? 1 : 0;
  for (let at = low + 1; at <= pos; at += 1) {
    memo[at - low] = OPENING_DELIMITERS.some(
      (delimiter) =>
        at - delimiter.length >= low &&
        memo[at - delimiter.length - low] === 1 &&
        cx.slice(at - delimiter.length, at) === delimiter,
    )
      ? 1
      : 0;
  }
  return memo[pos - low] === 1;
}

function isTagBody(body: string): boolean {
  return WHOLE_TAG_BODY.test(body) && HAS_LETTER.test(body);
}

export const tagNodes = {
  tag: "Tag",
  mark: "TagMark",
  name: "TagName",
} as const;

/**
 * `#tag` を inline node として解析する MarkdownConfig を作る。
 *
 * `WikiLink` と同じ parser インスタンスで使うことを前提にしている（`extractTags` 参照）。
 * 別々の parser にすると、`[[Title#Heading]]` の `#Heading` を WikiLink が消費する前に
 * この Tag ルールが単独の tag として拾ってしまう。
 *
 * `guard` は、解析する文字列の先頭に block の記法を無効にするために足した文字列。
 * その直後を行頭として扱い、足していない本文と同じ位置で tag になるようにする。
 */
export function createTag(guard = ""): MarkdownConfig {
  return {
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
          // 裸の URL の `#section` や `foo#bar` を拾わない。
          if (!isTagBoundary(cx, pos, guard)) return -1;
          TAG_BODY.lastIndex = 0;
          const match = TAG_BODY.exec(cx.slice(pos + 1, cx.end));
          if (!match || !HAS_LETTER.test(match[0])) return -1;
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
}

export const Tag = createTag();

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
