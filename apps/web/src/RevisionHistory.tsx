import type { AttachmentUrlResolver } from "@personal-wiki/editor";
import { useEffect, useId, useRef, useState } from "react";
import { BodyEditor } from "./BodyEditor";
import type { RestoreOutcome } from "./editor-session";
import { formatRelativeTime, formatTime } from "./format";
import { useSkeletonPainted } from "./Loading";
import {
  failureMessage,
  getRevision,
  LOAD_FAILED,
  listRevisions,
  type Revision,
  type RevisionAuthor,
  type RevisionList,
  type RevisionSummary,
} from "./pages-api";
import { RailSection } from "./Rail";
import { useNow } from "./use-now";

/**
 * token と接続の名前には種類を前に付ける。接続の名前は接続の側が登録時に名乗ったもので、「オーナー」と
 * 名乗られても owner と同じ表示にしない。接続の登録が消えると（使われないまま期限が切れた、OAuth を閉じた）
 * 名前を引けない。
 */
export function authorLabel(author: RevisionAuthor): string {
  switch (author.kind) {
    case "owner":
      return "オーナー";
    case "token":
      return `token: ${author.name}`;
    case "oauth":
      return author.name === null ? "登録が消えた接続" : `接続: ${author.name}`;
    case "other":
      return author.actor;
  }
}

/** 一覧を取ったときのページの版と更新の時刻。先頭の版の時刻は、一覧と同じ時点の値と比べて決める */
interface Basis {
  pageVersion: number;
  updatedAt: number;
}

type ReadyList = {
  status: "ready";
  revisions: RevisionSummary[];
  next: string | null;
  loadingMore: boolean;
  basis: Basis;
};

type ListState = { status: "loading" } | { status: "error" } | ReadyList;

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
    loadingMore: false,
    basis,
  };
  const last = fresh.revisions.at(-1);
  if (current.status !== "ready" || fresh.nextCursor === null || last === undefined) return first;
  if (!current.revisions.some((r) => r.version === last.version)) return first;
  const older = current.revisions.filter((r) => r.version < last.version);
  if (older.length === 0) return first;
  return { ...first, revisions: [...fresh.revisions, ...older], next: current.next };
}

type Viewing = { summary: RevisionSummary; time: number } & (
  | { status: "loading" }
  | { status: "ready"; revision: Revision }
  /** ページはあるが、その版が後の保存にまとめられて無くなった */
  | { status: "missing" }
  /** ページが削除された */
  | { status: "gone" }
  | { status: "error"; message: string }
);

