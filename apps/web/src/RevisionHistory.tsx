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
  type Revision,
  type RevisionAuthor,
  type RevisionSummary,
} from "./pages-api";
import { RailSection } from "./Rail";
import { useIntersecting } from "./use-intersecting";
import { useNow } from "./use-now";
import { type Basis, useRevisionList } from "./use-revision-list";

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

/**
 * 版の時刻とその意味。版の時刻は編集を始めた時刻（最初の保存）で、先頭の版だけは、最後に積んだのが
 * その版なら（間に公開範囲の切り替えが無ければ）ページの更新の時刻、つまり最後の保存の時刻になる。
 */
interface Stamp {
  at: number;
  lastSaved: boolean;
}

/** 何の時刻かを添える。添えないと、版の時刻が保存した時刻と読まれる */
const stampText = ({ at, lastSaved }: Stamp): string =>
  `${lastSaved ? "最後に保存した時刻" : "編集を始めた時刻"} ${formatTime(at)}`;

function stampOf(summary: RevisionSummary, index: number, basis: Basis): Stamp {
  return index === 0 && summary.version === basis.pageVersion
    ? { at: basis.updatedAt, lastSaved: true }
    : { at: summary.createdAt, lastSaved: false };
}

type Viewing = { summary: RevisionSummary; stamp: Stamp } & (
  | { status: "loading" }
  | { status: "ready"; revision: Revision }
  /** ページはあるが、その版が後の保存にまとめられて無くなった */
  | { status: "missing" }
  /** ページが削除された */
  | { status: "gone" }
  | { status: "error"; message: string }
);

/** 読み込み中の 2 行のスケルトン。リンク元の節（Backlinks）と同じ形にそろえる */
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
 * 右の列の「履歴」。版の番号は飛ぶので見せず、時刻と作成者で並べる。先頭の版の時刻（Stamp）は、
 * まとめて保存している最中の版を、最初の保存の時刻で古く見せないために最後の保存の時刻にする。
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
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const [restoring, setRestoring] = useState<Restoring | null>(null);
  const now = useNow();
  const sectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // 版を開いている間は、列が画面の外にあっても一覧を最新にしておく（戻した結果が一覧に出る）
  const visible = useIntersecting(sectionRef) || viewing !== null;
  const { list, loadingMore, loadMore, refetch } = useRevisionList({
    pageId,
    pageVersion,
    updatedAt,
    paused,
    visible,
  });

  async function open(summary: RevisionSummary, stamp: Stamp, opener: HTMLElement) {
    openerRef.current = opener;
    setRestoring(null);
    setViewing({ status: "loading", summary, stamp });
    const res = await getRevision(pageId, summary.version);
    setViewing((current) => {
      // 待つ間に閉じたか、別の版を開いた
      if (current?.summary.version !== summary.version) return current;
      if (res.ok) return { status: "ready", summary, stamp, revision: res.value };
      if (res.reason === "revision_not_found") return { status: "missing", summary, stamp };
      if (res.reason === "not_found") return { status: "gone", summary, stamp };
      return { status: "error", summary, stamp, message: failureMessage(res, LOAD_FAILED) };
    });
    // 後の保存にまとめられて番号が進んだ版は、一覧も古い
    if (!res.ok && res.reason === "revision_not_found") await refetch();
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
    if (outcome.reason === "revision_not_found") await refetch();
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
    <RailSection ref={sectionRef} title="履歴" className="rail-section-history">
      {list.status === "loading" && <PendingRevisions />}
      {list.status === "error" && <p className="muted">取得できませんでした。</p>}
      {list.status === "ready" && list.revisions.length === 0 && (
        <p className="muted">まだありません。</p>
      )}
      {list.status === "ready" && list.revisions.length > 0 && (
        <ol className="revision-list" ref={listRef}>
          {list.revisions.map((summary, index) => {
            const stamp = stampOf(summary, index, list.basis);
            return (
              <li key={summary.version}>
                <button
                  type="button"
                  className="revision-entry"
                  aria-haspopup="dialog"
                  onClick={(event) => void open(summary, stamp, event.currentTarget)}
                >
                  <time
                    className="revision-time"
                    dateTime={new Date(stamp.at).toISOString()}
                    title={stampText(stamp)}
                  >
                    {formatRelativeTime(stamp.at, now)}
                    {/* 相対表記と title だけでは、タッチと読み上げが絶対の時刻に届かない */}
                    <span className="visually-hidden">{`（${stampText(stamp)}）`}</span>
                  </time>
                  <span className="revision-author">{authorLabel(summary.author)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {list.status === "ready" && list.next !== null && (
        <button
          type="button"
          className="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
        >
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
                <span>{stampText(viewing.stamp)}</span>
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
