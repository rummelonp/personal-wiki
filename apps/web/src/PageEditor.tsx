import { foldTitle } from "@personal-wiki/domain/title";
import type { WikiLinkClick } from "@personal-wiki/editor";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { loginHref } from "./api";
import {
  acceptAttachment,
  createAttachmentUploader,
  createAttachmentUrlResolver,
  type UploadNotice,
} from "./attachments";
import { Backlinks } from "./Backlinks";
import { BodyEditor, type BodyEditorHandle } from "./BodyEditor";
import { ConflictPanel } from "./ConflictPanel";
import { createLocalBackupStore } from "./draft-backup";
import { bindLifecycle, registerEditor } from "./editor-lifecycle";
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
import { linkRewrites } from "./link-rewrites";
import { createLinkTargetSource, createTitleIndex } from "./link-sources";
import { Outline } from "./Outline";
import { hashOfLink } from "./page-fragment";
import {
  createPage,
  deletePage,
  failureMessage,
  findPageByTitle,
  getPage,
  type LinkRewritesQueued,
  listPageTitles,
  type Page,
  setVisibility,
  updatePage,
} from "./pages-api";
import { RailLayout, RailSection } from "./Rail";
import { homeHref, navigate, pageHrefFor } from "./route";
import { TitleEditor } from "./TitleEditor";
import { useFragmentJump } from "./use-fragment-jump";
import { createWikiLinks } from "./wiki-links";

/** 保存の応答のリンクの書き換えの数は、セッションに渡さず、保存した title と一緒に onLinkRewrites に渡す。 */
function editorApi(onLinkRewrites: (title: string, queued: LinkRewritesQueued) => void): EditorApi {
  return {
    getPage: (id) => getPage(id),
    updatePage: async (id, version, input, options) => {
      const res = await updatePage(id, version, input, options);
      if (!res.ok) return res;
      const { linkRewrites: queued, ...page } = res.value;
      if (queued !== undefined) onLinkRewrites(page.title, queued);
      return { ok: true, value: page };
    },
    setVisibility: (id, version, visibility) => setVisibility(id, version, visibility),
    deletePage: (id, version) => deletePage(id, version),
  };
}

// ページを移っても同じ候補を使い、開くたびに取り直す
const titleIndex = createTitleIndex((cursor) => listPageTitles(cursor));

const findWithSignal = (title: string, signal: AbortSignal) =>
  findPageByTitle(title, (input, init) => fetch(input, { ...init, signal }));

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

/** 同時に出す添付の失敗の数。まとめて貼った画像が全部失敗しても、画面を埋めない */
const MAX_UPLOAD_NOTICES = 5;

/** 本文のリンクをクリックしても開けなかったときの案内。 */
type LinkNotice =
  | { kind: "missing"; title: string; busy: boolean; error: string | null }
  | { kind: "error" };

function useEditorSession(
  page: Page,
  whenSettled: () => Promise<void>,
  onLinkRewrites: (title: string, queued: LinkRewritesQueued) => void,
): EditorSession {
  const [session] = useState(
    () =>
      new EditorSession(page, {
        api: editorApi(onLinkRewrites),
        backup: createLocalBackupStore(),
        whenSettled,
      }),
  );

  useEffect(() => {
    const unbind = bindLifecycle(session, document, window);
    const unregister = registerEditor(session);
    const leaveRewrites = linkRewrites.register(session);
    return () => {
      unbind();
      unregister();
      // アプリ内の遷移でも、未保存の変更をここで送る。送り終えるまでは、step がこのページを
      // 書き換えたら取り込めるよう、リンクの書き換えからは外さない
      void session.leave().finally(leaveRewrites);
    };
  }, [session]);

  return session;
}

interface PageEditorProps {
  page: Page;
  /**
   * 添付（画像）を使える環境か。`/api/me` の features。false なら貼り付けと drop をアップロードしない。
   * 作った時点の値で固定される（エディタを作り直さない限り反映されない）。
   * 後から変わりうるなら、PageView の key に含めて画面ごと作り直させる。
   */
  attachments?: boolean;
  /** 保存済みの title と公開範囲が決まるたびに呼ぶ。URL と document.title を合わせるため */
  onShown?: (page: Pick<Page, "id" | "title" | "visibility">) => void;
}

