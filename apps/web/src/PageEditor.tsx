import { MAX_BODY_BYTES } from "@personal-wiki/domain/page-input";
import { wikiLinkUnsafeChars } from "@personal-wiki/domain/title";
import type { UploadAttachment, WikiLinkClick } from "@personal-wiki/editor";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
  holdsBack,
  inputCheckOf,
  inputProblemsOf,
  isDirty,
  isReadOnly,
  type SaveStatus,
  saveStatusOf,
  type WriteRejection,
} from "./editor-session";
import { formatTime } from "./format";
import { extractOutline } from "./heading-outline";
import { InputMeter, METER_SHOW_RATIO } from "./InputMeter";
import { isInView } from "./in-view";
import { inputProblemMessage, inputProblemTitle } from "./input-messages";
import { Link } from "./Link";
import { useDelayedWhile } from "./Loading";
import { linkRewrites } from "./link-rewrites";
import { createLinkTargetSource, createTitleIndex } from "./link-sources";
import { findLinkedDrafts } from "./linked-drafts";
import { Notice } from "./Notice";
import { openNewPage, registerNewPageScreen } from "./new-page";
import { InlineOutline, Outline } from "./Outline";
import { PublishBar } from "./PublishBar";
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
import { RailLayout, RailSection } from "./Rail";
import { RevisionHistory } from "./RevisionHistory";
import { homeHref, missingPagePath, navigate, openTag, pageHrefFor } from "./route";
import { TitleEditor, type TitleEditorHandle } from "./TitleEditor";
import { useFragmentJump } from "./use-fragment-jump";
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
  "auth",
  "gone",
]);

const FAILURE_TITLES: Record<FailedOp["kind"], string> = {
  create: "作成できませんでした",
  save: "保存できませんでした",
  visibility: "公開範囲を変更できませんでした",
  delete: "削除できませんでした",
};

/**
 * 保存や作成が失敗しても、打った内容は画面に残り、session が端末にも退避する（editor-session の stashIfDirty）。
 * 退避は容量超過や private window で書けないことがあり、そのときは画面を閉じると内容が失われる。
 * 送らずに止めた入力（held）の退避は、打つのが止まってから書くので、通知を出した時点ではまだ無い。
 */
const keptContent = (backupFailed: boolean, held = false) =>
  backupFailed
    ? "入力した内容は、この画面にしか残っていません。再読み込みや画面の移動をする前に、内容をコピーしてください。"
    : held
      ? "入力した内容は、この端末に残します。"
      : "入力した内容は、この端末に残してあります。";

/**
 * 失敗の理由の段落に、内容の扱いの段落を添える。内容が画面にしか無いときは先に出す。
 * 理由が「再読み込みしてから…」のように読み込み直しを促すことがあり、先に読むと内容を失うため。
 */
function WithKeptContent({
  show,
  backupFailed,
  held = false,
  children,
}: {
  show: boolean;
  backupFailed: boolean;
  held?: boolean;
  children: ReactNode;
}) {
  const kept = show && <p>{keptContent(backupFailed, held)}</p>;
  return (
    <>
      {backupFailed && kept}
      {children}
      {!backupFailed && kept}
    </>
  );
}

/**
 * 退避が書けなかったときは、見出しに内容を失う恐れを入れる。通知を畳むと本文の段落は隠れ、
 * 見出しだけが残るので、失う恐れが見出しに無いと畳んだまま見落とす。
 */
const UNKEPT_TITLES = {
  create: "作成できず、内容をこの端末に残せませんでした",
  save: "保存できず、内容をこの端末に残せませんでした",
};

/**
 * title の重複で拒まれたときの見出し。重複はもう一度送っても同じレスポンスになるので、通信の失敗と分けて
 * 直し方の分かる見出しにする。
 */
const TAKEN_TITLES = {
  create: "同じタイトルのページがあるため、作成できません",
  save: "同じタイトルのページがあるため、保存できません",
};

/** 失敗の後の操作が終わるまでの間、失敗の通知に代えてドックに出す見出し。 */
const PROGRESS_TITLES = {
  saving: "保存中…",
  visibility: "公開範囲を変更中…",
  deleting: "削除中…",
  restoring: "版を戻し中…",
} as const;

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

