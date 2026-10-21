import type { PageInputProblem } from "@personal-wiki/domain/page-input";
import { wikiLinkUnsafeChars } from "@personal-wiki/domain/title";
import type { ReactNode, Ref } from "react";
import { loginHref } from "./api";
import type { UploadNotice } from "./attachments";
import type { Backup } from "./draft-backup";
import type { FailedOp, WriteRejection } from "./editor-session";
import { formatTime } from "./format";
import { inputProblemMessage, inputProblemTitle } from "./input-messages";
import { Link } from "./Link";
import { Notice } from "./Notice";
import { openNewPage } from "./new-page";
import { homeHref, navigate, pageHrefFor } from "./route";

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
 * 文末を「残します」と「残してあります」で分けるのはそのためで、利用者が時制の違いを不具合と読まないよう、
 * held の文には退避を書く時機を入れる。
 */
const keptContent = (backupFailed: boolean, held = false) =>
  backupFailed
    ? "入力した内容は、この画面にしか残っていません。再読み込みや画面の移動をする前に、内容をコピーしてください。"
    : held
      ? "入力した内容は、打つのが止まってからこの端末に残します。"
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

type WriteOp = Extract<FailedOp, { kind: "create" | "save" }>;

const isWrite = (op: FailedOp): op is WriteOp => op.kind === "create" || op.kind === "save";

/** サーバーが入力のエラーで拒んでも、手元の検査が同じ問題を見つけていれば、その通知に任せる */
const coveredByCheck = (op: FailedOp, inputProblem: boolean) =>
  isWrite(op) && op.input === true && inputProblem;

/**
 * 重複と入力のエラーは、同じ内容を送り直しても同じレスポンスになるので、再試行を出さない。手元の内容が
 * 規則に合わない間も、再試行は送らずに止まるので出さない
 */
const retryable = (op: FailedOp, inputProblem: boolean) =>
  !(isWrite(op) && (op.titleTaken || op.input || inputProblem));

function failureTitle(op: FailedOp, keptShown: boolean, backupFailed: boolean): string {
  if (!isWrite(op)) return FAILURE_TITLES[op.kind];
  if (keptShown && backupFailed) return UNKEPT_TITLES[op.kind];
  return op.titleTaken ? TAKEN_TITLES[op.kind] : FAILURE_TITLES[op.kind];
}

interface FailureNoticeProps {
  /** 通知に出す失敗。null なら何も出さない */
  op: FailedOp | null;
  error: string | null;
  dirty: boolean;
  backupFailed: boolean;
  /** 手元の検査が入力の問題を見つけている */
  inputProblem: boolean;
  idle: boolean;
  /** 再送のボタンの出入りで focus を戻す判断に使う。親が持つ */
  retryButtonRef: Ref<HTMLButtonElement>;
  onRetry: (op: FailedOp) => Promise<void>;
}

/** Notice は actions が undefined のときだけ操作の行を省くので、操作が無いときは undefined を返す */
function failureActions({
  op,
  inputProblem,
  idle,
  retryButtonRef,
  onRetry,
}: FailureNoticeProps & { op: FailedOp }): ReactNode {
  const existing = isWrite(op) ? op.titleTaken?.existing : undefined;
  if (existing)
    return (
      <Link className="button button-main" href={pageHrefFor(existing)}>
        そのページを開く
      </Link>
    );
  if (!retryable(op, inputProblem)) return undefined;
  return (
    <button
      type="button"
      className="button button-main"
      ref={retryButtonRef}
      disabled={!idle}
      onClick={() => void onRetry(op)}
    >
      {retryLabel(op)}
    </button>
  );
}

/** 作成、保存、公開範囲の変更、削除の失敗の通知。 */
export function FailureNotice(props: FailureNoticeProps) {
  const { op, error, dirty, backupFailed, inputProblem } = props;
  if (op === null || coveredByCheck(op, inputProblem)) return null;
  const keptShown = op.kind === "create" || (op.kind === "save" && dirty);
  return (
    <Notice
      tone="error"
      title={failureTitle(op, keptShown, backupFailed)}
      actions={failureActions({ ...props, op })}
    >
      <WithKeptContent show={keptShown} backupFailed={backupFailed}>
        {isWrite(op) && op.titleTaken ? (
          <TakenGuide taken={op.titleTaken} kind={op.kind} />
        ) : (
          <p>{error}</p>
        )}
      </WithKeptContent>
    </Notice>
  );
}

