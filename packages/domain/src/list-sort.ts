/**
 * 一覧（listRecentPages、REST の `/api/pages/recent`）の並び。
 * updated は更新日時の降順、created は作成日時の降順、title は title_key の昇順。
 * REST の検証、SQL、cursor の形は Worker が、表示名は web が、この値を網羅して持つ。
 */
export const LIST_SORTS = ["updated", "created", "title"] as const;
export type ListSort = (typeof LIST_SORTS)[number];

/** sort を指定しないときの並び。 */
export const DEFAULT_LIST_SORT: ListSort = "updated";

export const isListSort = (value: unknown): value is ListSort =>
  typeof value === "string" && (LIST_SORTS as readonly string[]).includes(value);
