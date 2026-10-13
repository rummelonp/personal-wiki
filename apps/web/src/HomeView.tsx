import { useCallback, useEffect, useRef, useState } from "react";
import { formatTime } from "./format";
import { Link } from "./Link";
import {
  failureMessage,
  listRecent,
  type PageSummary,
  type SearchHit,
  searchPages,
} from "./pages-api";
import { pageHref } from "./route";
import { SignInNotice } from "./SignInNotice";

type Entry = PageSummary & { excerpt?: string };

type ListState =
  | { status: "loading" }
  | { status: "ready"; entries: Entry[]; next: string | null; loadingMore: boolean }
  | { status: "unauthorized" }
  | { status: "error"; message: string };

function Entries({ entries }: { entries: Entry[] }) {
  return (
    <ul className="entries">
      {entries.map((entry) => (
        <li key={entry.id} className="entry">
          <Link className="entry-title" href={pageHref(entry.id)}>
            {entry.title}
          </Link>
          {entry.visibility === "draft" && <span className="badge">下書き</span>}
          <time className="entry-time muted">{formatTime(entry.updatedAt)}</time>
          {entry.excerpt !== undefined && entry.excerpt !== "" && (
            <p className="entry-excerpt muted">{entry.excerpt}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 最近の更新（query が空）と検索結果（`/?q=`）。 */
export function HomeView({ query }: { query: string }) {
  const trimmed = query.trim();
  const [state, setState] = useState<ListState>({ status: "loading" });
  // 検索語が変わった後に遅れて届いた応答で、表示を上書きしない
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    setState({ status: "loading" });
    const load =
      trimmed === ""
        ? listRecent(null).then((res) =>
            res.ok
              ? { ...res, value: { entries: res.value.pages, next: res.value.nextCursor } }
              : res,
          )
        : searchPages(trimmed).then((res) =>
            res.ok ? { ...res, value: { entries: res.value as SearchHit[], next: null } } : res,
          );
    void load.then((res) => {
      if (generation.current !== mine) return;
      if (res.ok) setState({ status: "ready", ...res.value, loadingMore: false });
      else if (res.reason === "unauthorized") setState({ status: "unauthorized" });
      else setState({ status: "error", message: failureMessage(res, "取得できなかった") });
    });
  }, [trimmed]);

  const loadMore = useCallback(async () => {
    if (state.status !== "ready" || state.next === null || state.loadingMore) return;
    const mine = generation.current;
    const { entries, next } = state;
    setState({ ...state, loadingMore: true });
    const res = await listRecent(next);
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
  }, [state]);

  if (state.status === "unauthorized") return <SignInNotice expired />;

  return (
    <section>
      <h1 className="section-title">
        {trimmed === "" ? "最近の更新" : `「${trimmed}」の検索結果`}
      </h1>
      {state.status === "loading" && <p className="muted">読み込み中…</p>}
      {state.status === "error" && (
        <p className="message message-error" role="alert">
          {state.message}
        </p>
      )}
      {state.status === "ready" && state.entries.length === 0 && (
        <p className="muted">
          {trimmed === "" ? "ページがまだありません。" : "一致するページがありません。"}
        </p>
      )}
      {state.status === "ready" && state.entries.length > 0 && (
        <>
          <Entries entries={state.entries} />
          {state.next !== null && (
            <button
              type="button"
              className="button"
              onClick={loadMore}
              disabled={state.loadingMore}
            >
              {state.loadingMore ? "読み込み中…" : "さらに表示"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
