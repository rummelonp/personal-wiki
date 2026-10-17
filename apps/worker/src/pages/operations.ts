import {
  type CharAt,
  MAX_BODY_BYTES,
  MAX_TITLE_BYTES,
  singleLineTitle,
} from "@personal-wiki/domain";
import { type Principal, readableVisibilityOf } from "../auth/principal";
import { isPageId } from "./id";
import {
  type LinkRewriteStepInput,
  type LinkRewriteStepResult,
  stepLinkRewrites,
} from "./link-rewrites";
import { findRestoreSource } from "./revision-history";
import { actorOf } from "./revisions";
import {
  type AppendError,
  appendToPage,
  createPage,
  findPageById,
  findPageByTitle,
  type LinkRewritesQueued,
  type Page,
  setVisibility,
  type UpdateSuccess,
  updatePage,
  type Visibility,
  type WriteError,
  type WriteSuccess,
} from "./store";

/*
 * REST と MCP が共有するページの操作。actor の決定、書き込みの計測、エラーの説明をここに置き、
 * 入口ごとの違いは入力の解析とレスポンスの形だけにする。
 */

/**
 * JSON を解析する前に Content-Length で拒む上限。巨大な JSON の解析で CPU を使い切らないようにする。
 * 正当なリクエストを拒まないよう、title と本文を上限まで入れ、全文字を JSON の最長のエスケープ
 * （制御文字の \u00XX で 1 バイトが 6 バイト）にした大きさに、キーと記号の分を足して決める。
 * Content-Length の無いリクエストは解析後の本文の検査に任せる。
 * REST と MCP の tool 呼び出しは同じ title と本文を運ぶので、同じ上限を使う（JSON-RPC の封筒の分は
 * キーと記号の余裕に収まる）。
 */
export const MAX_REQUEST_BYTES = (MAX_TITLE_BYTES + MAX_BODY_BYTES) * 6 + 1024;

/**
 * 書き込み 1 回分の計測値。D1 の書き込み行数（無料枠 10 万行/日）を保存 1 回あたりで集計し、
 * どの actor がどのページに書いたかを後から追えるようにする。本文は含めない。
 */
export interface WriteMetric {
  op:
    | "create"
    | "update"
    | "restore"
    | "append"
    | "delete"
    | "rebuild"
    | "visibility"
    | "link_rewrite";
  /**
   * revisions.actor と同じ形式。リンクの書き換えで本文を書いたときは revision と同じく rename した
   * actor、キューのジョブを捨てただけのときは呼び出し元（Cron は "cron"）
   */
  actor: string;
  /** 書いたページ。作り直しは 1 回で複数ページを扱いうるので付けない */
  pageId?: string;
  rowsWritten: number;
  /** 追記で版の競合により読み直した場合の試行回数 */
  attempts?: number;
  /** 作り直しとリンクの書き換えで失敗したページの id */
  failed?: string[];
}

export function logWriteMetric(metric: WriteMetric): void {
  console.log(JSON.stringify({ event: "pages.write", ...metric }));
}

export interface PageWriteContext {
  db: D1Database;
  principal: Principal;
  now: () => number;
  recordWrite: (metric: WriteMetric) => void;
}

/** 入力された id でページを引く。id の形式が違えば D1 を引かずに null。 */
export async function findPageByInputId(db: D1Database, id: string): Promise<Page | null> {
  return isPageId(id) ? findPageById(db, id) : null;
}

export async function createPageAs(
  ctx: PageWriteContext,
  input: { title: string; body: string },
): Promise<WriteSuccess | WriteError> {
  const actor = actorOf(ctx.principal);
  const result = await createPage(ctx.db, { ...input, actor, now: ctx.now() });
  if (result.ok) {
    ctx.recordWrite({
      op: "create",
      actor,
      pageId: result.page.id,
      rowsWritten: result.rowsWritten,
    });
    return result;
  }
  return withExisting(ctx, input.title, result);
}

/**
 * title_conflict に、重なった既存のページを添える。呼び出し元はそのページへ追記するか title を
 * 変えるかを、読み直さずに決められる。主体が読める範囲でだけ引くので、read の scope の無い主体に
 * draft の id と title は渡らない。引けない（読めない、競合の後に消えた）ときは添えない。
 */
async function withExisting<E extends WriteError>(
  ctx: PageWriteContext,
  title: string,
  error: E,
  selfId?: string,
): Promise<E> {
  if (error.reason !== "title_conflict") return error;
  const page = await findPageByTitle(
    ctx.db,
    singleLineTitle(title),
    readableVisibilityOf(ctx.principal),
  );
  if (page === null || page.id === selfId) return error;
  return { ...error, existing: { id: page.id, title: page.title, visibility: page.visibility } };
}

