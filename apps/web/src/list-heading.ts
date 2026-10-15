/** 一覧の見出し。検索中は tag を使わない（検索 API に tag の絞り込みが無いため）。 */
export function listHeading(query: string, tag: string): string {
  const trimmed = query.trim();
  if (trimmed !== "") return `「${trimmed}」の検索結果`;
  return tag !== "" ? `タグ「${tag}」` : "最近の更新";
}

/** 一覧の見出しの class。開き括弧で始まる見出しは、行頭の空きを詰める。 */
export function listTitleClass(heading: string): string {
  return heading.startsWith("「") ? "list-title list-title-quoted" : "list-title";
}
