import { useState } from "react";
import { EntryList } from "./EntryRow";
import { RailLayout } from "./Rail";
import { SearchBox } from "./SearchBox";
import { SignInNotice } from "./SignInNotice";
import { TagsPanel, useTags } from "./TagsPanel";
import { useEntryList } from "./useEntryList";

interface HomeViewProps {
  query: string;
  tag: string;
}

/**
 * トップの配置。中央に検索欄と抜粋付きの一覧、右にタグの一覧を置く。
 * データは useEntryList、行は EntryRow が受け持つので、配置を変えるときはこのファイルだけを直す。
 */
export function HomeView({ query, tag }: HomeViewProps) {
  const trimmed = query.trim();
  const { state, loadMore } = useEntryList({ query: trimmed, tag });
  const tags = useTags();
  // 一覧を描く時刻。再描画のたびに変えず、表示中は固定する
  const [now] = useState(() => Date.now());

  if (state.status === "unauthorized") return <SignInNotice expired />;

  const searching = trimmed !== "";
  const heading = searching
    ? `「${trimmed}」の検索結果`
    : tag !== ""
      ? `タグ「${tag}」`
      : "最近の更新";

  return (
    <RailLayout rail={tags === null ? null : <TagsPanel tags={tags} active={tag} />}>
      <div className="home">
        <SearchBox query={trimmed} />
        <h1 className="list-title">{heading}</h1>
        {state.status === "loading" && <p className="muted">読み込み中…</p>}
        {state.status === "error" && (
          <p className="message message-error" role="alert">
            {state.message}
          </p>
        )}
        {state.status === "ready" && state.entries.length === 0 && (
          <p className="muted">
            {searching ? "一致するページがありません。" : "ページがまだありません。"}
          </p>
        )}
        {state.status === "ready" && state.entries.length > 0 && (
          <>
            <EntryList entries={state.entries} now={now} />
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
      </div>
    </RailLayout>
  );
}
