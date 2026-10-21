import type { AttachmentUrlResolver } from "@personal-wiki/editor";
import { Backlinks } from "./Backlinks";
import type { EditorState, RestoreOutcome } from "./editor-session";
import { formatTime } from "./format";
import type { OutlineItem } from "./heading-outline";
import { Outline } from "./Outline";
import { canDelete } from "./page-editor-state";
import { RailSection } from "./Rail";
import { RevisionHistory } from "./RevisionHistory";

interface EditorRailProps {
  uncreated: EditorState["uncreated"];
  base: EditorState["base"];
  busy: EditorState["busy"];
  /** 別の場所で削除された。版の履歴の取得を止める */
  gone: boolean;
  authLost: boolean;
  /** 手元の内容を動かしてはいけない状態（`isReadOnly`）。復元と削除を止める */
  readOnly: boolean;
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
  uncreated,
  base,
  busy,
  gone,
  authLost,
  readOnly,
  outline,
  pendingDelete,
  resolveAttachmentUrl,
  onJump,
  onRestoreRevision,
  onDelete,
}: EditorRailProps) {
  const deleting = busy === "deleting" || pendingDelete;
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
          paused={gone}
          resolveAttachmentUrl={resolveAttachmentUrl}
          canRestore={!readOnly && !authLost && !deleting}
          onRestore={onRestoreRevision}
        />
      )}
      {/* 作る前のページには消す対象が無い。押せない操作を置かない */}
      {!uncreated && (
        <div>
          <button
            type="button"
            className="button button-quiet button-danger"
            disabled={!canDelete({ busy, authLost, readOnly, pendingDelete })}
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
