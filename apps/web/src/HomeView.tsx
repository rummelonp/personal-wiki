import { useEffect } from "react";
import { EmptyState } from "./EmptyState";
import { EntryList } from "./EntryRow";
import { rememberEntryShape } from "./entry-shape";
import { Link } from "./Link";
import { LoadingMoreRows, LoadingStatus, SkeletonEntries, useSkeletonPainted } from "./Loading";
import { listHeading, listTitleClass, VISIBILITY_FILTER_NOUNS } from "./list-heading";
import { Notice } from "./Notice";
import { openNewPage } from "./new-page";
import { RailLayout } from "./Rail";
import { homeHref, tagHref, type VisibilityFilter } from "./route";
import { SignInNotice } from "./SignInNotice";
import { useRestoreScroll } from "./scroll-restore";
import { TagsPanel, useTags } from "./TagsPanel";
import { useNow } from "./use-now";
import { type PreviousList, useEntryList } from "./useEntryList";
import { VisibilityFilterPanel } from "./VisibilityFilterPanel";

interface HomeViewProps {
  query: string;
  tag: string;
  visibility: VisibilityFilter;
  owner: boolean;
}

/** 絞り込んだ一覧が空のときの見出し。 */
function filteredEmptyTitle(tag: string, visibility: VisibilityFilter): string {
  if (visibility === "") return "このタグのページがありません";
  const noun = VISIBILITY_FILTER_NOUNS[visibility];
  return tag !== "" ? `このタグの${noun}がありません` : `${noun}がありません`;
}

/**
 * 条件を変えて取り直している間の、前の一覧。縮めずに残し、取得が遅いときだけ薄くする。
 * 前の条件の結果なので、新しい検索語での強調はしない。
 */
function PreviousEntries({
  previous,
  now,
  showVisibility,
  visibility,
}: {
  previous: PreviousList;
  now: number;
  showVisibility: boolean;
  visibility: VisibilityFilter;
}) {
  const painted = useSkeletonPainted();
  return (
    <EntryList
      entries={previous.entries}
      now={now}
      showVisibility={showVisibility}
      visibility={visibility}
      className={painted ? "entries-stale skeleton-painted" : "entries-stale"}
    />
  );
}

/**
 * トップの配置。中央に抜粋付きの一覧、右にタグの一覧を置く。
 * データは useEntryList、行は EntryRow が受け持つので、配置を変えるときはこのファイルだけを直す。
 */
export function HomeView({ query, tag, visibility, owner }: HomeViewProps) {
  const trimmed = query.trim();
  const searching = trimmed !== "";
  // 検索 API に tag の絞り込みは無いので、検索中は tag を一覧の取得にも強調にも使わない
  const effectiveTag = searching ? "" : tag;
  // 公開範囲も同じく検索中は使わない。匿名には絞り込みの欄が無く、API に draft を渡しても空になるだけなので、
  // URL に残っていても絞り込まない
  const ownerVisibility = owner ? visibility : "";
  const effectiveVisibility = searching ? "" : ownerVisibility;
  const filtered = effectiveTag !== "" || effectiveVisibility !== "";
  const { state, loadMore, reload } = useEntryList({
    query: trimmed,
    tag: effectiveTag,
    visibility: effectiveVisibility,
    owner,
  });
  const { tags, settled: tagsSettled } = useTags(effectiveVisibility);
  // 狭い画面ではタグが一覧の下に続き、描かれる前は戻す位置に届かないので、タグが済むまで待つ
  useRestoreScroll(
    state.status === "ready",
    state.status === "ready" ? state.entries.length : 0,
    tagsSettled,
  );
  const now = useNow();
  const receivedEntries = state.status === "ready" ? state.entries : undefined;
  useEffect(() => {
    if (receivedEntries !== undefined) rememberEntryShape(receivedEntries);
  }, [receivedEntries]);

  if (state.status === "unauthorized") return <SignInNotice expired />;

  const backToRecent = (
    <Link className="button" href={homeHref()}>
      最近の更新へ戻る
    </Link>
  );

  const heading = listHeading(trimmed, tag, ownerVisibility);
  // 検索中は公開範囲で絞れず、欄のリンクを押すと検索語も落ちるので出さない
  const showVisibilityFilter = owner && !searching;
  const busy = state.status === "loading" || (state.status === "ready" && state.loadingMore);

  return (
    <RailLayout
      rail={
        tags === null && !showVisibilityFilter ? null : (
          // 公開範囲の欄を先頭に置く。タグの数で長さが変わる欄より下に置くと、欄の位置が動く
          <>
            {showVisibilityFilter && (
              <VisibilityFilterPanel tag={effectiveTag} active={effectiveVisibility} />
            )}
            {tags !== null && (
              <TagsPanel tags={tags} active={effectiveTag} visibility={effectiveVisibility} />
            )}
          </>
        )
      }
    >
      {busy && (
        <LoadingStatus
          text={state.status === "ready" ? "続きを読み込み中…" : "一覧を読み込み中…"}
        />
      )}
      <div className="home" aria-busy={busy || undefined}>
        <h1 className={listTitleClass(heading)}>{heading}</h1>
        {searching && tag !== "" && (
          <p className="muted">
            検索はタグで絞り込めないので、全ページから探しています。{" "}
            <Link href={tagHref(tag)}>タグ「{tag}」のページを見る</Link>
          </p>
        )}
        {state.status === "loading" && state.previous === undefined && <SkeletonEntries />}
        {state.status === "loading" && state.previous !== undefined && (
          <PreviousEntries
            previous={state.previous}
            now={now}
            showVisibility={owner}
            visibility={effectiveVisibility}
          />
        )}
        {state.status === "query_too_short" && (
          <EmptyState
            role="status"
            title={`${state.min}文字以上で検索してください`}
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
                    className="button button-primary button-wrap button-wrap-quoted"
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
        {state.status === "ready" && state.entries.length === 0 && filtered && (
          <EmptyState
            title={filteredEmptyTitle(effectiveTag, effectiveVisibility)}
            actions={backToRecent}
          />
        )}
        {state.status === "ready" && state.entries.length === 0 && !searching && !filtered && (
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
              visibility={effectiveVisibility}
            >
              {state.loadingMore && <LoadingMoreRows />}
            </EntryList>
            {state.next !== null && (
              // 文字を変えるとボタンの幅が動くので、読み込み中も同じ文字にして、状態は disabled と一覧の末尾のスケルトンで伝える
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
