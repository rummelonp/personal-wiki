import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { loginHref } from "./api";
import { Backlinks } from "./Backlinks";
import { BodyEditor, type BodyEditorHandle } from "./BodyEditor";
import { ConflictPanel } from "./ConflictPanel";
import { createLocalBackupStore } from "./draft-backup";
import {
  type EditorApi,
  EditorSession,
  type FailedOp,
  isDirty,
  isReadOnly,
  type SaveStatus,
  saveStatusOf,
} from "./editor-session";
import { formatTime } from "./format";
import { extractOutline } from "./heading-outline";
import { Outline } from "./Outline";
import { deletePage, getPage, type Page, setVisibility, updatePage } from "./pages-api";
import { RailLayout, RailSection } from "./Rail";
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

const FAILURE_LEADS: Record<FailedOp["kind"], string> = {
  save: "保存に失敗しました。",
  visibility: "公開設定を変えられませんでした。",
  delete: "削除できませんでした。",
};

function retryLabel(op: FailedOp): string {
  switch (op.kind) {
    case "save":
      return "もう一度保存する";
    case "visibility":
      return op.to === "public" ? "もう一度公開にする" : "もう一度下書きにする";
    case "delete":
      return "もう一度削除する";
  }
}

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
  const editor = useRef<BodyEditorHandle>(null);
  const status = saveStatusOf(state);
  const readOnly = isReadOnly(state);
  const idle = state.busy === null;
  const canChangeVisibility = idle && (status === "saved" || status === "unsaved");
  const outline = useMemo(() => extractOutline(state.draft.body), [state.draft.body]);

  async function handleDelete() {
    if (!window.confirm(`「${state.base.title}」を削除します。元に戻せません。よろしいですか？`))
      return;
    if (await session.remove()) navigate(homeHref());
  }

  // 削除の再試行は確認を挟まない。ボタン自体が「もう一度削除する」と明示している
  async function retryFailed(op: FailedOp | null) {
    if (op === null) return;
    if (op.kind === "save") await session.flush();
    else if (op.kind === "visibility") await session.changeVisibility(op.to);
    else if (await session.remove()) navigate(homeHref());
  }

  const rail = (
    <>
      <Outline items={outline} onJump={(offset) => editor.current?.jumpTo(offset)} />
      <Backlinks pageId={page.id} />
      <RailSection title="公開設定">
        <div className="segmented">
          {(["draft", "public"] as const).map((visibility) => (
            <button
              key={visibility}
              type="button"
              className="segmented-option"
              aria-pressed={state.base.visibility === visibility}
              disabled={!canChangeVisibility}
              onClick={() => void session.changeVisibility(visibility)}
            >
              {visibility === "public" ? "公開" : "下書き"}
            </button>
          ))}
        </div>
      </RailSection>
      <RailSection title="情報">
        <dl className="facts">
          <dt>版</dt>
          <dd>{state.base.version}</dd>
          <dt>更新</dt>
          <dd>{formatTime(state.base.updatedAt)}</dd>
          <dt>作成</dt>
          <dd>{formatTime(state.base.createdAt)}</dd>
        </dl>
      </RailSection>
      <div>
        <button
          type="button"
          className="button button-quiet button-danger"
          disabled={
            !idle ||
            state.gone ||
            state.authLost ||
            state.conflict !== null ||
            state.pendingBackup !== null
          }
          onClick={() => void handleDelete()}
        >
          このページを削除
        </button>
      </div>
    </>
  );

  return (
    <RailLayout rail={rail}>
      <article className="note">
        <p className={`save-state save-state-${status}`} role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          {STATUS_LABELS[status]}
        </p>

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

        {state.error !== null && state.failedOp !== null && (
          <section className="message message-error" role="alert">
            <p>
              {FAILURE_LEADS[state.failedOp.kind]}
              {state.error}
            </p>
            <button
              type="button"
              className="button"
              disabled={!idle}
              onClick={() => void retryFailed(state.failedOp)}
            >
              {retryLabel(state.failedOp)}
            </button>
          </section>
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
          ref={editor}
          value={state.draft.body}
          readOnly={readOnly}
          onChange={(body) => session.edit({ ...session.getState().draft, body })}
          onBlur={() => void session.flush()}
        />
      </article>
    </RailLayout>
  );
}
