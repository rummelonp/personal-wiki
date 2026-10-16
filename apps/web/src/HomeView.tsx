import { useState } from "react";
import { EmptyState } from "./EmptyState";
import { EntryList } from "./EntryRow";
import { Link } from "./Link";
import { LoadingMoreRows, LoadingStatus, SkeletonEntries, useSkeletonPainted } from "./Loading";
import { listHeading, listTitleClass } from "./list-heading";
import { Notice } from "./Notice";
import { openNewPage } from "./new-page";
import { RailLayout } from "./Rail";
import { homeHref, tagHref } from "./route";
import { SearchBox } from "./SearchBox";
import { SignInNotice } from "./SignInNotice";
import { useRestoreScroll } from "./scroll-restore";
import { TagsPanel, useTags } from "./TagsPanel";
import { type PreviousList, useEntryList } from "./useEntryList";

interface HomeViewProps {
  query: string;
  tag: string;
  owner: boolean;
}

/**
 * 条件を変えて取り直している間の、前の一覧。縮めずに残し、取得が遅いときだけ薄くする。
 * 前の条件の結果なので、新しい検索語での強調はしない。
 */
function PreviousEntries({
  previous,
  now,
  showVisibility,
}: {
  previous: PreviousList;
  now: number;
  showVisibility: boolean;
}) {
  const painted = useSkeletonPainted();
  return (
    <EntryList
      entries={previous.entries}
      now={now}
      showVisibility={showVisibility}
      className={painted ? "entries-stale skeleton-painted" : "entries-stale"}
    />
  );
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
  const { state, loadMore, reload } = useEntryList({ query: trimmed, tag: effectiveTag, owner });
  const { tags, settled: tagsSettled } = useTags();
  // 狭い画面ではタグが一覧の下に続き、描かれる前は戻す位置に届かないので、タグが済むまで待つ
  useRestoreScroll(
    state.status === "ready",
    state.status === "ready" ? state.entries.length : 0,
    tagsSettled,
  );
  // 一覧を描く時刻。再描画のたびに変えず、表示中は固定する
  const [now] = useState(() => Date.now());

  if (state.status === "unauthorized") return <SignInNotice expired />;

  const backToRecent = (
    <Link className="button" href={homeHref()}>
      最近の更新へ戻る
    </Link>
  );

  const heading = listHeading(trimmed, tag);
  const busy = state.status === "loading" || (state.status === "ready" && state.loadingMore);

  return (
    <RailLayout rail={tags === null ? null : <TagsPanel tags={tags} active={effectiveTag} />}>
      {busy && (
        <LoadingStatus
          text={state.status === "ready" ? "続きを読み込み中…" : "一覧を読み込み中…"}
        />
      )}
      <div className="home" aria-busy={busy || undefined}>
        {/* 検索の入口はヘッダーと quick switcher。結果の画面でだけ、検索語を直す欄を置く */}
        {searching && <SearchBox query={trimmed} />}
        <h1 className={listTitleClass(heading)}>{heading}</h1>
        {searching && tag !== "" && (
          <p className="muted">
            検索はタグで絞り込めないので、全ページから探しています。{" "}
            <Link href={tagHref(tag)}>タグ「{tag}」のページを見る</Link>
          </p>
        )}
        {state.status === "loading" && state.previous === undefined && <SkeletonEntries />}
        {state.status === "loading" && state.previous !== undefined && (
          <PreviousEntries previous={state.previous} now={now} showVisibility={owner} />
        )}
        {state.status === "query_too_short" && (
          <EmptyState
            role="status"
            title={`${state.min}\u00a0文字以上で検索してください`}
            actions={backToRecent}
          />
        )}
        {state.status === "invalid_query" && (
          <EmptyState
            role="status"
            title="この検索語では検索できません"
            text={state.message}
            actions={backToRecent}
          />
        )}
        {state.status === "error" && (
          <Notice
            inline
            tone="error"
            title="一覧を取得できませんでした"
            actions={
              <button type="button" className="button button-main" onClick={reload}>
                再読み込み
              </button>
            }
          >
            <p>{state.message}</p>
          </Notice>
        )}
        {state.status === "ready" && state.entries.length === 0 && searching && (
          <EmptyState
            title="一致するページがありません"
            actions={
              <>
                {/* 検索語の title で作る入口。匿名は作れないので出さない */}
                {owner && (
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() => openNewPage({ title: trimmed })}
                  >
                    {`「${trimmed}」を作成`}
                  </button>
                )}
                {backToRecent}
              </>
            }
          />
        )}
        {state.status === "ready" && state.entries.length === 0 && !searching && tag !== "" && (
          <EmptyState title="このタグのページがありません" actions={backToRecent} />
        )}
        {state.status === "ready" && state.entries.length === 0 && !searching && tag === "" && (
          <EmptyState
            title={owner ? "ページがまだありません" : "公開されているページはまだありません"}
            text={owner ? "ヘッダーの「新規作成」から、最初のページを作れます。" : undefined}
          />
        )}
        {state.status === "ready" && state.entries.length > 0 && (
          <>
            <EntryList
              entries={state.entries}
              now={now}
              highlight={searching ? trimmed : ""}
              showVisibility={owner}
            >
              {state.loadingMore && <LoadingMoreRows />}
            </EntryList>
            {state.next !== null && (
              // 文字を変えるとボタンの幅が動くので、読み込み中も同じ文字にして、状態は disabled と一覧の末尾の帯で伝える
              <button
                type="button"
                className="button"
                onClick={loadMore}
                disabled={state.loadingMore}
              >
                さらに表示
              </button>
            )}
          </>
        )}
      </div>
    </RailLayout>
  );
}
