import type { ReactNode, Ref } from "react";
import type { FailedOp, WriteRejection } from "./editor-session";
import { Link } from "./Link";
import { Notice } from "./Notice";
import { pageHrefFor } from "./route";

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
export function WithKeptContent({
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
