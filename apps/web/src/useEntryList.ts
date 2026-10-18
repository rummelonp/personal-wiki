import { DEFAULT_LIST_SORT, type ListSort } from "@personal-wiki/domain/list-sort";
import { ANONYMOUS_SEARCH_MIN_CHARS, searchQueryLength } from "@personal-wiki/domain/search";
import { useCallback, useEffect, useRef, useState } from "react";
import { failureMessage, type ListedPage, LOAD_FAILED, listRecent, searchPages } from "./pages-api";
import type { VisibilityFilter } from "./route";
import { restoreCount } from "./scroll-restore";

/** 条件が変わる前の一覧。取り直しの間、表示だけに使う（status は loading のまま） */
export interface PreviousList {
  entries: ListedPage[];
  next: string | null;
  /** 前の一覧を取ったときの並び。行の日時は、新しい並びでなくこの並びに合わせて出す */
  sort: ListSort;
}

export type ListState =
  /**
   * previous は、条件が変わって取り直している間の前の一覧。status を ready にしないのは、
   * 戻るの復元が「前の画面が残っている」と取り違えて位置を戻さなくなるため。
   */
  | { status: "loading"; previous?: PreviousList | undefined }
  | {
      status: "ready";
      entries: ListedPage[];
      next: string | null;
      loadingMore: boolean;
      /** 取ったときの並び。検索結果は関連度の順だが、既定の並びとして持つ */
      sort: ListSort;
    }
  | { status: "unauthorized" }
  | { status: "error"; message: string }
  /** 匿名の検索語が API の受け付ける長さに満たない。リクエストは送っていない。 */
  | { status: "query_too_short"; min: number }
  /** API が検索語を受け付けなかった（長すぎる、制御文字を含む）。一覧の取得の失敗ではなく、語を直す案内にする。 */
  | { status: "invalid_query"; message: string };

export interface EntryListSource {
  /** 空でなければ検索結果。 */
  query: string;
  /** query が空のとき、このタグで絞った最近の更新。 */
  tag: string;
  /** query が空のとき、この公開範囲で絞った最近の更新。tag と AND で絞る。 */
  visibility: VisibilityFilter;
  /** query が空のときの並び。検索結果は関連度の順のまま */
  sort: ListSort;
  /** false（匿名）なら、API が 400 で拒む短い検索語を送らない。 */
  owner: boolean;
}

/** Worker の `LIST_MAX_LIMIT`。戻るで「さらに表示」の分まで読み直すときの上限 */
const RESTORE_MAX_LIMIT = 100;

/**
 * 戻る操作や進む操作で開いた一覧は、離れたときに読み込んでいた件数を最初の 1 回で読み直し、
 * 「さらに表示」で読み足した位置まで戻れるようにする。上限（100 件）を超えて読み足していた分は戻れない。
 */
function restoreLimit(): { limit?: number } {
  const count = restoreCount();
  return count === undefined ? {} : { limit: Math.min(Math.max(count, 1), RESTORE_MAX_LIMIT) };
}

function previousOf(state: ListState): PreviousList | undefined {
  if (state.status === "ready") {
    return state.entries.length > 0
      ? { entries: state.entries, next: state.next, sort: state.sort }
      : undefined;
  }
  return state.status === "loading" ? state.previous : undefined;
}

/** 一覧のデータだけを扱う。見せ方（行、配置）は持たない。 */
export function useEntryList({ query, tag, visibility, sort, owner }: EntryListSource) {
  // 検索中は並びを使わないので、並びを変えても取り直さない
  const listSort = query === "" ? sort : DEFAULT_LIST_SORT;
  const key = `${owner}\n${tag}\n${visibility}\n${listSort}\n${query}`;
  const [held, setHeld] = useState<{ key: string; state: ListState }>({
    key,
    state: { status: "loading" },
  });
  // 条件が変わった描画で前の条件の一覧を ready のまま返すと、戻るの復元が「前の画面が残っている」と
  // 取り違えて位置を戻さない（タグの一覧へ移ってすぐ戻ったとき）。取り直しの effect を待たずに loading とする
  const state: ListState =
    held.key === key ? held.state : { status: "loading", previous: previousOf(held.state) };
  const setState = useCallback((next: ListState) => setHeld({ key, state: next }), [key]);
  // 条件が変わった後に遅れて届いたレスポンスで、表示を上書きしない
  const generation = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt は再読み込みで同じ条件を取り直すための印
  useEffect(() => {
    const mine = ++generation.current;
    if (query !== "" && !owner && searchQueryLength(query) < ANONYMOUS_SEARCH_MIN_CHARS) {
      setState({ status: "query_too_short", min: ANONYMOUS_SEARCH_MIN_CHARS });
      return;
    }
    // 取り直しの間も前の一覧を持ち越す。待っている間に一覧が 1 行に縮まないようにする
    setHeld((current) => ({
      key,
      state: { status: "loading", previous: previousOf(current.state) },
    }));
    const load =
      query !== ""
        ? searchPages(query).then((res) =>
            res.ok ? { ...res, value: { entries: res.value, next: null } } : res,
          )
        : listRecent(null, { tag, visibility, sort: listSort, ...restoreLimit() }).then((res) =>
            res.ok
              ? { ...res, value: { entries: res.value.pages, next: res.value.nextCursor } }
              : res,
          );
    void load.then((res) => {
      if (generation.current !== mine) return;
      if (res.ok) setState({ status: "ready", ...res.value, loadingMore: false, sort: listSort });
      else if (res.reason === "unauthorized") setState({ status: "unauthorized" });
      else if (res.reason === "invalid_query")
        setState({ status: "invalid_query", message: res.message });
      else setState({ status: "error", message: failureMessage(res, LOAD_FAILED) });
    });
  }, [query, tag, visibility, listSort, owner, key, setState, attempt]);

  const loadMore = useCallback(async () => {
    if (state.status !== "ready" || state.next === null || state.loadingMore) return;
    const mine = generation.current;
    const { entries, next } = state;
    setState({ ...state, loadingMore: true });
    const res = await listRecent(next, { tag, visibility, sort: listSort });
    if (generation.current !== mine) return;
    if (res.ok) {
      setState({
        status: "ready",
        entries: [...entries, ...res.value.pages],
        next: res.value.nextCursor,
        loadingMore: false,
        sort: listSort,
      });
    } else {
      setState({ status: "ready", entries, next, loadingMore: false, sort: listSort });
    }
  }, [state, tag, visibility, listSort, setState]);

  return { state, loadMore, reload };
}
