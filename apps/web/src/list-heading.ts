import type { VisibilityFilter } from "./route";

/** 公開範囲の絞り込みを、見出しと空の状態で呼ぶ名前。 */
export const VISIBILITY_FILTER_NOUNS: Record<Exclude<VisibilityFilter, "">, string> = {
  public: "公開ページ",
  draft: "下書き",
};

/**
 * 一覧の見出し。検索中は tag と visibility を使わない（検索 API にどちらの絞り込みも無いため）。
 * 狭い画面では絞り込みの欄が一覧の下に回るので、公開範囲の絞り込みも見出しで伝える。
 */
export function listHeading(query: string, tag: string, visibility: VisibilityFilter = ""): string {
  const trimmed = query.trim();
  if (trimmed !== "") return `「${trimmed}」の検索結果`;
  if (visibility === "") return tag !== "" ? `タグ「${tag}」` : "最近の更新";
  const noun = VISIBILITY_FILTER_NOUNS[visibility];
  return tag !== "" ? `タグ「${tag}」の${noun}` : noun;
}

/** 一覧の見出しの class。開き括弧で始まる見出しは、行頭の空きを詰める。 */
export function listTitleClass(heading: string): string {
  return heading.startsWith("「") ? "list-title list-title-quoted" : "list-title";
}
