import type { AttachmentUrlResolver } from "@personal-wiki/editor";
import { Backlinks } from "./Backlinks";
import { type EditorState, isReadOnly, type RestoreOutcome } from "./editor-session";
import { formatTime } from "./format";
import type { OutlineItem } from "./heading-outline";
import { Outline } from "./Outline";
import { RailSection } from "./Rail";
import { RevisionHistory } from "./RevisionHistory";

/**
 * 保存中も押せる。本文の編集中に押すと mousedown の blur が保存を始めるので、保存中を
 * disabled にすると mouseup の時点で押せなくなり、クリックが届かない
 */
const canDelete = (state: EditorState, pendingDelete: boolean) =>
  (state.busy === null || state.busy === "saving") &&
  !pendingDelete &&
  !state.gone &&
  !state.authLost &&
  state.conflict === null &&
  state.pendingBackup === null;

interface EditorRailProps {
  state: EditorState;
  outline: OutlineItem[];
  /** 削除の確認を承認してから、session が削除を終えるまで */
  pendingDelete: boolean;
  resolveAttachmentUrl: AttachmentUrlResolver;
  onJump: (offset: number) => void;
  onRestoreRevision: (revision: number) => Promise<RestoreOutcome>;
  onDelete: () => void;
}

/** 編集の画面の右の列（見出しの一覧、バックリンク、日時、版の履歴、削除）。 */
export function EditorRail({
  state,
  outline,
  pendingDelete,
  resolveAttachmentUrl,
  onJump,
  onRestoreRevision,
  onDelete,
}: EditorRailProps) {
  const { uncreated, base } = state;
  const deleting = state.busy === "deleting" || pendingDelete;
  return (
    <>
      <Outline items={outline} onJump={onJump} />
      {!uncreated && <Backlinks target={{ pageId: base.id }} />}
      {!uncreated && (
        <RailSection title="情報">
          <dl className="facts">
            <dt>更新</dt>
            <dd>{formatTime(base.updatedAt)}</dd>
            <dt>作成</dt>
            <dd>{formatTime(base.createdAt)}</dd>
          </dl>
        </RailSection>
      )}
      {!uncreated && (
        <RevisionHistory
          pageId={base.id}
          pageVersion={base.version}
          updatedAt={base.updatedAt}
          paused={state.gone}
          resolveAttachmentUrl={resolveAttachmentUrl}
          canRestore={!isReadOnly(state) && !state.authLost && !deleting}
          onRestore={onRestoreRevision}
        />
      )}
      {/* 作る前のページには消す対象が無い。押せない操作を置かない */}
      {!uncreated && (
        <div>
          <button
            type="button"
            className="button button-quiet button-danger"
            disabled={!canDelete(state, pendingDelete)}
            onClick={onDelete}
          >
            {deleting ? "削除中…" : "このページを削除"}
          </button>
          <span className="visually-hidden" role="status">
            {deleting ? "削除中…" : ""}
          </span>
        </div>
      )}
    </>
  );
}
