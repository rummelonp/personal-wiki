import { DEFAULT_LIST_SORT, type ListSort } from "@personal-wiki/domain/list-sort";
import type { VisibilityFilter } from "./route";

/** 公開範囲の絞り込みを、見出しと空の状態で呼ぶ名前。 */
export const VISIBILITY_FILTER_NOUNS: Record<Exclude<VisibilityFilter, "">, string> = {
  public: "公開ページ",
  draft: "下書き",
};

/**
 * 一覧の見出し。検索中は tag と visibility を使わない（検索 API にどちらの絞り込みも無いため）。
 * 狭い画面では絞り込みの欄が一覧の下に回るので、公開範囲の絞り込みも見出しで伝える。
 * 絞らない一覧は、更新日時の順でなければ「最近の更新」と読めないので「すべてのページ」と呼ぶ。
 */
export function listHeading(
  query: string,
  tag: string,
  visibility: VisibilityFilter = "",
  sort: ListSort = DEFAULT_LIST_SORT,
): string {
  const trimmed = query.trim();
  if (trimmed !== "") return `「${trimmed}」の検索結果`;
  if (visibility === "") {
    if (tag !== "") return `タグ「${tag}」`;
    return sort === DEFAULT_LIST_SORT ? "最近の更新" : "すべてのページ";
  }
  const noun = VISIBILITY_FILTER_NOUNS[visibility];
  return tag !== "" ? `タグ「${tag}」の${noun}` : noun;
}

/** 一覧の見出しの class。開き括弧で始まる見出しは、行頭の空きを詰める。 */
export function listTitleClass(heading: string): string {
  return heading.startsWith("「") ? "list-title list-title-quoted" : "list-title";
}
