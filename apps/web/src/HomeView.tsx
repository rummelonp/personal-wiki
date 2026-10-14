import { useState } from "react";
import { type CreateProblem, CreateProblemMessage, createPageAndOpen } from "./create-page";
import { EntryList } from "./EntryRow";
import { Link } from "./Link";
import { RailLayout } from "./Rail";
import { homeHref, tagHref } from "./route";
import { SearchBox } from "./SearchBox";
import { SignInNotice } from "./SignInNotice";
import { TagsPanel, useTags } from "./TagsPanel";
import { useEntryList } from "./useEntryList";

interface HomeViewProps {
  query: string;
  tag: string;
  owner: boolean;
}

/**
 * トップの配置。中央に検索欄と抜粋付きの一覧、右にタグの一覧を置く。
 * データは useEntryList、行は EntryRow が受け持つので、配置を変えるときはこのファイルだけを直す。
 */
export function HomeView({ query, tag, owner }: HomeViewProps) {
  const trimmed = query.trim();
  const searching = trimmed !== "";
  // 検索 API に tag の絞り込みは無いので、検索中は tag を一覧の取得にも強調にも使わない
  const effectiveTag = searching ? "" : tag;
  const { state, loadMore } = useEntryList({ query: trimmed, tag: effectiveTag, owner });
  const tags = useTags();
  // 一覧を描く時刻。再描画のたびに変えず、表示中は固定する
  const [now] = useState(() => Date.now());
  const [creating, setCreating] = useState(false);
  // 失敗はその語に紐づける。検索語を変えたあとに前の語の失敗を出さない
  const [failure, setFailure] = useState<{ title: string; problem: CreateProblem } | null>(null);
  const problem = failure !== null && failure.title === trimmed ? failure.problem : null;

  async function create() {
    if (creating) return;
    setCreating(true);
    setFailure(null);
    const title = trimmed;
    const failed = await createPageAndOpen(title);
    setCreating(false);
    if (failed !== null) setFailure({ title, problem: failed });
  }

  if (state.status === "unauthorized") return <SignInNotice expired />;

  const heading = searching
    ? `「${trimmed}」の検索結果`
    : tag !== ""
      ? `タグ「${tag}」`
      : "最近の更新";

  return (
    <RailLayout rail={tags === null ? null : <TagsPanel tags={tags} active={effectiveTag} />}>
      <div className="home">
        {/* 検索の入口はヘッダーと quick switcher。結果の画面でだけ、検索語を直す欄を置く */}
        {searching && <SearchBox query={trimmed} />}
        <h1 className="list-title">{heading}</h1>
        {searching && tag !== "" && (
          <p className="muted">
            検索ではタグ「{tag}」で絞り込めないので、全ページから探しています。{" "}
            <Link href={tagHref(tag)}>タグだけで見る</Link>
            {" / "}
            <Link href={homeHref(trimmed)}>タグを外す</Link>
          </p>
        )}
        {state.status === "loading" && <p className="muted">読み込み中…</p>}
        {state.status === "query_too_short" && (
          <p className="muted" role="status">{`${state.min} 文字以上で検索してください`}</p>
        )}
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
        {/* 検索語の title で作る入口。匿名は作れないので出さない */}
        {state.status === "ready" && state.entries.length === 0 && searching && owner && (
          <>
            <div>
              <button
                type="button"
                className="button button-primary"
                onClick={() => void create()}
                disabled={creating}
              >
                {`「${trimmed}」を作成`}
              </button>
            </div>
            {problem !== null && <CreateProblemMessage problem={problem} />}
          </>
        )}
        {state.status === "ready" && state.entries.length > 0 && (
          <>
            <EntryList entries={state.entries} now={now} highlight={searching ? trimmed : ""} />
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
