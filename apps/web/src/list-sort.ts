import { DEFAULT_LIST_SORT, isListSort, type ListSort } from "@personal-wiki/domain/list-sort";
import { useCallback, useState } from "react";

/** Record にして、並びの値が増えたときに表示名の抜けを型エラーにする。 */
export const LIST_SORT_LABELS: Record<ListSort, string> = {
  updated: "更新日時",
  created: "作成日時",
  title: "タイトル",
};

const STORAGE_KEY = "personal-wiki:list-sort";

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
