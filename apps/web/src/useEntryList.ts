import { useCallback, useEffect, useRef, useState } from "react";
import { failureMessage, listRecent, type PageSummary, searchPages } from "./pages-api";

export type ListState =
  | { status: "loading" }
  | { status: "ready"; entries: PageSummary[]; next: string | null; loadingMore: boolean }
  | { status: "unauthorized" }
  | { status: "error"; message: string };

export interface EntryListSource {
  /** 空でなければ検索結果。 */
  query: string;
  /** query が空のとき、このタグで絞った最近の更新。 */
  tag: string;
}

/** 一覧のデータだけを扱う。見せ方（行、配置）は持たない。 */
export function useEntryList({ query, tag }: EntryListSource) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  // 条件が変わった後に遅れて届いた応答で、表示を上書きしない
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    setState({ status: "loading" });
    const load =
      query !== ""
        ? searchPages(query).then((res) =>
            res.ok ? { ...res, value: { entries: res.value, next: null } } : res,
          )
        : listRecent(null, { tag }).then((res) =>
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
  }, [query, tag]);

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