export function PageEditor({ page, attachments = false, onShown }: PageEditorProps) {
  const editor = useRef<BodyEditorHandle>(null);
  // リンクに書けないと知らされた title。保存の応答は、積んだものも飛ばしたものも無ければ書き換えの
  // 数を返さないので、応答ではなく保存済みの title と比べて、別の title に変えたら案内を消す
  const [unsafeTitle, setUnsafeTitle] = useState<string | null>(null);
  const session = useEditorSession(
    page,
    () => editor.current?.whenSettled() ?? Promise.resolve(),
    (title, queued) => {
      setUnsafeTitle(queued.skipped === "unsafe_title" ? title : null);
      if (queued.queued > 0) linkRewrites.start(queued.queued);
    },
  );
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const { title: savedTitle, visibility: savedVisibility } = state.base;

  useEffect(() => {
    onShown?.({ id: page.id, title: savedTitle, visibility: savedVisibility });
  }, [onShown, page.id, savedTitle, savedVisibility]);
  const { goTo } = useFragmentJump(editor);
  const status = saveStatusOf(state);
  const readOnly = isReadOnly(state);
  const idle = state.busy === null;
  const canChangeVisibility = idle && (status === "saved" || status === "unsaved");
  const outline = useMemo(() => extractOutline(state.draft.body), [state.draft.body]);
  const [linkTargets] = useState(() => createLinkTargetSource(findWithSignal));
  const [links] = useState(() => createWikiLinks({ pageId: page.id }));
  const [attachmentUrl] = useState(() =>
    createAttachmentUrlResolver({
      enabled: attachments,
      pageId: page.id,
      embedPageId: (target) => links.embedPageId(target),
    }),
  );
  const [uploadNotices, setUploadNotices] = useState<UploadNotice[]>([]);
  const [uploader] = useState(() =>
    createAttachmentUploader({
      notify: (notice) =>
        setUploadNotices((current) =>
          [...current.filter(({ message }) => message !== notice.message), notice].slice(
            -MAX_UPLOAD_NOTICES,
          ),
        ),
    }),
  );
  const [linkNotice, setLinkNotice] = useState<LinkNotice | null>(null);
  const linkClick = useRef<AbortController | null>(null);
  /** 作成の応答を待っている title。null なら作成中ではない */
  const creating = useRef<string | null>(null);

  useEffect(() => {
    void titleIndex.refresh();
  }, []);

  useEffect(() => uploader.bindUnloadGuard(window), [uploader]);

  // 自分の title が変わると、その title への link の存在が変わる。ほかの page は保存では変わらない
  // ので、embed の本文は取り直さない（autosave のたびに全部取り直すことになる）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 保存された title が変わったことを合図に取り直す
  useEffect(() => {
    links.refreshTitles();
  }, [links, state.base.title]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") links.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      linkClick.current?.abort();
      links.dispose();
    };
  }, [links]);

  async function handleWikiLinkClick(link: WikiLinkClick) {
    if (link.target === "") {
      // 同じページの見出しと block。ページを調べず、位置だけ移る
      linkClick.current?.abort();
      setLinkNotice(null);
      goTo(hashOfLink(link));
      return;
    }
    // 作成中の title をもう一度押されても、作成の表示と応答を取り替えない
    if (creating.current !== null && foldTitle(creating.current) === foldTitle(link.target)) return;
    linkClick.current?.abort();
    creating.current = null;
    const controller = new AbortController();
    linkClick.current = controller;
    setLinkNotice(null);
    const found = await links.lookup(link.target, controller.signal);
    if (controller.signal.aborted) return;
    if (found.kind === "found") {
      const hash = hashOfLink(link);
      if (found.page.id === page.id && hash !== "") goTo(hash);
      else navigate(`${pageHrefFor(found.page)}${hash}`);
    } else if (found.kind === "missing") {
      setLinkNotice({ kind: "missing", title: link.target, busy: false, error: null });
    } else setLinkNotice({ kind: "error" });
  }

  // 作ったページを開くので、未保存の変更はこのページを離れるときの leave が送る。
  // 応答を待つ間に別の link を押す、閉じる、ページを離れるとクリックの controller が中断される。
  // その場合は作成の応答が来ても遷移しない（作成の要求自体は止めず、ページはできる）
  async function createLinkedPage(title: string) {
    if (creating.current !== null) return;
    linkClick.current?.abort();
    const controller = new AbortController();
    linkClick.current = controller;
    creating.current = title;
    setLinkNotice({ kind: "missing", title, busy: true, error: null });
    try {
      const res = await createPage({ title, body: "" });
      if (controller.signal.aborted) return;
      if (res.ok) {
        navigate(pageHrefFor(res.value));
        return;
      }
      if (res.reason === "title_conflict") {
        // 別のところで同じ title のページができていた
        const existing = await links.lookup(title, controller.signal);
        if (controller.signal.aborted) return;
        if (existing.kind === "found") {
          navigate(pageHrefFor(existing.page));
          return;
        }
      }
      const message =
        res.reason === "unauthorized"
          ? "ログインの期限が切れました。ログインし直してください"
          : failureMessage(res, "作成できなかった");
      setLinkNotice({ kind: "missing", title, busy: false, error: message });
    } finally {
      if (linkClick.current === controller) creating.current = null;
    }
  }

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
            <p>
              {isDirty(state)
                ? "ログインの期限が切れました。未保存の内容はこの端末に退避してあります。"
                : "ログインの期限が切れました。未保存の変更はありません。"}
            </p>
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

        {linkNotice !== null && (
          <section className="message message-warn" role="alert">
            {linkNotice.kind === "error" ? (
              <p>リンク先を調べられませんでした。通信を確かめて、もう一度クリックしてください。</p>
            ) : (
              <>
                <p>「{linkNotice.title}」のページはまだありません。</p>
                {linkNotice.error !== null && <p>{linkNotice.error}</p>}
              </>
            )}
            <div className="actions">
              {linkNotice.kind === "missing" && (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={linkNotice.busy}
                  onClick={() => void createLinkedPage(linkNotice.title)}
                >
                  作成して開く
                </button>
              )}
              <button type="button" className="button" onClick={() => setLinkNotice(null)}>
                閉じる
              </button>
            </div>
          </section>
        )}

        {unsafeTitle !== null && unsafeTitle === savedTitle && (
          <section className="message message-warn" role="alert">
            <p>この title はリンクに書けないので、他のページのリンクは自動では書き換わらない。</p>
            <div className="actions">
              <button type="button" className="button" onClick={() => setUnsafeTitle(null)}>
                閉じる
              </button>
            </div>
          </section>
        )}

        {uploadNotices.length > 0 && (
          <section className="message message-warn" role="alert">
            {uploadNotices.map(({ message }) => (
              <p key={message}>{message}</p>
            ))}
            <div className="actions">
              {uploadNotices.some(
                ({ kind }) => kind === "unauthorized" || kind === "forbidden",
              ) && (
                <a className="button button-primary" href={loginHref(window.location)}>
                  ログインし直す
                </a>
              )}
              <button type="button" className="button" onClick={() => setUploadNotices([])}>
                閉じる
              </button>
            </div>
          </section>
        )}

        <TitleEditor
          value={state.titleInput ?? state.draft.title}
          readOnly={readOnly}
          bodyView={() => editor.current?.view() ?? null}
          onChange={(title) => session.editTitle(title)}
          onCommit={() => void session.commitTitle()}
          onBlur={() => void session.commitTitle()}
        />
        <BodyEditor
          ref={editor}
          value={state.draft.body}
          readOnly={readOnly}
          pageIndex={titleIndex}
          linkTargets={linkTargets}
          links={links}
          resolveAttachmentUrl={attachmentUrl}
          {...(attachments ? { onUploadAttachment: uploader.upload, acceptAttachment } : {})}
          onWikiLinkClick={(link) => void handleWikiLinkClick(link)}
          onChange={(body) => session.edit({ ...session.getState().draft, body })}
          onBlur={() => void session.flush()}
        />
      </article>
    </RailLayout>
  );
}
