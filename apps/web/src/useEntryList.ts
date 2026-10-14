import { ANONYMOUS_SEARCH_MIN_CHARS, searchQueryLength } from "@personal-wiki/domain/search";
import { useCallback, useEffect, useRef, useState } from "react";
import { failureMessage, type ListedPage, listRecent, searchPages } from "./pages-api";
import { restoreCount } from "./scroll-restore";

export type ListState =
  | { status: "loading" }
  | { status: "ready"; entries: ListedPage[]; next: string | null; loadingMore: boolean }
  | { status: "unauthorized" }
  | { status: "error"; message: string }
  /** 匿名の検索語が API の受け付ける長さに満たない。要求は送っていない。 */
  | { status: "query_too_short"; min: number };

export interface EntryListSource {
  /** 空でなければ検索結果。 */
  query: string;
  /** query が空のとき、このタグで絞った最近の更新。 */
  tag: string;
  /** false（匿名）なら、API が 400 で拒む短い検索語を送らない。 */
  owner: boolean;
}

/** Worker の `LIST_MAX_LIMIT`。戻るで「さらに表示」の分まで読み直すときの上限 */
const RESTORE_MAX_LIMIT = 100;

/**
 * 戻る・進むで開いた一覧は、離れたときに読み込んでいた件数を最初の 1 回で読み直し、
 * 「さらに表示」で読み足した位置まで戻れるようにする。上限（100 件）を超えて読み足していた分は戻れない。
 */
function restoreLimit(): { limit?: number } {
  const count = restoreCount();
  return count === undefined ? {} : { limit: Math.min(Math.max(count, 1), RESTORE_MAX_LIMIT) };
}

/** 一覧のデータだけを扱う。見せ方（行、配置）は持たない。 */
export function useEntryList({ query, tag, owner }: EntryListSource) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  // 条件が変わった後に遅れて届いた応答で、表示を上書きしない
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    if (query !== "" && !owner && searchQueryLength(query) < ANONYMOUS_SEARCH_MIN_CHARS) {
      setState({ status: "query_too_short", min: ANONYMOUS_SEARCH_MIN_CHARS });
      return;
    }
    setState({ status: "loading" });
    const load =
      query !== ""
        ? searchPages(query).then((res) =>
            res.ok ? { ...res, value: { entries: res.value, next: null } } : res,
          )
        : listRecent(null, { tag, ...restoreLimit() }).then((res) =>
            res.ok
              ? { ...res, value: { entries: res.value.pages, next: res.value.nextCursor } }
              : res,
          );
    void load.then((res) => {
      if (generation.current !== mine) return;
      if (res.ok) setState({ status: "ready", ...res.value, loadingMore: false });
      else if (res.reason === "unauthorized") setState({ status: "unauthorized" });
      else setState({ status: "error", message: failureMessage(res, "取得できなかった") });
    });
  }, [query, tag, owner]);

  const loadMore = useCallback(async () => {
    if (state.status !== "ready" || state.next === null || state.loadingMore) return;
    const mine = generation.current;
    const { entries, next } = state;
    setState({ ...state, loadingMore: true });
    const res = await listRecent(next, { tag });
    if (generation.current !== mine) return;
    if (res.ok) {
      setState({
        status: "ready",
        entries: [...entries, ...res.value.pages],
        next: res.value.nextCursor,
        loadingMore: false,
      });
    } else {
      setState({ status: "ready", entries, next, loadingMore: false });
    }
  }, [state, tag]);

  return { state, loadMore };
}
