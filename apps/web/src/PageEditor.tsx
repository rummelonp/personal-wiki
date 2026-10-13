import { useEffect, useState, useSyncExternalStore } from "react";
import { loginHref } from "./api";
import { Backlinks } from "./Backlinks";
import { BodyEditor } from "./BodyEditor";
import { ConflictPanel } from "./ConflictPanel";
import { createLocalBackupStore } from "./draft-backup";
import {
  type EditorApi,
  EditorSession,
  isDirty,
  type SaveStatus,
  saveStatusOf,
} from "./editor-session";
import { formatTime } from "./format";
import { deletePage, getPage, type Page, setVisibility, updatePage } from "./pages-api";
import { homeHref, navigate } from "./route";

const api: EditorApi = {
  getPage: (id) => getPage(id),
  updatePage: (id, version, input, options) => updatePage(id, version, input, options),
  setVisibility: (id, version, visibility) => setVisibility(id, version, visibility),
  deletePage: (id, version) => deletePage(id, version),
};

const STATUS_LABELS: Record<SaveStatus, string> = {
  saved: "保存済み",
  unsaved: "未保存の変更あり",
  saving: "保存中…",
  error: "保存に失敗",
  conflict: "サーバーの内容と食い違っています",
  auth: "ログインが切れました",
  gone: "ページがありません",
};

function useEditorSession(page: Page): EditorSession {
  const [session] = useState(
    () => new EditorSession(page, { api, backup: createLocalBackupStore() }),
  );

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void session.flush({ keepalive: true });
      else void session.checkFreshness();
    };
    const onFocus = () => void session.checkFreshness();
    const onPageHide = () => void session.leave();
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const state = session.getState();
      if (isDirty(state) || state.busy === "saving") event.preventDefault();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      // アプリ内の遷移でも、未保存の変更をここで送る
      void session.leave();
    };
  }, [session]);

  return session;
}

export function PageEditor({ page }: { page: Page }) {
  const session = useEditorSession(page);
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const status = saveStatusOf(state);
  const readOnly = state.conflict !== null || state.gone || state.authLost;
  const idle = state.busy === null;
  const canChangeVisibility = idle && (status === "saved" || status === "unsaved");

  async function handleDelete() {
    if (!window.confirm(`「${state.base.title}」を削除します。元に戻せません。よろしいですか？`))
      return;
    if (await session.remove()) navigate(homeHref());
  }

  return (
    <article className="editor">
      <div className="editor-bar">
        <span className={`status status-${status}`} role="status" aria-live="polite">
          {STATUS_LABELS[status]}
        </span>
        <div className="editor-actions">
          <button
            type="button"
            className="button"
            disabled={!canChangeVisibility}
            onClick={() =>
              void session.changeVisibility(state.base.visibility === "public" ? "draft" : "public")
            }
          >
            {state.base.visibility === "public" ? "公開中（下書きに戻す）" : "下書き（公開する）"}
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={!idle || state.gone || state.authLost}
            onClick={() => void handleDelete()}
          >
            削除
          </button>
        </div>
      </div>

      {state.pendingBackup !== null && (
        <section className="message message-warn" role="alert">
          <p>
            保存できなかった内容が、この端末に退避されています（
            {formatTime(state.pendingBackup.savedAt)}）。
          </p>
          <div className="actions">
            <button
              type="button"
              className="button button-primary"
              onClick={() => session.restoreBackup()}
            >
              復元する
            </button>
            <button type="button" className="button" onClick={() => session.discardBackup()}>
              破棄する
            </button>
          </div>
        </section>
      )}

      {state.authLost && (
        <section className="message message-warn" role="alert">
          <p>ログインの期限が切れました。未保存の内容はこの端末に退避してあります。</p>
          <div className="actions">
            <a className="button button-primary" href={loginHref(window.location)}>
              ログインし直す
            </a>
            <button type="button" className="button" onClick={() => void session.retry()}>
              ログインし直したので再試行
            </button>
          </div>
        </section>
      )}

      {state.gone && (
        <section className="message message-error" role="alert">
          <p>このページはサーバーにありません（削除されました）。</p>
          <a
            className="button"
            href={homeHref()}
            onClick={(event) => {
              event.preventDefault();
              navigate(homeHref());
            }}
          >
            一覧へ戻る
          </a>
        </section>
      )}

      {state.error !== null && status === "error" && (
        <section className="message message-error" role="alert">
          <p>{state.error}</p>
          <button type="button" className="button" onClick={() => void session.flush()}>
            再試行
          </button>
        </section>
      )}
      {state.error !== null && status !== "error" && (
        <p className="message message-error" role="alert">
          {state.error}
        </p>
      )}

      {state.conflict !== null && (
        <ConflictPanel
          server={state.conflict}
          local={state.draft}
          busy={!idle}
          onOverwrite={() => void session.overwrite()}
          onTakeServer={() => session.takeServer()}
        />
      )}

      <input
        className="title-input"
        aria-label="title"
        value={state.draft.title}
        readOnly={readOnly}
        onChange={(event) =>
          session.edit({ ...session.getState().draft, title: event.target.value })
        }
        onBlur={() => void session.flush()}
      />
      <BodyEditor
        value={state.draft.body}
        readOnly={readOnly}
        onChange={(body) => session.edit({ ...session.getState().draft, body })}
        onBlur={() => void session.flush()}
      />
      <p className="muted editor-meta">
        最終更新 {formatTime(state.base.updatedAt)}（版 {state.base.version}）
      </p>

      <Backlinks pageId={page.id} />
    </article>
  );
}
