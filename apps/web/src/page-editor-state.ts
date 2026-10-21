import type { PageInputProblem } from "@personal-wiki/domain/page-input";
import { type EditorState, inputProblemsOf, isDirty, type SaveStatus } from "./editor-session";

/**
 * 公開範囲の切り替えと削除のボタンが、いま進行中の操作に対して押せるか。
 *
 * 保存中も押せる。本文の編集中にこれらのボタンを押すと、mousedown の blur が保存を始めるので、
 * 保存中を disabled にすると mouseup の時点で押せなくなり、クリックが届かない。
 */
const isIdleOrSaving = (busy: EditorState["busy"]) => busy === null || busy === "saving";

/**
 * 公開範囲の切り替えを押せるか。
 *
 * session は切り替えを保存の後ろに並べ、保存で進んだ版に対して送る。切り替えの番が来たときに
 * 手元が未保存なら、保存をもう一度送る（通信の失敗で終わった保存もここで送り直す）。それが通れば
 * 切り替えを送り、409 や 401 を含め保存できなければ切り替えない
 */
export const canChangeVisibility = (state: Pick<EditorState, "busy">, status: SaveStatus) =>
  isIdleOrSaving(state.busy) && (status === "saved" || status === "unsaved" || status === "saving");

/**
 * 削除のボタンを押せるか。
 *
 * `readOnly` は `isReadOnly` の結果で、別の場所での削除、競合、退避の未決を含む
 */
export const canDelete = ({
  busy,
  authLost,
  readOnly,
  pendingDelete,
}: Pick<EditorState, "busy" | "authLost"> & { readOnly: boolean; pendingDelete: boolean }) =>
  isIdleOrSaving(busy) && !pendingDelete && !authLost && !readOnly;

/** 画面で知らせる入力の問題。保存済みのままの内容は送らないので、問題があっても手を付けるまでは知らせない */
export const shownInputProblems = (
  state: Pick<EditorState, "uncreated" | "base" | "draft">,
): readonly PageInputProblem[] =>
  state.uncreated || isDirty(state) ? inputProblemsOf(state.draft) : [];
