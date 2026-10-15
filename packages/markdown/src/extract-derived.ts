import { foldKeepingUnderscore, normalizeTitleKey } from "@personal-wiki/domain";
import { isAttachmentTarget } from "./embed";
import { frontmatterEnd } from "./frontmatter";
import { parseFrontmatterFields } from "./frontmatter-fields";
import { extractPlainTextParts } from "./plain-text";
import { extractTags, frontmatterTagName } from "./tag";
import { extractWikiLinks } from "./wikilink";

export interface DerivedLink {
  /** `[[...]]` に書かれた target。`#heading` と `^blockid` は含まない */
  readonly targetTitle: string;
  readonly targetTitleKey: string;
}

export interface DerivedTag {
  /** 本文に最初に現れた表記 */
  readonly tag: string;
  /** ページをまたいで同じ tag を引くためのキー。SQLite の lower() や NOCASE では同じ畳み方を再現できないので、D1 にはこの値を入れる */
  readonly tagKey: string;
}

export interface DerivedData {
  readonly links: DerivedLink[];
  readonly tags: DerivedTag[];
  readonly plainText: string;
  /** plainText から行末のタグを除いたもの。一覧の抜粋の元で、全文検索には使わない */
  readonly excerptText: string;
  /** 本文の添付の embed（`![[...]]`）の target。書かれた文字列のまま、重複は先頭の 1 件に畳む。名前の形の検査は呼び出し側が行う */
  readonly attachments: string[];
}

/**
 * 本文から links、tags、plain text、attachments を導出する。D1 の派生テーブルと FTS はこの結果から作り直せる。
 *
 * - links: 添付（画像、動画、PDF、音声）の embed は page への参照ではないので除く。title_key が同じ link は先頭の 1 件に畳む。
 *   title_key にできない target（空白だけなど）は落とす。frontmatter の中の WikiLink は link にしない。
 * - tags: frontmatter の `tags` を先に、本文の `#tag` を後に並べる。大文字小文字や全角半角だけが
 *   違う tag は同じものとして先頭の表記に畳む。
 */
export function extractDerived(body: string): DerivedData {
  const links: DerivedLink[] = [];
  const seenLinks = new Set<string>();
  const attachments = new Set<string>();
  for (const ref of extractWikiLinks(body)) {
    if (ref.isEmbed && isAttachmentTarget(ref.target)) {
      attachments.add(ref.target);
      continue;
    }
    const key = normalizeTitleKey(ref.target);
    if (!key.ok || seenLinks.has(key.value)) continue;
    seenLinks.add(key.value);
    links.push({ targetTitle: ref.target, targetTitleKey: key.value });
  }

  const end = frontmatterEnd(body);
  const frontmatterTags =
    end === null
      ? []
      : parseFrontmatterFields(body.slice(0, end)).tags.flatMap(
          (value) => frontmatterTagName(value) ?? [],
        );
  const tags: DerivedTag[] = [];
  const seenTags = new Set<string>();
  for (const name of [...frontmatterTags, ...extractTags(body)]) {
    const tagKey = foldKeepingUnderscore(name);
    if (seenTags.has(tagKey)) continue;
    seenTags.add(tagKey);
    tags.push({ tag: name, tagKey });
  }

  const { text, textWithoutTrailingTags } = extractPlainTextParts(body);
  return {
    links,
    tags,
    plainText: text,
    excerptText: textWithoutTrailingTags,
    attachments: [...attachments],
  };
}
