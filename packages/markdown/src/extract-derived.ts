import { foldTitle, normalizeTitleKey } from "@personal-wiki/domain";
import { embedKindForTarget } from "./embed";
import { frontmatterEnd } from "./frontmatter";
import { parseFrontmatterFields } from "./frontmatter-fields";
import { extractPlainText } from "./plain-text";
import { extractTags, frontmatterTagName } from "./tag";
import { extractWikiLinks } from "./wikilink";

export interface DerivedLink {
  /** `[[...]]` に書かれた target。`#heading` と `^blockid` は含まない */
  readonly targetTitle: string;
  readonly targetTitleKey: string;
}

export interface DerivedData {
  readonly links: DerivedLink[];
  readonly tags: string[];
  readonly plainText: string;
}

/**
 * 本文から links・tags・plain text を導出する。D1 の派生テーブルと FTS はこの結果から作り直せる。
 *
 * - links: 画像・動画の embed は添付への参照なので除く。title_key が同じ link は先頭の 1 件に畳む。
 *   title_key にできない target（空白だけなど）は落とす。frontmatter の中の WikiLink は link にしない。
 * - tags: frontmatter の `tags` を先に、本文の `#tag` を後に並べる。大文字小文字や全角半角だけが
 *   違う tag は同じものとして先頭の表記に畳む。
 */
export function extractDerived(body: string): DerivedData {
  const links: DerivedLink[] = [];
  const seenLinks = new Set<string>();
  for (const ref of extractWikiLinks(body)) {
    if (ref.isEmbed && embedKindForTarget(ref.target) !== null) continue;
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
  const tags: string[] = [];
  const seenTags = new Set<string>();
  for (const name of [...frontmatterTags, ...extractTags(body)]) {
    const key = foldTitle(name);
    if (seenTags.has(key)) continue;
    seenTags.add(key);
    tags.push(name);
  }

  return { links, tags, plainText: extractPlainText(body) };
}