/**
 * 重複と言われた title の直し方。サーバーは大文字と小文字などの違いを同じ title とみなすので、
 * 見た目の違う title と重なったときはその規則を添える。
 */
function TakenGuide({
  taken,
  kind,
}: {
  taken: NonNullable<WriteRejection["titleTaken"]>;
  kind: "create" | "save";
}) {
  const { existing } = taken;
  return (
    <p>
      {existing !== undefined &&
        existing.title !== taken.title &&
        `「${existing.title}」と同じタイトルとみなします。大文字と小文字、全角と半角、_ と空白は区別しません。`}
      {kind === "create"
        ? "タイトルを変えて欄を離れると、作成します。"
        : "タイトルを変えて欄を離れると、保存します。"}
    </p>
  );
}

/** 同時に出す添付の失敗の数。まとめて貼った画像が全部失敗しても、画面を埋めない */
const MAX_UPLOAD_NOTICES = 5;

/**
 * 本文のリンクをクリックしても開けなかったときの案内。無いページは title の URL の空のページへ移るので、
 * missing は title の URL を作れない title（予約語、長すぎる title など）だけに出す。
 */
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
  // 押したボタンは解決で消えるので、focus が body に落ちないよう移す。解決の間にサーバーの版がまた進むと
  // 衝突の通知が残るので、そのときは動かさない。移す先は本文だが、タッチ端末では本文に移すと、確認の操作で閉じたキーボードが
  // 開き直り、カーソルの行へスクロールして title が見える範囲から外れる。そこではキーボードを開かない
  // ページの枠に移し、スクロールの位置も動かさない。枠に tabindex を付けるのは focus を持つ間だけにする。
  // 付けたままだと、本文の編集中に枠の余白を押しただけで枠が focus を取り、本文の入力が途切れる
  async function resolveConflict(resolve: () => void | Promise<void>) {
    await resolve();
    if (session.getState().conflict !== null) return;
    const frame = article.current;
    if (frame !== null && window.matchMedia("(pointer: coarse)").matches) {
      frame.tabIndex = -1;
      frame.addEventListener("blur", () => frame.removeAttribute("tabindex"), { once: true });
      frame.focus({ preventScroll: true });
    } else editor.current?.view()?.focus();
  }
  const status = saveStatusOf(state);
  const readOnly = isReadOnly(state);
  const idle = state.busy === null;
  const deleting = state.busy === "deleting";
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

  async function handleDelete() {
    const warning = isDirty(state) ? "未保存の変更も含めて、元に戻せません。" : "元に戻せません。";
    if (!window.confirm(`「${state.base.title}」を削除しますか？${warning}`)) return;
    if (await session.remove()) navigate(homeHref());
  }

  // 失敗の後に操作を始めると session は失敗の記録を消すので、通知も消える。保存の状態の表示はページの上端に
  // あり、下までスクロールしていると進んでいる手応えが無いため、終わるまで同じ場所に進行の通知を残す。
  // 「もう一度保存する」を押す前に本文の blur が保存を始めると、ボタンが消えて押せないので、押したかどうかでなく
  // 失敗の通知が出ていたかどうかで決める
  const failure =
    state.error !== null && state.failedOp !== null && state.failedOp.kind !== "create"
      ? state.failedOp
      : null;
  const [afterFailure, setAfterFailure] = useState(false);
  if (failure !== null && !afterFailure) setAfterFailure(true);
  else if (afterFailure && failure === null && state.busy === null) setAfterFailure(false);
  // 衝突、ログイン切れ、ページの消失は、操作の途中（busy が外れる前）に決まりうる。その通知と進行を並べない
  const inProgress =
    afterFailure &&
    failure === null &&
    state.busy !== null &&
    state.busy !== "creating" &&
    state.conflict === null &&
    !state.authLost &&
    !state.gone
      ? state.busy
      : null;
  // 保存の進行は、ページの上端の保存の状態（.save-state）が見えている間はそちらが伝えるので、ドックには出さない。
  // ドックの通知は、下までスクロールして上端が見えないときの手応えのためにある。保存の間は測り直す
  const saveStateEl = useRef<HTMLParagraphElement>(null);
  const [topVisible, setTopVisible] = useState(false);
  const watchTop = inProgress === "saving";
  useLayoutEffect(() => {
    const element = saveStateEl.current;
    if (!watchTop || element === null) return;
    const measure = () => setTopVisible(isInView(element));
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    // iOS はキーボードや拡大の間のパンで visualViewport だけを動かし、window の scroll を出さないことがある
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
    };
  }, [watchTop]);
  const progress =
    inProgress !== null && !(watchTop && topVisible) ? PROGRESS_TITLES[inProgress] : null;

  // 削除の再試行は確認を挟まない。ボタン自体が「もう一度削除する」と明示している
  async function retryFailed(op: FailedOp | null) {
    if (op === null) return;
    if (op.kind === "create") await session.retryCreate();
    else if (op.kind === "save") await session.flush();
    else if (op.kind === "visibility") await changeVisibility(op.to);
    else if (await session.remove()) navigate(homeHref());
  }

  const goneUnkept = state.gone && isDirty(state) && state.backupFailed;

  // 保存済みのままの内容は送らないので、問題があっても手を付けるまでは知らせない
  const inputProblems = uncreated || isDirty(state) ? inputProblemsOf(state.draft) : [];
  const inputProblem = inputProblems[0];
  // サーバーが入力のエラーで拒んでも、手元の検査が同じ問題を見つけていれば、その通知に任せる
  const coveredByCheck = (op: FailedOp) =>
    (op.kind === "create" || op.kind === "save") && op.input === true && inputProblem !== undefined;
  // 重複と入力のエラーは、同じ内容を送り直しても同じレスポンスになるので、再試行を出さない。手元の内容が
  // 規則に合わない間も、再試行は送らずに止まるので出さない
  const retryable = (op: FailedOp) =>
    !(
      (op.kind === "create" || op.kind === "save") &&
      (op.titleTaken || op.input || inputProblem !== undefined)
    );
  // 変更が無いときの retry() は通知を下ろすだけで、保存も作成もしない
  const authRetryLabel = !isDirty(state)
    ? "閉じる"
    : uncreated
      ? "もう一度作成する"
      : "もう一度保存する";
  const bodyBytes = inputCheckOf(state.draft).bodyBytes;
  const nulInBody = inputProblem?.reason === "control_char" && inputProblem.field === "body";

  const rail = (
    <>
      <Outline items={outline} onJump={(offset) => editor.current?.jumpTo(offset)} />
      {!uncreated && <Backlinks target={{ pageId }} />}
      {!uncreated && (
        <RailSection title="情報">
          <dl className="facts">
            <dt>更新</dt>
            <dd>{formatTime(state.base.updatedAt)}</dd>
            <dt>作成</dt>
            <dd>{formatTime(state.base.createdAt)}</dd>
          </dl>
        </RailSection>
      )}
      {!uncreated && (
        <RevisionHistory
          pageId={pageId}
          pageVersion={state.base.version}
          updatedAt={state.base.updatedAt}
          paused={state.gone}
          resolveAttachmentUrl={attachmentUrl}
          canRestore={!readOnly && !state.authLost && !deleting}
          onRestore={(revision) => session.restoreRevision(revision)}
        />
      )}
      {/* 作る前のページには消す対象が無い。押せない操作を置かない */}
      {!uncreated && (
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
            {deleting ? "削除中…" : "このページを削除"}
          </button>
          <span className="visually-hidden" role="status">
            {deleting ? "削除中…" : ""}
          </span>
        </div>
      )}
    </>
  );

  return (
    <RailLayout rail={rail}>
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

        {state.pendingBackup !== null && (
          <Notice
            tone="warn"
            // 通知が重なると本文は畳まれ、見出しだけが残る。どのページの内容かは見出しで分かるようにする
            title={
              state.pendingBackup.deletedFrom !== undefined
                ? "削除されたページで保存できなかった内容があります"
                : "前回、保存できなかった内容があります"
            }
            actions={
              <>
                <button
                  type="button"
                  className="button button-main"
                  onClick={() => session.restoreBackup()}
                >
                  {state.pendingBackup.deletedFrom !== undefined
                    ? "新しいページとして作る"
                    : "残った内容に戻す"}
                </button>
                <button type="button" className="button" onClick={() => session.discardBackup()}>
                  残った内容を破棄する
                </button>
              </>
            }
          >
            {state.pendingBackup.deletedFrom !== undefined ? (
              // 文字列を 1 つにするのは、JSX の改行が文の間に半角の空白を入れるため
              <p>
                {`この端末に残っている「${state.pendingBackup.title}」の内容（${formatTime(state.pendingBackup.savedAt)}）から、新しいページを作れます。`}
              </p>
            ) : (
              <p>
                {state.pendingBackup.createFailed
                  ? `作成できなかったページ「${state.pendingBackup.title}」の内容が、この端末に残っています（`
                  : "保存できなかった内容が、この端末に残っています（"}
                {formatTime(state.pendingBackup.savedAt)}
                ）。戻すか破棄すると、編集を続けられます。
              </p>
            )}
          </Notice>
        )}

        {state.authLost && (
          <Notice
            tone="warn"
            title={
              isDirty(state) && state.backupFailed
                ? "ログインの期限が切れ、内容をこの端末に残せませんでした"
                : "ログインの期限が切れました"
            }
            claimFocus
            actions={
              <>
                <a className="button button-main" href={loginHref(window.location)}>
                  ログインし直す
                </a>
                <button type="button" className="button" onClick={() => void session.retry()}>
                  {authRetryLabel}
                </button>
              </>
            }
          >
            <p>
              {isDirty(state)
                ? state.backupFailed
                  ? `「ログインし直す」で画面を移ると、入力した内容は消えます。先に内容をコピーするか、別のタブでログインし直してから「${authRetryLabel}」を押してください。`
                  : `未保存の内容は、この端末に残してあります。ログインし直してこのページに戻ると、その内容を戻せます。別のタブでログインし直したときは、「${authRetryLabel}」を押してください。`
                : "未保存の変更はありません。ログインし直してください。"}
            </p>
          </Notice>
        )}

        {state.gone && (
          <Notice
            tone="error"
            title={
              goneUnkept
                ? "このページは削除され、内容をこの端末に残せませんでした"
                : "このページは削除されました"
            }
            actions={
              <>
                {/* 退避できなかった内容は画面にしか無く、新規作成の画面へ移っても戻らないので案内しない */}
                {state.deletedKept && !goneUnkept && (
                  <button
                    type="button"
                    className="button button-main"
                    onClick={() => openNewPage()}
                  >
                    新しいページとして作る
                  </button>
                )}
                <a
                  className={state.deletedKept && !goneUnkept ? "button" : "button button-main"}
                  href={homeHref()}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(homeHref());
                  }}
                >
                  最近の更新へ戻る
                </a>
              </>
            }
          >
            <p>
              別の場所で削除されたため、編集できません。
              {goneUnkept
                ? "入力した内容は、この画面にしか残っていません。画面を離れる前に、内容をコピーしてください。"
                : state.deletedKept
                  ? "保存できなかった内容は、この端末に残してあります。新しいページとして作り直せます。"
                  : ""}
            </p>
          </Notice>
        )}

        {progress !== null ? (
          // 進行は上端の保存の状態や公開と削除の表示がすでに読み上げるので、ここでは読み上げない。
          // key を失敗の通知と分け、再び失敗したときに alert を新しく挿入して確実に読み上げさせる
          <Notice key="progress" tone="info" title={progress} silent />
        ) : (
          failure !== null &&
          !coveredByCheck(failure) && (
            <Notice
              key="failure"
              tone="error"
              title={
                failure.kind === "save" && isDirty(state) && state.backupFailed
                  ? UNKEPT_TITLES.save
                  : failure.kind === "save" && failure.titleTaken
                    ? TAKEN_TITLES.save
                    : FAILURE_TITLES[failure.kind]
              }
              actions={
                failure.kind === "save" && failure.titleTaken?.existing ? (
                  <Link
                    className="button button-main"
                    href={pageHrefFor(failure.titleTaken.existing)}
                  >
                    そのページを開く
                  </Link>
                ) : retryable(failure) ? (
                  <button
                    type="button"
                    className="button button-main"
                    disabled={!idle}
                    onClick={() => void retryFailed(failure)}
                  >
                    {retryLabel(failure)}
                  </button>
                ) : undefined
              }
            >
              <WithKeptContent
                show={failure.kind === "save" && isDirty(state)}
                backupFailed={state.backupFailed}
              >
                {failure.kind === "save" && failure.titleTaken ? (
                  <TakenGuide taken={failure.titleTaken} kind="save" />
                ) : (
                  <p>{state.error}</p>
                )}
              </WithKeptContent>
            </Notice>
          )
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
            // 作成へ進める案内なので info。行き止まりになる PageReader の同じ通知は warn
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
                    このタイトルで作成
                  </button>
                  <button type="button" className="button" onClick={() => setLinkNotice(null)}>
                    閉じる
                  </button>
                </>
              }
            />
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
            <p>
              {`${wikiLinkUnsafeChars(savedTitle)
                .map((ch) => `「${ch}」`)
                .join(
                  "",
                )}を含むタイトルには [[ ]] でリンクできないため、旧タイトルへのリンクは、このページを指さなくなりました。`}
            </p>
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
          keptTitle={uncreated ? "" : state.draft.title}
          saveHeldBack={holdsBack(state)}
          bodyView={() => editor.current?.view() ?? null}
          onChange={(title) => session.editTitle(title)}
          onCommit={() => void session.commitTitle()}
          onBlur={() => void session.commitTitle()}
        />
        {/* 通知はドックへ重なるので、JSX の位置は表示位置を決めない。作成は title の確定で起きるので、title の後に置く */}
        {state.error !== null &&
          state.failedOp?.kind === "create" &&
          !coveredByCheck(state.failedOp) && (
            <Notice
              tone="error"
              title={
                state.backupFailed
                  ? UNKEPT_TITLES.create
                  : state.failedOp.titleTaken
                    ? TAKEN_TITLES.create
                    : FAILURE_TITLES.create
              }
              actions={
                state.failedOp.titleTaken?.existing ? (
                  <Link
                    className="button button-main"
                    href={pageHrefFor(state.failedOp.titleTaken.existing)}
                  >
                    そのページを開く
                  </Link>
                ) : retryable(state.failedOp) ? (
                  <button
                    type="button"
                    className="button button-main"
                    disabled={!idle}
                    onClick={() => void retryFailed(state.failedOp)}
                  >
                    {retryLabel(state.failedOp)}
                  </button>
                ) : undefined
              }
            >
              <WithKeptContent show backupFailed={state.backupFailed}>
                {state.failedOp.titleTaken ? (
                  <TakenGuide taken={state.failedOp.titleTaken} kind="create" />
                ) : (
                  <p>{state.error}</p>
                )}
              </WithKeptContent>
            </Notice>
          )}
        {inputProblem !== undefined && (
          // 数は打つたびに変わり、読み上げると打つたびに読み直されるので、通知は読み上げない。
          // 原因と保存できないことは、下の見えない status が inputProblemTitle で伝える。
          // 上端の保存の状態は、この間は読み上げない
          <Notice
            key="input"
            tone="error"
            title={inputProblemTitle(inputProblem)}
            silent
            actions={
              nulInBody ? (
                <button
                  type="button"
                  className="button button-main"
                  onClick={() => editor.current?.selectFirstNul()}
                >
                  その文字を選択する
                </button>
              ) : undefined
            }
          >
            <WithKeptContent show backupFailed={state.backupFailed} held>
              {inputProblems.map((problem) => (
                <p key={problem.reason + (problem.reason === "control_char" ? problem.field : "")}>
                  {inputProblemMessage(problem)}
                </p>
              ))}
            </WithKeptContent>
          </Notice>
        )}
        <span className="visually-hidden" role="status">
          {inputProblem === undefined ? "" : inputProblemTitle(inputProblem)}
        </span>
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
          pending={pendingVisibility}
          onChange={changeVisibility}
          findLinkedDrafts={findDrafts}
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
