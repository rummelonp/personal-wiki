import type { WikiLinkClick } from "@personal-wiki/editor";

/*
 * ページの URL の fragment（`#` の後ろ）が指す、ページの中の場所。
 * wikilink の `#` の後ろ（`[[A#見出し]]`、`[[A#^id]]`、`[[A^id]]`）をそのまま持ち、title の URL と
 * 同じく encodeURIComponent で符号化する。見出しと block id は、先頭の `^` で見分ける。
 */
export type PageFragment = { kind: "heading"; heading: string } | { kind: "block"; id: string };

/**
 * wikilink が指す場所を fragment の文字列にする。場所を指さない link は null。
 * `[[A#B#^id]]` のように見出しを重ねた block 参照は、最後の block だけを指す（block id は
 * page の中で一意なので、途中の見出しは要らない）。
 */
export function fragmentTextOf(link: Pick<WikiLinkClick, "heading" | "blockId">): string | null {
  if (link.blockId !== null) return `^${link.blockId}`;
  if (link.heading === null) return null;
  const last = link.heading.split("#").at(-1)?.trim() ?? "";
  return last.startsWith("^") ? last : link.heading;
}

/** wikilink が指す場所の URL の hash（`#` 付き）。場所を指さない link は空文字列。 */
export function hashOfLink(link: Pick<WikiLinkClick, "heading" | "blockId">): string {
  const text = fragmentTextOf(link);
  return text === null ? "" : `#${encodeURIComponent(text)}`;
}

/**
 * URL の hash（`location.hash`）が指す場所を読む。場所を指さない hash と、読めない hash は null。
 * 空の見出し（`#`、`#%20`）と空の block id（`#^`）も null。
 */
export function parseFragment(hash: string): PageFragment | null {
  if (!hash.startsWith("#")) return null;
  let text: string;
  try {
    text = decodeURIComponent(hash.slice(1)).trim();
  } catch {
    return null;
  }
  if (text.startsWith("^")) {
    const id = text.slice(1).trim();
    return id === "" ? null : { kind: "block", id };
  }
  return text === "" ? null : { kind: "heading", heading: text };
}
