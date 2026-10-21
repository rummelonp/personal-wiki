import { MAX_BODY_BYTES } from "@personal-wiki/domain/page-input";
import type { UploadAttachment, WikiLinkClick } from "@personal-wiki/editor";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  acceptAttachment,
  createAttachmentUploader,
  createAttachmentUrlResolver,
  type UploadNotice,
} from "./attachments";
import { BodyEditor, type BodyEditorHandle } from "./BodyEditor";
import { ConflictPanel } from "./ConflictPanel";
import { createLocalBackupStore } from "./draft-backup";
import {
  AuthLostNotice,
  FailureNotice,
  GoneNotice,
  InputProblemNotice,
  KeptBackupNotice,
  LinkNotice,
  type LinkNoticeState,
  UnsafeTitleNotice,
  UploadNotices,
} from "./EditorNotices";
import { EditorRail } from "./EditorRail";
import { bindLifecycle } from "./editor-lifecycle";
import { registerEditor } from "./editor-registry";
import {
  type EditorApi,
  EditorSession,
  type FailedOp,
  holdsBack,
  inputCheckOf,
  isDirty,
  isReadOnly,
  type SaveStatus,
  saveStatusOf,
} from "./editor-session";
import { focusAndRevealCaret } from "./focus-reveal";
import { extractOutline } from "./heading-outline";
import { InputMeter, METER_SHOW_RATIO } from "./InputMeter";
import { inputProblemTitle } from "./input-messages";
import { focusAfterInput } from "./input-modality";
import { useDelayedWhile } from "./Loading";
import { linkRewrites } from "./link-rewrites";
import { createTitleIndex } from "./link-sources";
import { createLinkTargetSource } from "./link-target-source";
import { findLinkedDrafts } from "./linked-drafts";
import { Notice } from "./Notice";
import { registerNewPageScreen } from "./new-page";
import { InlineOutline } from "./Outline";
import { canChangeVisibility, shownInputProblems } from "./page-editor-state";
import { hashOfLink } from "./page-fragment";
import { rememberTitle } from "./page-titles";
import {
  createPage,
  deletePage,
  findPageByTitle,
  getPage,
  type LinkRewritesQueued,
  listPageTitles,
  type Page,
  restoreRevision,
  setVisibility,
  updatePage,
} from "./pages-api";
import { RailLayout } from "./Rail";
import { homeHref, missingPagePath, navigate, openTag, pageHrefFor } from "./route";
import { TitleEditor, type TitleEditorHandle } from "./TitleEditor";
import { useFailureProgress } from "./use-failure-progress";
import { useFragmentJump } from "./use-fragment-jump";
import { VisibilityControl } from "./VisibilityControl";
import { createWikiLinks } from "./wiki-links";

/** 保存のレスポンスのリンクの書き換えの数は、セッションに渡さず、保存した title と一緒に onLinkRewrites に渡す。 */
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
    restoreRevision: (id, revision, version) => restoreRevision(id, revision, version),
  };
}

// ページを移っても同じ候補を使い、開くたびに取り直す
const titleIndex = createTitleIndex((cursor) => listPageTitles(cursor));

const findWithSignal = (title: string, signal: AbortSignal) =>
  findPageByTitle(title, (input, init) => fetch(input, { ...init, signal }));

const STATUS_LABELS: Record<SaveStatus, string> = {
  new: "タイトルを入れて欄を離れると作成します",
  creating: "作成中…",
  "create-error": "作成に失敗",
  saved: "保存済み",
  unsaved: "未保存の変更あり",
  saving: "保存中…",
  invalid: "保存できません",
  error: "保存に失敗",
  conflict: "別の場所でも更新あり",
  kept: "端末に残った内容あり",
  auth: "ログインの期限切れ",
  gone: "削除済み",
};

/**
 * 通知か見えない status がすでに読み上げる状態。上端の文はこれらを読み上げない。
 * 上端自体を live region にすると、通知の alert と合わせて 2 度読まれる。
 */