/**
 * 更新のレスポンスに足す linkRewrites。書き換えをキューに入れたか、リンクに書けない title でキューに入れなかったときだけ
 * 返し、それ以外の保存ではレスポンスを GET と同じ形のままにする。
 */
export function linkRewritesField({ linkRewrites }: UpdateSuccess): {
  linkRewrites?: LinkRewritesQueued;
} {
  return linkRewrites.queued > 0 || linkRewrites.skipped !== undefined ? { linkRewrites } : {};
}

export async function updatePageAs(
  ctx: PageWriteContext,
  input: { id: string; expectedVersion: number; title: string; body: string },
): Promise<UpdateSuccess | WriteError> {
  if (!isPageId(input.id)) return { ok: false, reason: "not_found" };
  const actor = actorOf(ctx.principal);
  const result = await updatePage(ctx.db, {
    ...input,
    actor,
    now: ctx.now(),
    mergeOwnerSaves: true,
  });
  if (result.ok) {
    ctx.recordWrite({ op: "update", actor, pageId: input.id, rowsWritten: result.rowsWritten });
    return result;
  }
  return withExisting(ctx, input.title, result, input.id);
}

export type RestoreError = WriteError | { ok: false; reason: "revision_not_found" };

/**
 * 過去の版の本文を、今の title のまま新しい版として保存する。戻すのは本文だけで、タグとリンクは保存と
 * 同じく本文から作り直す。
 *
 * owner でも直前の owner の revision にはまとめない。まとめると、戻す直前の本文が入った行が戻した本文で
 * 上書きされ、戻す前の状態に戻れなくなる。戻した後の owner の保存は、戻した revision にまとまる。
 *
 * 本文が今と同じなら書かずに今のページを返す（同じ本文の revision を積まない）。呼び出し元は版が
 * 進んだかで見分ける。
 */
export async function restoreRevisionAs(
  ctx: PageWriteContext,
  input: { id: string; version: number; expectedVersion: number },
): Promise<UpdateSuccess | RestoreError> {
  if (!isPageId(input.id)) return { ok: false, reason: "not_found" };
  const source = await findRestoreSource(ctx.db, input.id, input.version);
  if (!source.ok) {
    return { ok: false, reason: source.reason === "page_not_found" ? "not_found" : source.reason };
  }
  const { page, revisionBody } = source;
  // 書かずに返す場合も、古い版を見て送ったリクエストを成功にしないよう、先に照合する。書く場合の照合は guard が担う
  if (page.version !== input.expectedVersion) {
    return { ok: false, reason: "version_conflict", currentVersion: page.version };
  }
  if (revisionBody === page.body) {
    return { ok: true, page, rowsWritten: 0, linkRewrites: { queued: 0 } };
  }
  const actor = actorOf(ctx.principal);
  const result = await updatePage(ctx.db, {
    id: input.id,
    expectedVersion: input.expectedVersion,
    title: page.title,
    body: revisionBody,
    actor,
    now: ctx.now(),
    mergeOwnerSaves: false,
  });
  if (result.ok) {
    ctx.recordWrite({ op: "restore", actor, pageId: input.id, rowsWritten: result.rowsWritten });
  }
  return result;
}

export async function appendToPageAs(
  ctx: PageWriteContext,
  input: { id: string; text: string },
): Promise<WriteSuccess | AppendError> {
  if (!isPageId(input.id)) return { ok: false, reason: "not_found" };
  const actor = actorOf(ctx.principal);
  const result = await appendToPage(ctx.db, { ...input, actor, now: ctx.now() });
  if (result.ok) {
    ctx.recordWrite({
      op: "append",
      actor,
      pageId: input.id,
      rowsWritten: result.rowsWritten,
      attempts: result.attempts,
    });
  }
  return result;
}

/** キューに入れたリンクの書き換えを 1 ページ分進める。 */
export async function stepLinkRewritesAs(
  ctx: PageWriteContext,
  input: { targetPageId: string | null },
): Promise<LinkRewriteStepResult> {
  return stepLinkRewritesRecorded(ctx, input, () => actorOf(ctx.principal));
}

/**
 * principal を持たない呼び出し元（Cron）も使う。fallbackActor は、キューのジョブを捨てただけで書き換えた
 * revision が無いときの計測値の actor で、書き込みが起きたときだけ呼ぶ。
 */
export async function stepLinkRewritesRecorded(
  ctx: Pick<PageWriteContext, "db" | "now" | "recordWrite">,
  input: Pick<LinkRewriteStepInput, "targetPageId" | "onPicked">,
  fallbackActor: () => string,
): Promise<LinkRewriteStepResult> {
  const { result, actor } = await stepLinkRewrites(ctx.db, { ...input, now: ctx.now() });
  if (result.rowsWritten > 0) {
    ctx.recordWrite({
      op: "link_rewrite",
      actor: actor ?? fallbackActor(),
      ...(result.processed === null ? {} : { pageId: result.processed.sourcePageId }),
      rowsWritten: result.rowsWritten,
      ...(result.failed.length > 0 ? { failed: result.failed } : {}),
    });
  }
  return result;
}