/** 読み込み中の 2 行の帯。リンク元の節（Backlinks）と同じ形にそろえる */
function PendingRevisions() {
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

interface RevisionHistoryProps {
  pageId: string;
  /** 今のページの版。保存のたびに進むので、変わったら一覧を取り直す */
  pageVersion: number;
  /** 今のページの最後の更新の時刻 */
  updatedAt: number;
  /** ページが消えた後などは取りに行かない */
  paused: boolean;
  resolveAttachmentUrl?: AttachmentUrlResolver;
  /** 渡すと、先頭より古い版に「この版の本文に戻す」を出す */
  onRestore?: (version: number) => Promise<RestoreOutcome>;
  /** 戻す操作を受け付けられるか。衝突の確認中やログインの期限切れの間などは false */
  canRestore?: boolean;
}

/** 戻した結果の文。版やページが消えたときは、本文の欄の文（missing、gone）が理由を伝える */
function restoreNote(outcome: RestoreOutcome): string {
  if (outcome.ok) {
    return outcome.changed
      ? "この版の本文に戻しました。戻す前の本文は履歴に残っているので、そこから戻し直せます。"
      : "今の本文はこの版と同じです。";
  }
  switch (outcome.reason) {
    case "unsaved":
      return "未保存の変更を保存できなかったため、戻していません。";
    case "conflict":
      return "別の場所で更新されていたため、戻していません。最新の内容を読み込んだので、もう一度試してください。";
    case "unauthorized":
      return "ログインの期限が切れたため、戻せませんでした。";
    case "revision_not_found":
    case "gone":
      return "戻せませんでした。";
    case "error":
      return `戻せませんでした。${outcome.message}`;
  }
}

/** 開いている版を戻した結果。別の版を開くか閉じると消す */
type Restoring = { version: number } & (
  | { status: "pending" }
  | { status: "done"; restored: boolean; note: string }
);

/**
 * 右の列の「履歴」。版の番号は飛ぶので見せず、時刻と作成者で並べる。
 * 版の時刻は編集を始めた時刻で、先頭の版だけは、最後に積んだのがその版なら（間に公開範囲の切り替えが
 * 無ければ）ページの更新の時刻を出す。まとめて保存している最中の版を、最初の保存の時刻で古く見せない。
 */
export function RevisionHistory({
  pageId,
  pageVersion,
  updatedAt,
  paused,
  resolveAttachmentUrl,
  onRestore,
  canRestore = true,
}: RevisionHistoryProps) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const [restoring, setRestoring] = useState<Restoring | null>(null);
  const now = useNow();
  const listRef = useRef<HTMLOListElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const latest = useRef<Basis>({ pageVersion, updatedAt });
  latest.current = { pageVersion, updatedAt };

  // 保存のたびに取り直すが、取り直す間も前の一覧を出したままにする。帯に戻すと右の列が保存ごとに揺れる
  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    const basis = { pageVersion, updatedAt };
    void listRevisions(pageId, null).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setList((current) => mergeFresh(current, res.value, basis));
      } else {
        setList((current) => (current.status === "ready" ? current : { status: "error" }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pageId, pageVersion, updatedAt, paused]);

  async function loadMore() {
    if (list.status !== "ready" || list.next === null) return;
    const { revisions, next } = list;
    setList((current) =>
      current.status === "ready" ? { ...current, loadingMore: true } : current,
    );
    const res = await listRevisions(pageId, next);
    setList((current) => {
      // 待つ間に取り直した一覧は、読んであった続きを mergeFresh で引き継いでいる
      if (current.status !== "ready" || current.revisions !== revisions) return current;
      return res.ok
        ? {
            ...current,
            revisions: [...revisions, ...res.value.revisions],
            next: res.value.nextCursor,
            loadingMore: false,
          }
        : { ...current, loadingMore: false };
    });
  }

  const timeOf = (summary: RevisionSummary, index: number, basis: Basis) =>
    index === 0 && summary.version === basis.pageVersion ? basis.updatedAt : summary.createdAt;

  async function refetchAfterMerge() {
    const basis = latest.current;
    const fresh = await listRevisions(pageId, null);
    if (fresh.ok) setList((current) => mergeFresh(current, fresh.value, basis));
  }

  async function open(summary: RevisionSummary, time: number, opener: HTMLElement) {
    openerRef.current = opener;
    setRestoring(null);
    setViewing({ status: "loading", summary, time });
    const res = await getRevision(pageId, summary.version);
    setViewing((current) => {
      // 待つ間に閉じたか、別の版を開いた
      if (current?.summary.version !== summary.version) return current;
      if (res.ok) return { status: "ready", summary, time, revision: res.value };
      if (res.reason === "revision_not_found") return { status: "missing", summary, time };
      if (res.reason === "not_found") return { status: "gone", summary, time };
      return { status: "error", summary, time, message: failureMessage(res, LOAD_FAILED) };
    });
    // 後の保存にまとめられて番号が進んだ版は、一覧も古い
    if (!res.ok && res.reason === "revision_not_found") await refetchAfterMerge();
  }

  // 戻せた後の一覧は、ページの版が進むので取り直しの effect が新しくする
  async function restore(version: number) {
    if (onRestore === undefined) return;
    setRestoring({ version, status: "pending" });
    const outcome = await onRestore(version);
    setRestoring((current) =>
      current?.version === version
        ? { version, status: "done", restored: outcome.ok, note: restoreNote(outcome) }
        : current,
    );
    if (outcome.ok) return;
    if (outcome.reason === "revision_not_found" || outcome.reason === "gone") {
      const status = outcome.reason === "gone" ? "gone" : "missing";
      setViewing((current) =>
        current?.summary.version === version ? { ...current, status } : current,
      );
    }
    if (outcome.reason === "revision_not_found") await refetchAfterMerge();
  }

  // 開いた行が取り直しで消えていたら（版がまとめられた）、焦点を一覧の先頭に戻す。戻さないと body に落ちる
  function restoreFocus() {
    const opener = openerRef.current;
    openerRef.current = null;
    const target = opener?.isConnected
      ? opener
      : listRef.current?.querySelector<HTMLElement>(".revision-entry");
    target?.focus();
  }

  return (
    <RailSection title="履歴" className="rail-section-history">
      {list.status === "loading" && <PendingRevisions />}
      {list.status === "error" && <p className="muted">取得できませんでした。</p>}
      {list.status === "ready" && list.revisions.length === 0 && (
        <p className="muted">まだありません。</p>
      )}
      {list.status === "ready" && list.revisions.length > 0 && (
        <ol className="revision-list" ref={listRef}>
          {list.revisions.map((summary, index) => {
            const time = timeOf(summary, index, list.basis);
            return (
              <li key={summary.version}>
                <button
                  type="button"
                  className="revision-entry"
                  aria-haspopup="dialog"
                  onClick={(event) => void open(summary, time, event.currentTarget)}
                >
                  <time
                    className="revision-time"
                    dateTime={new Date(time).toISOString()}
                    title={formatTime(time)}
                  >
                    {formatRelativeTime(time, now)}
                  </time>
                  <span className="revision-author">{authorLabel(summary.author)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {list.status === "ready" && list.next !== null && (
        <button type="button" className="button" onClick={loadMore} disabled={list.loadingMore}>
          さらに表示
        </button>
      )}
      <RevisionViewer
        viewing={viewing}
        onClose={() => {
          setViewing(null);
          setRestoring(null);
        }}
        onClosed={restoreFocus}
        resolveAttachmentUrl={resolveAttachmentUrl}
        restore={
          onRestore === undefined ||
          viewing === null ||
          list.status !== "ready" ||
          // 先頭の版は今の本文そのもので、戻す先にならない
          list.revisions[0]?.version === viewing.summary.version
            ? null
            : {
                state: restoring?.version === viewing.summary.version ? restoring : null,
                enabled: canRestore,
                run: () => void restore(viewing.summary.version),
              }
        }
      />
    </RailSection>
  );
}

function RevisionViewer({
  viewing,
  onClose,
  onClosed,
  resolveAttachmentUrl,
  restore,
}: {
  viewing: Viewing | null;
  onClose: () => void;
  /** ダイアログが閉じた後。焦点を戻すのに使う */
  onClosed: () => void;
  resolveAttachmentUrl: AttachmentUrlResolver | undefined;
  /** 戻せない版（先頭など）では null */
  restore: { state: Restoring | null; enabled: boolean; run: () => void } | null;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const open = viewing !== null;
  const showRestore =
    restore !== null &&
    viewing?.status === "ready" &&
    !(restore.state?.status === "done" && restore.state.restored);
  const restoreStatus = restore?.state?.status;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  // 押したボタンが待つ間に押せなくなるか、戻せて消えると、焦点がダイアログの外に落ちる。中に戻す
  // biome-ignore lint/correctness/useExhaustiveDependencies: 戻す操作の進みが変わったときに確かめる
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || !dialog.open || dialog.contains(document.activeElement)) return;
    const target = restoreRef.current?.disabled === false ? restoreRef.current : closeRef.current;
    target?.focus();
  }, [restoreStatus, showRestore]);

  return (
    <dialog
      ref={dialogRef}
      className="dialog-frame revision-viewer"
      aria-labelledby={titleId}
      onClose={() => {
        onClose();
        onClosed();
      }}
      onMouseDown={(event) => {
        // 枠の外（backdrop）を押したときだけ閉じる
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {viewing !== null && (
        <>
          <header className="revision-viewer-header">
            <div className="revision-viewer-heading">
              <p className="revision-viewer-meta">
                <span>{formatTime(viewing.time)} の版</span>
                <span>{authorLabel(viewing.summary.author)}</span>
                <span>読み取り専用</span>
              </p>
              <h2 id={titleId} className="revision-viewer-title">
                {viewing.summary.title}
              </h2>
            </div>
            <div className="revision-viewer-actions">
              {showRestore && (
                <button
                  ref={restoreRef}
                  type="button"
                  className="button button-compact"
                  onClick={restore.run}
                  disabled={!restore.enabled || restore.state?.status === "pending"}
                >
                  {restore.state?.status === "pending" ? "戻し中…" : "この版の本文に戻す"}
                </button>
              )}
              <button
                ref={closeRef}
                type="button"
                className="button button-compact"
                onClick={onClose}
              >
                閉じる
              </button>
            </div>
          </header>
          {/* 結果の文を読み上げるよう、空の間も live region を置いておく */}
          <p className="revision-viewer-status" role="status">
            {restore?.state?.status === "done" ? restore.state.note : ""}
          </p>
          <div className="revision-viewer-body">
            {viewing.status === "loading" && <PendingBody />}
            {viewing.status === "missing" && (
              <p className="muted" role="status">
                この版は後の保存にまとめられたため、表示できません。履歴を読み込み直しました。
              </p>
            )}
            {viewing.status === "gone" && (
              <p className="muted" role="status">
                このページは削除されたため、版を表示できません。
              </p>
            )}
            {viewing.status === "error" && (
              <p className="muted" role="status">
                取得できませんでした。{viewing.message}
              </p>
            )}
            {viewing.status === "ready" && (
              <div className="revision-viewer-prose">
                <BodyEditor
                  key={viewing.revision.version}
                  value={viewing.revision.body}
                  readOnly
                  scrollAnchor={false}
                  {...(resolveAttachmentUrl === undefined ? {} : { resolveAttachmentUrl })}
                />
              </div>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}

function PendingBody() {
  const painted = useSkeletonPainted();
  return (
    <>
      <span className="visually-hidden" role="status">
        読み込み中…
      </span>
      <div
        className={painted ? "skeleton-body skeleton-painted" : "skeleton-body"}
        aria-busy="true"
      >
        {[0, 1, 2].map((i) => (
          <span className="skeleton skeleton-text" key={i} aria-hidden="true" />
        ))}
      </div>
    </>
  );
}
