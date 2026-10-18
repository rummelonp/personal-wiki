import { useCallback, useState } from "react";

/** 一覧の並び。Worker の `LIST_SORTS` と同じ値。 */
export type ListSort = "updated" | "created" | "title";

export const DEFAULT_LIST_SORT: ListSort = "updated";

export const LIST_SORT_LABELS: Record<ListSort, string> = {
  updated: "更新日時",
  created: "作成日時",
  title: "タイトル",
};

export const LIST_SORTS = Object.keys(LIST_SORT_LABELS) as ListSort[];

const STORAGE_KEY = "personal-wiki:list-sort";

const isListSort = (value: unknown): value is ListSort =>
  typeof value === "string" && Object.hasOwn(LIST_SORT_LABELS, value);

/**
 * 端末に残した並び。URL には載せず、この値だけで並びを決める（URL と食い違う状態を作らない）。
 * 読めない環境（private window の制限、保存の拒否など）と知らない値は既定の並びにする。
 */
export function readStoredListSort(): ListSort {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isListSort(value) ? value : DEFAULT_LIST_SORT;
  } catch {
    return DEFAULT_LIST_SORT;
  }
}

function storeListSort(sort: ListSort) {
  try {
    if (sort === DEFAULT_LIST_SORT) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, sort);
  } catch {
    // 書けない環境では、この画面を開いている間だけ選んだ並びにする
  }
}

/** 一覧の並びと、選び直して端末に残す関数。 */
export function useListSort(): [ListSort, (sort: ListSort) => void] {
  const [sort, setSort] = useState(readStoredListSort);
  const choose = useCallback((next: ListSort) => {
    storeListSort(next);
    setSort(next);
  }, []);
  return [sort, choose];
}
