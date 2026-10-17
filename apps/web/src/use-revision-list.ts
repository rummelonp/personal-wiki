import { useCallback, useEffect, useRef, useState } from "react";
import { listRevisions, type RevisionList, type RevisionSummary } from "./pages-api";

/** 一覧を取ったときのページの版と更新の時刻。先頭の版の時刻は、一覧と同じ時点の値と比べて決める */
export interface Basis {
  pageVersion: number;
  updatedAt: number;
}

export type ReadyList = {
  status: "ready";
  revisions: RevisionSummary[];
  next: string | null;
  basis: Basis;
};

export type ListState = { status: "loading" } | { status: "error" } | ReadyList;

/**
 * 取り直した 1 ページ目に、「さらに表示」で読んであった続きをつなぐ。版の番号はまとめで先頭の行しか
 * 進まないので、新しい 1 ページ目の最後の版が今の一覧にあれば、それより古い行と next はそのまま使える。
 * 無ければ（先頭が 1 ページ分より多く進んだ）つなぎ目が分からないので、1 ページ目だけにする。
 * 版の番号はページごとなので、pageId が変わるときは親が key で作り直す前提にしている。
 */
function mergeFresh(current: ListState, fresh: RevisionList, basis: Basis): ReadyList {
  const first: ReadyList = {
    status: "ready",
    revisions: fresh.revisions,
    next: fresh.nextCursor,
    basis,
  };
  const last = fresh.revisions.at(-1);
  if (current.status !== "ready" || fresh.nextCursor === null || last === undefined) return first;
  if (!current.revisions.some((r) => r.version === last.version)) return first;
  const older = current.revisions.filter((r) => r.version < last.version);
  if (older.length === 0) return first;
  return { ...first, revisions: [...fresh.revisions, ...older], next: current.next };
}

interface Options {
  pageId: string;
  pageVersion: number;
  updatedAt: number;
  /** ページが消えた後などは取りに行かない */
  paused: boolean;
  /**
   * 一覧が見えている間。false の間は取り直さず、true に戻ったとき、取った後に版が進んでいれば取り直して
   * 追いつく。
   */
  visible: boolean;
}

/**
 * ページの版の一覧。取り直しは、ページの版か更新の時刻が進み、かつ見えているときに限る。
 * 取り直す間も前の一覧を出したままにする。スケルトンに戻すと右の列が保存ごとに揺れる。
 */
export function useRevisionList({ pageId, pageVersion, updatedAt, paused, visible }: Options) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const latest = useRef({ pageVersion, updatedAt, paused, list });
  latest.current = { pageVersion, updatedAt, paused, list };
  /** 1 ページ目のリクエストの通し番号。後から始めたリクエストだけが結果を反映し、先に始めた遅いリクエストは捨てる */
  const ticketRef = useRef(0);
  /** 最後に始めた 1 ページ目のリクエストの基準。失敗したら null に戻し、次の機会に取り直せるようにする */
  const requested = useRef<Basis | null>(null);
  /** 続きのリクエストの途中か。取り直しでは解除せず、このリクエストが戻るまで次を受け付けない */
  const loadingMoreRef = useRef(false);

  const refresh = useCallback(
    async (basis: Basis) => {
      const ticket = ++ticketRef.current;
      requested.current = basis;
      const res = await listRevisions(pageId, null);
      if (ticket !== ticketRef.current) return;
      if (res.ok && !latest.current.paused) {
        setList((current) => mergeFresh(current, res.value, basis));
        return;
      }
      requested.current = null;
      // 取り直しの失敗は前の一覧を残す。paused の間に届いた成功の結果は反映しない
      if (!res.ok)
        setList((current) => (current.status === "ready" ? current : { status: "error" }));
    },
    [pageId],
  );

  useEffect(() => {
    if (paused || !visible) return;
    const done = requested.current;
    if (done !== null && done.pageVersion === pageVersion && done.updatedAt === updatedAt) return;
    void refresh({ pageVersion, updatedAt });
  }, [paused, visible, pageVersion, updatedAt, refresh]);

  /** 版がまとめられて番号が進んだことが分かったとき、今の基準で取り直す */
  const refetch = useCallback(() => {
    const { pageVersion, updatedAt } = latest.current;
    return refresh({ pageVersion, updatedAt });
  }, [refresh]);

  const loadMore = useCallback(async () => {
    const current = latest.current.list;
    if (loadingMoreRef.current || current.status !== "ready" || current.next === null) return;
    const { revisions, next } = current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await listRevisions(pageId, next);
      if (!res.ok) return;
      setList((now) =>
        // 待つ間に取り直した一覧は、読んであった続きを mergeFresh で引き継いでいる
        now.status !== "ready" || now.revisions !== revisions
          ? now
          : {
              ...now,
              revisions: [...revisions, ...res.value.revisions],
              next: res.value.nextCursor,
            },
      );
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [pageId]);

  return { list, loadingMore, loadMore, refetch };
}
