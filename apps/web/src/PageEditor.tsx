import type { UploadAttachment, WikiLinkClick } from "@personal-wiki/editor";
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
import { Link } from "./Link";
import { linkRewrites } from "./link-rewrites";
import { createLinkTargetSource, createTitleIndex } from "./link-sources";
import { Notice } from "./Notice";
import { openNewPage, registerNewPageScreen } from "./new-page";
import { InlineOutline, Outline } from "./Outline";
import { PublishBar } from "./PublishBar";
import { hashOfLink } from "./page-fragment";
import {
  createPage,
  deletePage,
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
import { TitleEditor, type TitleEditorHandle } from "./TitleEditor";
import { useFragmentJump } from "./use-fragment-jump";
import { createWikiLinks } from "./wiki-links";

/** 保存の応答のリンクの書き換えの数は、セッションに渡さず、保存した title と一緒に onLinkRewrites に渡す。 */
function editorApi(onLinkRewrites: (title: string, queued: LinkRewritesQueued) => void): EditorApi {
  return {
    createPage: (input) => createPage(input),
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
  new: "タイトルを決めると保存します",
  creating: "作成中…",
  "create-error": "作成に失敗",
  saved: "保存済み",
  unsaved: "未保存の変更あり",
  saving: "保存中…",
  error: "保存に失敗",
  conflict: "サーバーの内容と食い違っています",
  auth: "ログインが切れました",
  gone: "ページがありません",
};

const FAILURE_TITLES: Record<FailedOp["kind"], string> = {
  create: "作成できませんでした",
  save: "保存に失敗しました",
  visibility: "公開設定を変えられませんでした",
  delete: "削除できませんでした",
};

/** 保存や作成が失敗しても、打った内容は画面に残り、session が端末にも退避する（editor-session の stashIfDirty） */
const KEPT_CONTENT = "入力した内容はこの画面に残り、この端末にも退避してあります。";

function retryLabel(op: FailedOp): string {
  switch (op.kind) {
    case "create":
      return "もう一度作成する";
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
type LinkNotice = { kind: "missing"; title: string } | { kind: "error" };

function useEditorSession(
  page: Page | null,
  newTitle: string,
  whenSettled: () => Promise<void>,
  onLinkRewrites: (title: string, queued: LinkRewritesQueued) => void,
): EditorSession {
  const [session] = useState(
    () =>
      new EditorSession(
        page,
        { api: editorApi(onLinkRewrites), backup: createLocalBackupStore(), whenSettled },
        newTitle,
      ),
  );

  useEffect(() => {
    session.attach();
    const unbind = bindLifecycle(session, document, window);
    const unregister = registerEditor(session);
    const leaveRewrites = linkRewrites.register(session);
    // 前の画面の unmount（detach）が退避を書き終えた後なので、ここで読む
    session.adoptPendingBackup();
    // title を渡して開いた新規作成の画面は、title 欄の確定を待たずに作る
    if (session.getState().uncreated) void session.commitTitle();
    return () => {
      unbind();
      unregister();
      // アプリ内の遷移でも、未保存の変更をここで送る。送り終えるまでは、step がこのページを
      // 書き換えたら取り込めるよう、リンクの書き換えからは外さない
      void session.detach().finally(leaveRewrites);
    };
  }, [session]);

  return session;
}

interface PageEditorProps {
  /** null なら、まだ作っていないページ（新規作成の画面）を開く */
  page: Page | null;
  /**
   * 新規作成の画面の title 欄の初期値。空なら title 欄に、空でなければ本文にカーソルを置き、
   * 空でなければ開いてすぐに作る。
   */
  newTitle?: string;
  /**
   * 添付（画像）を使える環境か。`/api/me` の features。false なら貼り付けと drop をアップロードしない。
   * 作った時点の値で固定される（エディタを作り直さない限り反映されない）。
   * 後から変わりうるなら、PageView の key に含めて画面ごと作り直させる。
   */
  attachments?: boolean;
  /**
   * 保存済みの title と公開範囲が決まるたびに呼ぶ。URL と document.title を合わせるため。
   * まだ作っていないページでは、作れるまで呼ばない
   */
  onShown?: (page: Pick<Page, "id" | "title" | "visibility">) => void;
}

export function PageEditor({ page, newTitle = "", attachments = false, onShown }: PageEditorProps) {
  const editor = useRef<BodyEditorHandle>(null);
  const titleEditor = useRef<TitleEditorHandle>(null);
  // リンクに書けないと知らされた title。保存の応答は、積んだものも飛ばしたものも無ければ書き換えの
  // 数を返さないので、応答ではなく保存済みの title と比べて、別の title に変えたら案内を消す
  const [unsafeTitle, setUnsafeTitle] = useState<string | null>(null);
  const session = useEditorSession(
    page,
    newTitle,
    async () => {
      await Promise.all([titleEditor.current?.whenSettled(), editor.current?.whenSettled()]);
    },
    (title, queued) => {
      setUnsafeTitle(queued.skipped === "unsafe_title" ? title : null);
      if (queued.queued > 0) linkRewrites.start(queued.queued);
    },
  );
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const { id: pageId, title: savedTitle, visibility: savedVisibility } = state.base;
  const { uncreated } = state;
  // カーソルを置く先は開いた時点で決め、作れた後も変えない
  const [focusTarget] = useState(() =>
    page === null ? (session.getState().draft.title === "" ? "title" : "body") : null,
  );

  useEffect(() => {
    if (!session.getState().uncreated) return;
    return registerNewPageScreen(() => {
      if (!session.holdsUncreatedContent()) return false;
      titleEditor.current?.focus();
      return true;
    });
  }, [session]);

  useEffect(() => {
    if (!uncreated) onShown?.({ id: pageId, title: savedTitle, visibility: savedVisibility });
  }, [onShown, uncreated, pageId, savedTitle, savedVisibility]);
  const { goTo } = useFragmentJump(editor);
  const status = saveStatusOf(state);
  const readOnly = isReadOnly(state);
  const idle = state.busy === null;
  const canChangeVisibility = idle && (status === "saved" || status === "unsaved");
  const outline = useMemo(() => extractOutline(state.draft.body), [state.draft.body]);
  const [linkTargets] = useState(() => createLinkTargetSource(findWithSignal));
  const [links] = useState(() => createWikiLinks({ pageId: () => session.getState().base.id }));
  const [attachmentUrl] = useState(() =>
    createAttachmentUrlResolver({
      enabled: attachments,
      pageId: () => {
        const current = session.getState();
        return current.uncreated ? null : current.base.id;
      },
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
  // 添付はページの id の下に置くので、作る前の貼り付けは受け付けない
  const [upload] = useState<UploadAttachment>(() => (file: File) => {
    if (!session.getState().uncreated) return uploader.upload(file);
    const message = "画像は、タイトルを決めてページを作ってから貼ってください。";
    setUploadNotices((current) =>
      [
        ...current.filter((notice) => notice.message !== message),
        { kind: "error" as const, message },
      ].slice(-MAX_UPLOAD_NOTICES),
    );
    return Promise.reject(new Error("page not created"));
  });
  const [linkNotice, setLinkNotice] = useState<LinkNotice | null>(null);
  const linkClick = useRef<AbortController | null>(null);
  /** title の重複で作れなかったとき、すでにあるページ。開く導線に使う */
  const [taken, setTaken] = useState<{ title: string; href: string } | null>(null);
  const takenTitle =
    state.failedOp?.kind === "create" && state.failedOp.titleTaken ? state.failedOp.title : null;

  useEffect(() => {
    if (takenTitle === null) return;
    const controller = new AbortController();
    void findWithSignal(takenTitle, controller.signal).then((res) => {
      if (!controller.signal.aborted && res.ok) {
        setTaken({ title: takenTitle, href: pageHrefFor(res.value) });
      }
    });
    return () => controller.abort();
  }, [takenTitle]);

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
    linkClick.current?.abort();
    const controller = new AbortController();
    linkClick.current = controller;
    setLinkNotice(null);
    const found = await links.lookup(link.target, controller.signal);
    if (controller.signal.aborted) return;
    if (found.kind === "found") {
      const hash = hashOfLink(link);
      if (found.page.id === pageId && hash !== "") goTo(hash);
      else navigate(`${pageHrefFor(found.page)}${hash}`);
    } else if (found.kind === "missing") {
      setLinkNotice({ kind: "missing", title: link.target });
    } else setLinkNotice({ kind: "error" });
  }

  async function handleDelete() {
    if (!window.confirm(`「${state.base.title}」を削除します。元に戻せません。よろしいですか？`))
      return;
    if (await session.remove()) navigate(homeHref());
  }

  // 削除の再試行は確認を挟まない。ボタン自体が「もう一度削除する」と明示している
  async function retryFailed(op: FailedOp | null) {
    if (op === null) return;
    if (op.kind === "create") await session.retryCreate();
    else if (op.kind === "save") await session.flush();
    else if (op.kind === "visibility") await session.changeVisibility(op.to);
    else if (await session.remove()) navigate(homeHref());
  }

  const rail = (
    <>
      <Outline items={outline} onJump={(offset) => editor.current?.jumpTo(offset)} />
      {!uncreated && <Backlinks pageId={pageId} />}
      {!uncreated && (
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
      )}
      <div>
        <button
          type="button"
          className="button button-quiet button-danger"
          disabled={
            uncreated ||
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
          <Notice
            tone="warn"
            title="前回、保存できなかった内容があります"
            actions={
              <>
                <button
                  type="button"
                  className="button button-main"
                  onClick={() => session.restoreBackup()}
                >
                  復元する
                </button>
                <button type="button" className="button" onClick={() => session.discardBackup()}>
                  破棄する
                </button>
              </>
            }
          >
            <p>
              {state.pendingBackup.createFailed
                ? `作成できなかったページ「${state.pendingBackup.title}」の内容が、この端末に退避されています（`
                : "保存できなかった内容が、この端末に退避されています（"}
              {formatTime(state.pendingBackup.savedAt)}
              ）。復元して続けるか、破棄してください。
            </p>
          </Notice>
        )}

        {state.authLost && (
          <Notice
            tone="warn"
            title="ログインの期限が切れました"
            actions={
              <>
                <a className="button button-main" href={loginHref(window.location)}>
                  ログインし直す
                </a>
                <button type="button" className="button" onClick={() => void session.retry()}>
                  ログインし直したので再試行
                </button>
              </>
            }
          >
            <p>
              {isDirty(state)
                ? "未保存の内容はこの端末に退避してあります。ログインし直すと、続きから保存できます。"
                : "未保存の変更はありません。ログインし直してください。"}
            </p>
          </Notice>
        )}

        {state.gone && (
          <Notice
            tone="error"
            title="このページはサーバーにありません"
            actions={
              <a
                className="button button-main"
                href={homeHref()}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(homeHref());
                }}
              >
                一覧へ戻る
              </a>
            }
          >
            <p>別の場所で削除されたため、このページは編集できません。一覧へ戻ってください。</p>
          </Notice>
        )}

        {state.error !== null && state.failedOp !== null && state.failedOp.kind !== "create" && (
          <Notice
            tone="error"
            title={FAILURE_TITLES[state.failedOp.kind]}
            actions={
              <button
                type="button"
                className="button button-main"
                disabled={!idle}
                onClick={() => void retryFailed(state.failedOp)}
              >
                {retryLabel(state.failedOp)}
              </button>
            }
          >
            <p>
              {state.error}
              {state.failedOp.kind === "save" && isDirty(state) && KEPT_CONTENT}
            </p>
          </Notice>
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

        {linkNotice !== null &&
          (linkNotice.kind === "error" ? (
            <Notice
              tone="warn"
              title="リンク先を調べられませんでした"
              actions={
                <button type="button" className="button" onClick={() => setLinkNotice(null)}>
                  閉じる
                </button>
              }
            >
              <p>通信を確かめて、もう一度クリックしてください。</p>
            </Notice>
          ) : (
            <Notice
              tone="info"
              title={`「${linkNotice.title}」のページはまだありません`}
              actions={
                <>
                  <button
                    type="button"
                    className="button button-main"
                    // このページの未保存の変更は、離れるときの leave が送る
                    onClick={() => openNewPage({ title: linkNotice.title })}
                  >
                    作成して開く
                  </button>
                  <button type="button" className="button" onClick={() => setLinkNotice(null)}>
                    閉じる
                  </button>
                </>
              }
            >
              <p>作成して開くと、この title の新しいページに移ります。</p>
            </Notice>
          ))}

        {unsafeTitle !== null && unsafeTitle === savedTitle && (
          <Notice
            tone="warn"
            title="他のページのリンクは自動では書き換わりません"
            actions={
              <button type="button" className="button" onClick={() => setUnsafeTitle(null)}>
                閉じる
              </button>
            }
          >
            <p>この title はリンクに書けないので、旧 title へのリンクは手で直してください。</p>
          </Notice>
        )}

        {uploadNotices.length > 0 && (
          <Notice
            tone="warn"
            title="画像を添付できませんでした"
            actions={
              <>
                {uploadNotices.some(
                  ({ kind }) => kind === "unauthorized" || kind === "forbidden",
                ) && (
                  <a className="button button-main" href={loginHref(window.location)}>
                    ログインし直す
                  </a>
                )}
                <button type="button" className="button" onClick={() => setUploadNotices([])}>
                  閉じる
                </button>
              </>
            }
          >
            {uploadNotices.map(({ message }) => (
              <p key={message}>{message}</p>
            ))}
          </Notice>
        )}

        <TitleEditor
          ref={titleEditor}
          value={state.titleInput ?? state.draft.title}
          readOnly={readOnly}
          autoFocus={focusTarget === "title"}
          bodyView={() => editor.current?.view() ?? null}
          onChange={(title) => session.editTitle(title)}
          onCommit={() => void session.commitTitle()}
          onBlur={() => void session.commitTitle()}
        />
        {state.error !== null && state.failedOp?.kind === "create" && (
          <Notice
            tone="error"
            title={FAILURE_TITLES.create}
            actions={
              state.failedOp.titleTaken ? undefined : (
                <button
                  type="button"
                  className="button button-main"
                  disabled={!idle}
                  onClick={() => void retryFailed(state.failedOp)}
                >
                  {retryLabel(state.failedOp)}
                </button>
              )
            }
          >
            <p>{state.error}</p>
            {state.failedOp.titleTaken ? (
              <p>
                タイトルを変えて Enter を押すと、もう一度作ります。
                {taken !== null && taken.title === state.failedOp.title && (
                  <>
                    {" "}
                    <Link href={taken.href}>そのページを開く</Link>
                  </>
                )}
              </p>
            ) : (
              <p>{KEPT_CONTENT}</p>
            )}
          </Notice>
        )}
        <PublishBar
          visibility={savedVisibility}
          uncreated={uncreated}
          disabled={!canChangeVisibility || state.pendingBackup !== null}
          externalBases={state.externalBases}
          titlePending={
            state.titleInput !== null
              ? state.titleInput !== savedTitle
              : state.draft.title !== savedTitle
          }
          sharePath={pageHrefFor({ id: pageId, title: savedTitle, visibility: "public" })}
          onChange={(to) => session.changeVisibility(to)}
        />
        <InlineOutline items={outline} onJump={(offset) => editor.current?.jumpTo(offset)} />
        <BodyEditor
          ref={editor}
          value={state.draft.body}
          readOnly={readOnly}
          autoFocus={focusTarget === "body"}
          pageIndex={titleIndex}
          linkTargets={linkTargets}
          links={links}
          resolveAttachmentUrl={attachmentUrl}
          {...(attachments ? { onUploadAttachment: upload, acceptAttachment } : {})}
          onWikiLinkClick={(link) => void handleWikiLinkClick(link)}
          onChange={(body) => session.edit({ ...session.getState().draft, body })}
          onBlur={() => void session.flush()}
        />
      </article>
    </RailLayout>
  );
}
