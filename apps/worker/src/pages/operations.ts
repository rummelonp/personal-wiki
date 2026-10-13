import type { Principal } from "../auth/principal";
import { isPageId } from "./id";
import { actorOf } from "./revisions";
import {
  type AppendError,
  appendToPage,
  createPage,
  findPageById,
  MAX_BODY_BYTES,
  MAX_TITLE_BYTES,
  type Page,
  updatePage,
  type WriteError,
  type WriteSuccess,
} from "./store";

/*
 * REST と MCP が共有するページの操作。actor の決定、書き込みの計測、エラーの説明をここに置き、
 * 入口ごとの違いは入力の解析と応答の形だけにする。
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
  op: "create" | "update" | "append" | "delete" | "rebuild";
  /** revisions.actor と同じ形式 */
  actor: string;
  /** 書いたページ。作り直しは 1 回で複数ページを扱いうるので付けない */
  pageId?: string;
  rowsWritten: number;
  /** 追記で版の競合により読み直した場合の試行回数 */
  attempts?: number;
  /** 作り直しで失敗したページの id */
  failed?: string[];
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
  }
  return result;
}

export async function updatePageAs(
  ctx: PageWriteContext,
  input: { id: string; expectedVersion: number; title: string; body: string },
): Promise<WriteSuccess | WriteError> {
  if (!isPageId(input.id)) return { ok: false, reason: "not_found" };
  const actor = actorOf(ctx.principal);
  const result = await updatePage(ctx.db, { ...input, actor, now: ctx.now() });
  if (result.ok) {
    ctx.recordWrite({ op: "update", actor, pageId: input.id, rowsWritten: result.rowsWritten });
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

export interface WriteErrorDescription {
  /** REST の応答に使う HTTP ステータス */
  status: 400 | 404 | 409 | 413;
  body: { error: string; [key: string]: unknown };
}

/** 書き込みの失敗を、REST の応答本文と MCP の tool のエラーで共通の形にする。 */
export function describeWriteError(error: WriteError | AppendError): WriteErrorDescription {
  switch (error.reason) {
    case "invalid_title":
      return {
        status: 400,
        body: { error: "invalid_title", message: "title が空か、空白だけになっている" },
      };
    case "title_too_long":
      return { status: 400, body: { error: "title_too_long", max: MAX_TITLE_BYTES } };
    case "body_too_large":
      return { status: 413, body: { error: "body_too_large", max: MAX_BODY_BYTES } };
    case "not_found":
      return { status: 404, body: { error: "not_found" } };
    case "version_conflict":
      return {
        status: 409,
        body: {
          error: "version_conflict",
          message: "版が合わない。最新版を読み直してから保存し直す",
          currentVersion: error.currentVersion,
        },
      };
    case "title_conflict":
      return {
        status: 409,
        body: { error: "title_conflict", message: "同じ title のページがすでにある" },
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
