import { useEffect, useRef, useState } from "react";
import { Link } from "./Link";
import { useSkeletonPainted } from "./Loading";
import { rememberTitle } from "./page-titles";
import { listBacklinks, listBacklinksByTitle, type PageSummary } from "./pages-api";
import { RailSection } from "./Rail";
import { pageHrefFor } from "./route";

type State =
  | { status: "loading" }
  | { status: "ready"; pages: PageSummary[]; next: string | null; loadingMore: boolean }
  | { status: "error" };

/**
 * 取得中の 2 行の帯。リンクの行と同じ高さで場所を取り、取得が遅いときだけ描く。
 * 「読み込み中…」は節を読んだときにだけ伝わればよいので、live region にしない（補助欄の読み込みの
 * 知らせが本文の読み上げに割り込む）。
 */
function PendingLinks() {
  const painted = useSkeletonPainted();
  return (
    <>
      <span className="visually-hidden">読み込み中…</span>
      <div
        className={painted ? "skeleton-links skeleton-painted" : "skeleton-links"}
        aria-busy="true"
      >
        <span className="skeleton skeleton-text" aria-hidden="true" />
        <span className="skeleton skeleton-text skeleton-rail-short" aria-hidden="true" />
      </div>
    </>
  );
}

/**
 * リンク先。ページがあれば id で引く（改題の後も付け替わったリンクを追う）。まだ無いページは
 * リンクに書かれた title で引く。
 */
export type BacklinksTarget = { pageId: string } | { title: string };

interface BacklinksProps {
  target: BacklinksTarget;
  /**
   * 読み込み中とリンク元が 0 件のあいだ節ごと出さない。リンク元が無いことは読者にとって
   * 情報にならない。1 件以上あれば読み込みの後に節が現れ、取得に失敗したときは節を出して失敗を伝える。
   * owner には「まだありません」を出し、リンクを張る手がかりにする。
   */
  hideEmpty?: boolean;
  /** target ごとの最初の取得が済み（失敗も含む）、その結果を描いた後に呼ぶ。画面の高さが決まったことを伝える */
  onSettled?: () => void;
}

const load = (target: BacklinksTarget, cursor: string | null) =>
  "pageId" in target
    ? listBacklinks(target.pageId, cursor)
    : listBacklinksByTitle(target.title, cursor);

export function Backlinks({ target, hideEmpty = false, onSettled }: BacklinksProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  const targetKey = "pageId" in target ? `id:${target.pageId}` : `title:${target.title}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: target の中身は targetKey が表す
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void load(target, null).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setState({
          status: "ready",
          pages: res.value.pages,
          next: res.value.nextCursor,
          loadingMore: false,
        });
      } else {
        setState({ status: "error" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [targetKey]);

  const settledCallback = useRef(onSettled);
  useEffect(() => {
    settledCallback.current = onSettled;
  });
  const settled = state.status !== "loading";
  useEffect(() => {
    if (settled) settledCallback.current?.();
  }, [settled]);

  async function loadMore() {
    if (state.status !== "ready" || state.next === null) return;
    const { pages, next } = state;
    setState({ ...state, loadingMore: true });
    const res = await load(target, next);
    setState(
      res.ok
        ? {
            status: "ready",
            pages: [...pages, ...res.value.pages],
            next: res.value.nextCursor,
            loadingMore: false,
          }
        : { status: "ready", pages, next, loadingMore: false },
    );
  }

  // 読み込みの完了前に節を出して消すと、右の欄が一瞬ずれる
  if (
    hideEmpty &&
    (state.status === "loading" || (state.status === "ready" && state.pages.length === 0))
  ) {
    return null;
  }

  return (
    <RailSection title="このページへのリンク" className="rail-section-links">
      {state.status === "loading" && <PendingLinks />}
      {state.status === "error" && <p className="muted">取得できませんでした。</p>}
      {state.status === "ready" && state.pages.length === 0 && (
        <p className="muted">まだありません。</p>
      )}
      {state.status === "ready" && state.pages.length > 0 && (
        <ul className="rail-list">
          {state.pages.map((page) => (
            <li key={page.id}>
              <Link href={pageHrefFor(page)} onClick={() => rememberTitle(page.id, page.title)}>
                {page.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {state.status === "ready" && state.next !== null && (
        <button type="button" className="button" onClick={loadMore} disabled={state.loadingMore}>
          さらに表示
        </button>
      )}
    </RailSection>
  );
}