const SPOKEN_BY_NOTICE: ReadonlySet<SaveStatus> = new Set([
  "create-error",
  "error",
  "invalid",
  "conflict",
  "kept",
  "auth",
  "gone",
]);

/** 同時に出す添付の失敗の数。まとめて貼った画像が全部失敗しても、画面を埋めない */
const MAX_UPLOAD_NOTICES = 5;

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
   * 新規作成の画面の title 欄の初期値。空なら title 欄に、空でなければ本文にカーソルを置く。
   * 空でなければ、開いてすぐに作る。
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
  const article = useRef<HTMLElement>(null);
  // リンクに書けないと知らされた title。保存のレスポンスは、キューに入れたものも飛ばしたものも無ければ書き換えの
  // 数を返さないので、レスポンスではなく保存済みの title と比べて、別の title に変えたら案内を消す
  const [pendingVisibility, setPendingVisibility] = useState<"draft" | "public" | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
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
  // 押したボタンが消えた後、focus が body に落ちないよう移す先。タッチ端末で本文に移すと、閉じたキーボードが
  // 開き直り、カーソルの行へスクロールして title が見える範囲から外れる。そこではキーボードを開かない
  // ページの枠に移し、スクロールの位置も動かさない。枠に tabindex を付けるのは focus を持つ間だけにする。
  // 付けたままだと、本文の編集中に枠の余白を押しただけで枠が focus を取り、本文の入力が途切れる
  function focusBodyOrFrame() {
    const frame = article.current;
    if (frame !== null && window.matchMedia("(pointer: coarse)").matches) {
      frame.tabIndex = -1;
      frame.addEventListener("blur", () => frame.removeAttribute("tabindex"), { once: true });
      frame.focus({ preventScroll: true });
    } else {
      const view = editor.current?.view();
      if (view) focusAndRevealCaret(view);
    }
  }
  // title を直す場面で、title の欄へ移す。タッチ端末は、本文と同じ理由でキーボードを開かない枠へ移す
  function focusTitleOrBodyOrFrame(toTitle: boolean) {
    if (toTitle && !window.matchMedia("(pointer: coarse)").matches) titleEditor.current?.focus();
    else focusBodyOrFrame();
  }
  // 解決の間にサーバーの版がまた進むと衝突の通知が残るので、そのときは動かさない
  async function resolveConflict(resolve: () => void | Promise<void>) {
    await resolve();
    if (session.getState().conflict !== null) return;
    focusBodyOrFrame();
  }
  const settleKeptFocus = useRef(false);
  useEffect(() => {
    if (!settleKeptFocus.current) return;
    settleKeptFocus.current = false;
    // 本文が差し替わった後に移す。利用者が先に別の場所へ focus を移していたら奪わない
    const active = document.activeElement;
    const now = session.getState();
    if ((active === null || active === document.body) && now.conflict === null)
      // 作る前のページで title が空のままなら、次に書くのは title なので、開いた直後と同じく title の欄へ移す。
      // 戻した内容で title が埋まったときは本文へ移す
      focusTitleOrBodyOrFrame(now.uncreated && (now.titleInput ?? now.draft.title) === "");
  });
  // 復元か破棄の次の通知（別のタブの退避の続き、衝突）が出るときは、その通知が focus を受ける
  function resolveKept(resolve: () => void) {
    resolve();
    const next = session.getState();
    settleKeptFocus.current = next.pendingBackup === null && next.conflict === null;
  }
  const status = saveStatusOf(state);
  const readOnly = isReadOnly(state);
  const idle = state.busy === null;
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
  const [linkNotice, setLinkNotice] = useState<LinkNoticeState | null>(null);
  const linkClick = useRef<AbortController | null>(null);
  /** 問い合わせ中の link（target と見出し）。同じ link の押し直しで、問い合わせを最初からやり直さない */
  const linkClickKey = useRef<string | null>(null);
  /** 行き先を調べている wikilink の target。遅い回線でも押したことが分かるよう、画面を薄くする */
  const [linkPending, setLinkPending] = useState<string | null>(null);
  const leaving = useDelayedWhile(linkPending !== null);

  useEffect(() => {
    void titleIndex.refresh();
  }, []);

  useEffect(() => uploader.bindUnloadGuard(window), [uploader]);

  // 自分の title が変わると、その title への link の存在が変わる。公開範囲が変わると、自分への link の
  // href（draft は id の URL、public は title の URL）が変わる。ほかの page は保存では変わらないので、
  // embed の本文は取り直さない（autosave のたびに全部取り直すことになる）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 保存された title と公開範囲が変わったことを合図に取り直す
  useEffect(() => {
    links.refreshTitles();
  }, [links, state.base.title, savedVisibility]);

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
      setLinkPending(null);
      linkClick.current?.abort();
      linkClickKey.current = null;
      setLinkNotice(null);
      goTo(hashOfLink(link));
      return;
    }
    const key = `${link.target}${hashOfLink(link)}`;
    if (linkClickKey.current === key) return;
    linkClick.current?.abort();
    const controller = new AbortController();
    linkClick.current = controller;
    linkClickKey.current = key;
    setLinkNotice(null);
    setLinkPending(link.target);
    const found = await links.lookup(link.target, controller.signal);
    if (controller.signal.aborted) return;
    linkClickKey.current = null;
    setLinkPending(null);
    if (found.kind === "found") {
      const hash = hashOfLink(link);
      if (found.page.id === pageId && hash !== "") goTo(hash);
      else {
        // 行き先の読み込み中の画面で、title をスケルトンではなく文字で出せるようにする
        rememberTitle(found.page.id, found.page.title);
        navigate(`${pageHrefFor(found.page)}${hash}`);
      }
    } else if (found.kind === "missing") {
      const path = missingPagePath(link.target);
      if (path !== null) navigate(path);
      else setLinkNotice({ kind: "missing", title: link.target });
    } else setLinkNotice({ kind: "error" });
  }

  // 待っている先は session の状態に無いので、ここで持つ。再試行の経路も通し、どちらでも選択に出す
  async function changeVisibility(to: "draft" | "public") {
    setPendingVisibility(to);
    try {
      await session.changeVisibility(to);
    } finally {
      setPendingVisibility(null);
    }
  }

  // 公開の前に未保存の本文も保存される（session の changeVisibility）ので、保存済みではなく画面の本文で調べる
  function findDrafts(signal: AbortSignal) {
    const current = session.getState();
    return findLinkedDrafts(current.draft.body, {
      selfId: current.base.id,
      fetchFn: (input, init) => fetch(input, { ...init, signal }),
    });
  }

  // 削除を待つ間に別の画面へ移ると、削除が済んでも今いる画面を一覧へ移さない。削除そのものは続ける
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function handleDelete() {
    const warning = isDirty(state) ? "未保存の変更も含めて、元に戻せません。" : "元に戻せません。";
    if (!window.confirm(`「${state.base.title}」を削除しますか？${warning}`)) return;
    // 保存中に承認すると、session は削除を保存の後ろに並べる。待つ間も「削除中…」にして押し直せなくする
    setPendingDelete(true);
    let removed: boolean;
    try {
      removed = await session.remove();
    } finally {
      setPendingDelete(false);
    }
    if (removed && mounted.current) navigate(homeHref());
  }

  const { shownFailure, failure, createFailure, afterFailure, progress, saveStateEl } =
    useFailureProgress(state);
  // 再送が再び失敗すると、失敗の通知は進行の通知を挟んで作り直される（読み上げさせるため、同じ要素を使い回せない）。
  // 再送のボタンが消えるとき、押そうとしていたなら、作り直されたボタンが押せるようになった描画で
  // focus を戻す。作り直されたボタンは、操作が終わるまで disabled で focus を受けない。
  // 本文の blur が保存を始めるのは mousedown の途中で、ボタンに focus が着く前に消えることがあるので、
  // focus を持っていたかだけでなく、押す操作が始まっていたか（ボタンの上の pointerdown）も見る。
  // ボタンへ向かう focusout は、届く時点でボタンがもう外れているので手がかりにならない。
  // 待つ間に focus が別の要素（打ち始めた本文など）へ移っていたら、戻さない。何も無い所を押して
  // focus を body に落とした場合も、利用者が外したのだから戻さない。ボタンが消えた時点の
  // pointerdown はボタンの上のものなので、消えた後の pointerdown だけが外す操作になる。
  // この仕組みは ref callback の呼び出しに頼る。disabled の切り替えでは呼ばれないので、session が
  // busy を立てるときは、同じ更新で error と failedOp を消す（ボタンが外れる）前提に立つ。
  // この前提は editor-session.test.ts の「処理が始まると失敗の記録を消す」が押さえる
  const retryButtonEl = useRef<HTMLButtonElement | null>(null);
  const restoreRetryFocus = useRef(false);
  const aimingAtRetry = useRef(false);
  // 再送のボタンが消えている間、focus を預ける目に見えない要素と、預けたかどうか
  const waitAnchorEl = useRef<HTMLSpanElement | null>(null);
  const parkedOnAnchor = useRef(false);
  const retryButtonRef = useCallback((element: HTMLButtonElement | null) => {
    const button = retryButtonEl.current;
    if (element === null && button !== null) {
      if (aimingAtRetry.current || document.activeElement === button)
        restoreRetryFocus.current = true;
      aimingAtRetry.current = false;
    }
    retryButtonEl.current = element;
  }, []);
  useEffect(() => {
    const onDown = (event: Event) => {
      const button = retryButtonEl.current;
      const onButton =
        event.type === "pointerdown" &&
        button !== null &&
        event.target instanceof Node &&
        button.contains(event.target);
      if (event.type === "pointerdown" && !onButton) restoreRetryFocus.current = false;
      if (
        (event.type === "pointerdown" && !onButton) ||
        (event.type === "focusin" && event.target !== waitAnchorEl.current)
      )
        parkedOnAnchor.current = false;
      if (button !== null) aimingAtRetry.current = onButton;
    };
    const types = ["pointerdown", "focusin", "click"];
    for (const type of types) document.addEventListener(type, onDown, true);
    return () => {
      for (const type of types) document.removeEventListener(type, onDown, true);
    };
  }, []);
  useEffect(() => {
    const anchor = waitAnchorEl.current;
    const active = document.activeElement;
    const lost = active === null || active === document.body;
    const parked = parkedOnAnchor.current;
    if (anchor === null) parkedOnAnchor.current = false;
    if (restoreRetryFocus.current) {
      // 失敗の通知が戻らずに操作が終わったとき（成功、衝突、再試行できない失敗など）に、
      // 次の失敗の通知へ持ち越さない。操作の途中は通知にボタンが無いので、busy の間は待つ
      const button = retryButtonEl.current;
      if (!afterFailure || !(lost || active === anchor) || (button === null && state.busy === null))
        restoreRetryFocus.current = false;
      else if (button?.disabled === false) {
        restoreRetryFocus.current = false;
        focusAfterInput(button, { preventScroll: true });
        return;
      } else if (anchor !== null && lost) {
        // 押したボタンが消えると、focus は body に落ちる。WebKit は、focus が body や消えない要素に
        // あっても、本文か title の欄に選択が残っていれば打鍵の既定の動作（Enter の改行）をその選択へ届けるので、
        // 応答を待つ間の Enter が欄に入る。そこで選択を外す。view は focus を受けるときに選択を描き直す。
        // focus の預け先は、body に落とさないための置き場で、Enter を止めるのは選択を外す方である
        focusAfterInput(anchor, { preventScroll: true });
        const selection = window.getSelection();
        const node = selection?.anchorNode;
        if (
          node &&
          (editor.current?.view()?.contentDOM.contains(node) || titleEditor.current?.contains(node))
        )
          selection?.removeAllRanges();
        parkedOnAnchor.current = true;
        return;
      }
    }
    // 預けた先が、再送のボタンに戻らずに消えたとき（成功、衝突など）は、focus を body に落とさない。
    // title の重複で終わったときは、次に直すのが title なので、title の欄へ移す。
    if (parked && anchor === null && lost && !restoreRetryFocus.current) {
      const titleTaken =
        (shownFailure?.kind === "create" || shownFailure?.kind === "save") &&
        shownFailure.titleTaken !== undefined;
      focusTitleOrBodyOrFrame(titleTaken);
    }
  });
  // 削除の再試行は確認を挟まない。ボタン自体が「もう一度削除する」と明示している
  async function retryFailed(op: FailedOp | null) {
    if (op === null) return;
    if (op.kind === "create") await session.retryCreate();
    else if (op.kind === "save") await session.flush();
    else if (op.kind === "visibility") await changeVisibility(op.to);
    else if ((await session.remove()) && mounted.current) navigate(homeHref());
  }

  const inputProblems = shownInputProblems(state);
  const inputProblem = inputProblems[0];
  const failureNoticeProps = {
    error: state.error,
    dirty: isDirty(state),
    backupFailed: state.backupFailed,
    inputProblem: inputProblem !== undefined,
    idle,
    retryButtonRef,
    onRetry: retryFailed,
  };
  const bodyBytes = inputCheckOf(state.draft).bodyBytes;

  return (
    <RailLayout
      rail={
        <EditorRail
          state={state}
          outline={outline}
          pendingDelete={pendingDelete}
          resolveAttachmentUrl={attachmentUrl}
          onJump={(offset) => editor.current?.jumpTo(offset)}
          onRestoreRevision={(revision) => session.restoreRevision(revision)}
          onDelete={() => void handleDelete()}
        />
      }
    >
      <article
        ref={article}
        className={leaving ? "note note-leaving" : "note"}
        // title 欄は CodeMirror の入力欄で、見出しのように参照できない。aria-labelledby で指すと入力欄の
        // aria-label（「タイトル」）が名前になってしまうので、見えている title の文字を直接渡す。
        // title が空の間（作る前のページなど）は名前を付けない
        aria-label={(state.titleInput ?? state.draft.title) || undefined}
        aria-busy={leaving || undefined}
      >
        {linkPending !== null && (
          <span className="visually-hidden" role="status">
            {leaving ? `「${linkPending}」へ移動中…` : ""}
          </span>
        )}
        <p ref={saveStateEl} className={`save-state save-state-${status}`}>
          <span className="dot" aria-hidden="true" />
          {STATUS_LABELS[status]}
        </p>
        <span className="visually-hidden" role="status">
          {SPOKEN_BY_NOTICE.has(status) ? "" : STATUS_LABELS[status]}
        </span>

        <KeptBackupNotice
          backup={state.pendingBackup}
          onRestore={() => resolveKept(() => session.restoreBackup())}
          onDiscard={() => resolveKept(() => session.discardBackup())}
        />

        <AuthLostNotice
          authLost={state.authLost}
          dirty={isDirty(state)}
          uncreated={uncreated}
          backupFailed={state.backupFailed}
          onRetry={() => void session.retry()}
        />

        <GoneNotice
          gone={state.gone}
          dirty={isDirty(state)}
          backupFailed={state.backupFailed}
          deletedKept={state.deletedKept}
        />

        {/* 再送を待つ間の focus の置き場。進行の通知は上端の保存の状態が見えていると出ず、再び失敗した後も
            ボタンが押せるようになるまで置き場が要るので、通知とは別に置く。中身を空にするのは、保存の状態や
            削除の表示が読み上げる内容を、focus で重ねて読ませないため */}
        {afterFailure && state.busy !== null && (
          <span ref={waitAnchorEl} className="visually-hidden" tabIndex={-1} />
        )}
        {progress !== null ? (
          // 進行は上端の保存の状態や公開と削除の表示がすでに読み上げるので、ここでは読み上げない。
          // key を失敗の通知と分け、再び失敗したときに alert を新しく挿入して確実に読み上げさせる
          <Notice key="progress" tone="info" title={progress} silent />
        ) : (
          <FailureNotice key="failure" op={failure} {...failureNoticeProps} />
        )}

        {state.conflict !== null && (
          <ConflictPanel
            server={state.conflict}
            local={state.draft}
            busy={!idle}
            onOverwrite={() => void resolveConflict(() => session.overwrite())}
            onTakeServer={() => void resolveConflict(() => session.takeServer())}
          />
        )}

        <LinkNotice notice={linkNotice} onClose={() => setLinkNotice(null)} />

        <UnsafeTitleNotice
          unsafeTitle={unsafeTitle}
          savedTitle={savedTitle}
          onClose={() => setUnsafeTitle(null)}
        />

        <UploadNotices notices={uploadNotices} onClose={() => setUploadNotices([])} />

        <div className="title-row">
          <TitleEditor
            ref={titleEditor}
            value={state.titleInput ?? state.draft.title}
            readOnly={readOnly}
            autoFocus={focusTarget === "title"}
            keptTitle={uncreated ? "" : state.draft.title}
            saveHeldBack={holdsBack(state)}
            bodyView={() => editor.current?.view() ?? null}
            onChange={(title) => session.editTitle(title)}
            onCommit={() => void session.commitTitle()}
            onBlur={() => void session.commitTitle()}
          />
          {/* 作る前は公開範囲を持たない。title を確定して作った後に出す */}
          {!uncreated && (
            <VisibilityControl
              visibility={savedVisibility}
              disabled={!canChangeVisibility(state, status) || state.pendingBackup !== null}
              externalBases={state.externalBases}
              pending={pendingVisibility}
              onChange={changeVisibility}
              findLinkedDrafts={findDrafts}
            />
          )}
        </div>
        {/* 通知はドックへ重なるので、JSX の位置は表示位置を決めない。作成は title の確定で起きるので、title の後に置く */}
        <FailureNotice op={createFailure} {...failureNoticeProps} />
        <InputProblemNotice
          problems={inputProblems}
          backupFailed={state.backupFailed}
          onSelectNul={() => editor.current?.selectFirstNul()}
        />
        <span className="visually-hidden" role="status">
          {inputProblem === undefined ? "" : inputProblemTitle(inputProblem)}
        </span>
        <InlineOutline items={outline} onJump={(offset) => editor.current?.jumpTo(offset)} />
        <BodyEditor
          ref={editor}
          value={state.draft.body}
          readOnly={readOnly}
          autoFocus={focusTarget === "body"}
          pageIndex={titleIndex}
          linkTargets={linkTargets}
          links={links}
          markDraftLinks={savedVisibility === "public" && !uncreated}
          resolveAttachmentUrl={attachmentUrl}
          {...(attachments ? { onUploadAttachment: upload, acceptAttachment } : {})}
          onWikiLinkClick={(link) => void handleWikiLinkClick(link)}
          onTagClick={openTag}
          onChange={(body) => session.edit({ ...session.getState().draft, body })}
          onBlur={() => void session.flush()}
        />
        {bodyBytes >= MAX_BODY_BYTES * METER_SHOW_RATIO && (
          <p className="body-meter">
            <InputMeter label="本文の長さ" bytes={bodyBytes} max={MAX_BODY_BYTES} />
          </p>
        )}
      </article>
    </RailLayout>
  );
}
