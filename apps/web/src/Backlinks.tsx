import { useEffect, useState } from "react";
import { Link } from "./Link";
import { listBacklinks, type PageSummary } from "./pages-api";
import { pageHref } from "./route";

type State =
  | { status: "loading" }
  | { status: "ready"; pages: PageSummary[]; next: string | null; loadingMore: boolean }
  | { status: "error" };

export function Backlinks({ pageId }: { pageId: string }) {
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

  return (
    <section className="backlinks" aria-labelledby="backlinks-title">
      <h2 id="backlinks-title" className="section-subtitle">
        このページへのリンク
      </h2>
      {state.status === "loading" && <p className="muted">読み込み中…</p>}
      {state.status === "error" && <p className="muted">取得できませんでした。</p>}
      {state.status === "ready" && state.pages.length === 0 && (
        <p className="muted">このページへのリンクはありません。</p>
      )}
      {state.status === "ready" && state.pages.length > 0 && (
        <ul className="backlink-list">
          {state.pages.map((page) => (
            <li key={page.id}>
              <Link href={pageHref(page.id)}>{page.title}</Link>
            </li>
          ))}
        </ul>
      )}
      {state.status === "ready" && state.next !== null && (
        <button type="button" className="button" onClick={loadMore} disabled={state.loadingMore}>
          さらに表示
        </button>
      )}
    </section>
  );
}
