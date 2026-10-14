import { useEffect, useState } from "react";
import { Link } from "./Link";
import { LoadingStatus, useSkeletonPainted } from "./Loading";
import { rememberTitle } from "./page-titles";
import { listBacklinks, type PageSummary } from "./pages-api";
import { RailSection } from "./Rail";
import { pageHrefFor } from "./route";

type State =
  | { status: "loading" }
  | { status: "ready"; pages: PageSummary[]; next: string | null; loadingMore: boolean }
  | { status: "error" };

/** 取得中の 2 行の帯。リンクの行と同じ高さで場所を取り、取得が遅いときだけ描く。 */
function PendingLinks() {
  const painted = useSkeletonPainted();
  return (
    <div
      className={painted ? "skeleton-links skeleton-painted" : "skeleton-links"}
      aria-busy="true"
    >
      <LoadingStatus />
      <span className="skeleton skeleton-text" aria-hidden="true" />
      <span className="skeleton skeleton-text skeleton-rail-short" aria-hidden="true" />
    </div>
  );
}

/**
 * hideEmpty は、読み込み中とリンク元が 0 件のあいだ節ごと出さない。リンク元が無いことは読者にとって
 * 情報にならない。1 件以上あれば読み込みの後に節が現れ、取得に失敗したときは節を出して失敗を伝える。
 * owner には「ありません」を出し、リンクを張る手がかりにする。
 */
export function Backlinks({ pageId, hideEmpty = false }: { pageId: string; hideEmpty?: boolean }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void listBacklinks(pageId, null).then((res) => {
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
  }, [pageId]);

  async function loadMore() {
    if (state.status !== "ready" || state.next === null) return;
    const { pages, next } = state;
    setState({ ...state, loadingMore: true });
    const res = await listBacklinks(pageId, next);
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
        <p className="muted">ありません。</p>
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
