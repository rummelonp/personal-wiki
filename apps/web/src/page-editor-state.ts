import type { PageInputProblem } from "@personal-wiki/domain/page-input";
import { type EditorState, inputProblemsOf, isDirty, type SaveStatus } from "./editor-session";

/**
 * 公開範囲の切り替えを押せるか。
 *
 * 保存中も押せる。本文の編集中に公開の操作を押すと、mousedown の blur が保存を始めるので、保存中を
 * disabled にすると mouseup の時点で押せなくなり、クリックが届かない。session は切り替えを保存の後ろに
 * 並べ、保存で進んだ版に対して送る。切り替えの番が来たときに手元が未保存なら、保存をもう一度送る
 * （通信の失敗で終わった保存もここで送り直す）。それが通れば切り替えを送り、409 や 401 を含め
 * 保存できなければ切り替えない
 */
export const canChangeVisibility = (state: Pick<EditorState, "busy">, status: SaveStatus) =>
  (state.busy === null || state.busy === "saving") &&
  (status === "saved" || status === "unsaved" || status === "saving");

/** 画面で知らせる入力の問題。保存済みのままの内容は送らないので、問題があっても手を付けるまでは知らせない */
export const shownInputProblems = (
  state: Pick<EditorState, "uncreated" | "base" | "draft">,
): readonly PageInputProblem[] =>
  state.uncreated || isDirty(state) ? inputProblemsOf(state.draft) : [];