/**
 * ルートの宣言（requireOwner）とは別にここでも owner に限る。token の経路（MCP の tool など）から
 * 呼ばれても公開できないようにするため。
 */
export async function setVisibilityAs(
  ctx: PageWriteContext,
  input: { id: string; visibility: Visibility; expectedVersion?: number },
): Promise<WriteSuccess | WriteError> {
  if (ctx.principal.kind !== "owner") throw new Error("visibility を変えられるのは owner だけ");
  if (!isPageId(input.id)) return { ok: false, reason: "not_found" };
  const actor = actorOf(ctx.principal);
  const result = await setVisibility(ctx.db, { ...input, now: ctx.now() });
  if (result.ok && result.rowsWritten > 0) {
    ctx.recordWrite({ op: "visibility", actor, pageId: input.id, rowsWritten: result.rowsWritten });
  }
  return result;
}

/** visibility_not_allowed の説明。REST の本文のキーと MCP の tool の入力で共通にする。 */
export const VISIBILITY_NOT_ALLOWED_MESSAGE =
  "visibility は API から変えられない。visibility を外して送り直す（ページは draft で作られ、公開はオーナーがブラウザで行う）";

export interface WriteErrorDescription {
  /** REST のレスポンスに使う HTTP ステータス */
  status: 400 | 404 | 409 | 413;
  body: { error: string; [key: string]: unknown };
}

/** 書き込みの失敗を、REST のレスポンス本文と MCP の tool のエラーで共通の形にする。 */
export function describeWriteError(error: WriteError | AppendError): WriteErrorDescription {
  switch (error.reason) {
    case "invalid_title":
      return {
        status: 400,
        body: { error: "invalid_title", message: "title が空か、空白だけになっている" },
      };
    case "control_char":
      return {
        status: 400,
        body: {
          error: "invalid_field",
          field: error.field,
          reason: "control_char",
          line: error.at.line,
          column: error.at.column,
          codePoint: error.at.codePoint,
          message: controlCharMessage(error.field, error.at),
        },
      };
    case "title_too_long":
      return {
        status: 400,
        body: {
          error: "title_too_long",
          field: "title",
          max: error.max,
          actual: error.bytes,
          unit: "utf8_bytes",
          message: `title が長すぎる（UTF-8 で ${error.bytes} バイト、上限 ${error.max} バイト）。短くして送り直す`,
        },
      };
    case "body_too_large":
      return {
        status: 413,
        body:
          error.field === "text"
            ? {
                error: "body_too_large",
                field: "text",
                max: error.max,
                actual: error.bytes,
                currentBytes: error.currentBytes,
                unit: "utf8_bytes",
                message: `追記後の本文が上限を超える（追記後 ${error.bytes} バイト、今の本文 ${error.currentBytes} バイト、上限 ${error.max} バイト）。text を短くするか、別のページに書く`,
              }
            : {
                error: "body_too_large",
                field: "body",
                max: error.max,
                actual: error.bytes,
                unit: "utf8_bytes",
                message: `body が長すぎる（UTF-8 で ${error.bytes} バイト、上限 ${error.max} バイト）。短くするか、ページを分ける`,
              },
      };
    case "not_found":
      return { status: 404, body: { error: "not_found" } };
    case "version_conflict":
      return {
        status: 409,
        body: {
          error: "version_conflict",
          message:
            "version が合わない。最新の title と body を読み直し、変更を載せ直してから保存し直す",
          currentVersion: error.currentVersion,
        },
      };
    case "title_conflict":
      return {
        status: 409,
        body: {
          error: "title_conflict",
          ...(error.existing === undefined ? {} : { existing: error.existing }),
          message:
            "同じ title とみなすページがすでにある（大文字小文字、全角半角、_ と空白の違いは区別しない）。そのページに追記するか、title を変える",
        },
      };
    case "append_conflict":
      return {
        status: 409,
        body: {
          error: "append_conflict",
          message: "他の保存と競合し続けた。同じ追記をそのまま送り直してよい",
        },
      };
  }
}

/**
 * title の位置は 1 行に整えた後の title で数える。送った文字列の位置とずれうるので、数え方も文に書く。
 */
function controlCharMessage(field: "title" | "body" | "text", at: CharAt): string {
  if (field === "title") {
    return `title の ${at.column} 文字目に制御文字 ${at.codePoint} がある（位置は、改行とタブを空白にし前後の空白を除いた後の title で数える）。取り除いて送り直す`;
  }
  return `${field} の ${at.line} 行 ${at.column} 文字目に NUL（${at.codePoint}）がある。取り除いて送り直す`;
}