/** 前回、保存できなかった内容（端末の退避）を、戻すか破棄するかを選ばせる通知。 */
export function KeptBackupNotice({
  backup,
  onRestore,
  onDiscard,
}: {
  backup: Backup | null;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  if (backup === null) return null;
  const deleted = backup.deletedFrom !== undefined;
  return (
    <Notice
      tone="warn"
      // 通知が重なると本文は畳まれ、見出しだけが残る。どのページの内容かは見出しで分かるようにする
      title={
        deleted
          ? "削除されたページで保存できなかった内容があります"
          : "前回、保存できなかった内容があります"
      }
      // 復元か破棄を選ぶまで入力欄は読み取り専用で、選ぶ操作はこの通知の中にしか無い。
      // 新規ページでは title の autoFocus が先に focus を持つので、打鍵の guard で移らない
      claimFocus
      actions={
        <>
          <button type="button" className="button button-main" onClick={onRestore}>
            {deleted ? "新しいページとして作る" : "残った内容に戻す"}
          </button>
          <button type="button" className="button" onClick={onDiscard}>
            残った内容を破棄する
          </button>
        </>
      }
    >
      {deleted ? (
        // 文字列を 1 つにするのは、JSX の改行が文の間に半角の空白を入れるため
        <p>
          {`この端末に残っている「${backup.title}」の内容（${formatTime(backup.savedAt)}）から、新しいページを作れます。`}
        </p>
      ) : (
        <p>
          {backup.createFailed
            ? `作成できなかったページ「${backup.title}」の内容が、この端末に残っています（`
            : "保存できなかった内容が、この端末に残っています（"}
          {formatTime(backup.savedAt)}
          ）。戻すか破棄すると、編集を続けられます。
        </p>
      )}
    </Notice>
  );
}

/** 変更が無いときの retry() は通知を下ろすだけで、保存も作成もしない */
const authRetryLabel = (dirty: boolean, uncreated: boolean) =>
  !dirty ? "閉じる" : uncreated ? "もう一度作成する" : "もう一度保存する";

/** ログインの期限切れ（401）の通知。 */
export function AuthLostNotice({
  authLost,
  dirty,
  uncreated,
  backupFailed,
  onRetry,
}: {
  authLost: boolean;
  dirty: boolean;
  uncreated: boolean;
  backupFailed: boolean;
  onRetry: () => void;
}) {
  if (!authLost) return null;
  const label = authRetryLabel(dirty, uncreated);
  return (
    <Notice
      tone="warn"
      title={
        dirty && backupFailed
          ? "ログインの期限が切れ、内容をこの端末に残せませんでした"
          : "ログインの期限が切れました"
      }
      claimFocus
      actions={
        <>
          <a className="button button-main" href={loginHref(window.location)}>
            ログインし直す
          </a>
          <button type="button" className="button" onClick={onRetry}>
            {label}
          </button>
        </>
      }
    >
      <p>
        {dirty
          ? backupFailed
            ? `「ログインし直す」で画面を移ると、入力した内容は消えます。先に内容をコピーするか、別のタブでログインし直してから「${label}」を押してください。`
            : `未保存の内容は、この端末に残してあります。ログインし直してこのページに戻ると、その内容を戻せます。別のタブでログインし直したときは、「${label}」を押してください。`
          : "未保存の変更はありません。ログインし直してください。"}
      </p>
    </Notice>
  );
}

/**
 * 本文のリンクをクリックしても開けなかったときの案内。無いページは title の URL の空のページへ移るので、
 * missing は title の URL を作れない title（予約語、長すぎる title など）だけに出す。
 */
export type LinkNoticeState = { kind: "missing"; title: string } | { kind: "error" };

export function LinkNotice({
  notice,
  onClose,
}: {
  notice: LinkNoticeState | null;
  onClose: () => void;
}) {
  if (notice === null) return null;
  if (notice.kind === "error")
    return (
      <Notice
        tone="warn"
        title="リンク先を調べられませんでした"
        actions={
          <button type="button" className="button" onClick={onClose}>
            閉じる
          </button>
        }
      >
        <p>もう一度リンクを押してください。</p>
      </Notice>
    );
  return (
    // 作成へ進める案内なので info。行き止まりになる PageReader の同じ通知は warn
    <Notice
      tone="info"
      title={`「${notice.title}」のページはまだありません`}
      actions={
        <>
          <button
            type="button"
            className="button button-main"
            // このページの未保存の変更は、離れるときの leave が送る
            onClick={() => openNewPage({ title: notice.title })}
          >
            このタイトルで作成
          </button>
          <button type="button" className="button" onClick={onClose}>
            閉じる
          </button>
        </>
      }
    />
  );
}

/** 保存した title が [[ ]] に書けない文字を含み、他のページのリンクを書き換えられなかったときの通知。 */
export function UnsafeTitleNotice({
  unsafeTitle,
  savedTitle,
  onClose,
}: {
  /** リンクに書けないと知らされた title */
  unsafeTitle: string | null;
  savedTitle: string;
  onClose: () => void;
}) {
  if (unsafeTitle === null || unsafeTitle !== savedTitle) return null;
  return (
    <Notice
      tone="warn"
      title="他のページのリンクは自動では書き換わりません"
      actions={
        <button type="button" className="button" onClick={onClose}>
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
  );
}

/** 添付のアップロードの失敗をまとめて出す通知。 */
export function UploadNotices({
  notices,
  onClose,
}: {
  notices: readonly UploadNotice[];
  onClose: () => void;
}) {
  if (notices.length === 0) return null;
  return (
    <Notice
      tone="warn"
      title="画像を添付できませんでした"
      actions={
        <>
          {notices.some(({ kind }) => kind === "unauthorized" || kind === "forbidden") && (
            <a className="button button-main" href={loginHref(window.location)}>
              ログインし直す
            </a>
          )}
          <button type="button" className="button" onClick={onClose}>
            閉じる
          </button>
        </>
      }
    >
      {notices.map(({ message }) => (
        <p key={message}>{message}</p>
      ))}
    </Notice>
  );
}

/** 手元の検査で見つけた、このままでは保存で拒まれる入力の問題の通知。 */
export function InputProblemNotice({
  problems,
  backupFailed,
  onSelectNul,
}: {
  problems: readonly PageInputProblem[];
  backupFailed: boolean;
  onSelectNul: () => void;
}) {
  const problem = problems[0];
  if (problem === undefined) return null;
  const nulInBody = problem.reason === "control_char" && problem.field === "body";
  return (
    // 数は打つたびに変わり、読み上げると打つたびに読み直されるので、通知は読み上げない。
    // 原因と保存できないことは、PageEditor の見えない status が inputProblemTitle で伝える。
    // 上端の保存の状態は、この間は読み上げない
    <Notice
      tone="error"
      title={inputProblemTitle(problem)}
      silent
      actions={
        nulInBody ? (
          <button type="button" className="button button-main" onClick={onSelectNul}>
            その文字を選択する
          </button>
        ) : undefined
      }
    >
      <WithKeptContent show backupFailed={backupFailed} held>
        {problems.map((p) => (
          <p key={p.reason + (p.reason === "control_char" ? p.field : "")}>
            {inputProblemMessage(p)}
          </p>
        ))}
      </WithKeptContent>
    </Notice>
  );
}

/** 別の場所でページが削除されたときの通知。 */
export function GoneNotice({
  gone,
  dirty,
  backupFailed,
  deletedKept,
}: {
  gone: boolean;
  dirty: boolean;
  backupFailed: boolean;
  deletedKept: boolean;
}) {
  if (!gone) return null;
  const unkept = dirty && backupFailed;
  // 退避できなかった内容は画面にしか無く、新規作成の画面へ移っても戻らないので案内しない
  const recreatable = deletedKept && !unkept;
  return (
    <Notice
      tone="error"
      title={
        unkept
          ? "このページは削除され、内容をこの端末に残せませんでした"
          : "このページは削除されました"
      }
      actions={
        <>
          {recreatable && (
            <button type="button" className="button button-main" onClick={() => openNewPage()}>
              新しいページとして作る
            </button>
          )}
          <a
            className={recreatable ? "button" : "button button-main"}
            href={homeHref()}
            onClick={(event) => {
              event.preventDefault();
              navigate(homeHref());
            }}
          >
            一覧へ戻る
          </a>
        </>
      }
    >
      <p>
        別の場所で削除されたため、編集できません。
        {unkept
          ? "入力した内容は、この画面にしか残っていません。画面を離れる前に、内容をコピーしてください。"
          : deletedKept
            ? "保存できなかった内容は、この端末に残してあります。新しいページとして作り直せます。"
            : ""}
      </p>
    </Notice>
  );
}
