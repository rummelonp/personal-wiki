import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { EditorState, FailedOp } from "./editor-session";
import { isInView } from "./in-view";

/** 失敗の後の操作が終わるまでの間、失敗の通知に代えてドックに出す見出し。 */
const PROGRESS_TITLES = {
  saving: "保存中…",
  visibility: "公開範囲を変更中…",
  deleting: "削除中…",
  restoring: "本文を戻し中…",
} as const;

export interface FailureProgress {
  /** 通知に出している失敗（作成の失敗を含む） */
  shownFailure: FailedOp | null;
  /** 進行の通知と同じ位置に出す、作成以外の失敗 */
  failure: FailedOp | null;
  /** 作成の失敗。title の確定で起きるので、title の後に出す */
  createFailure: FailedOp | null;
  /** 失敗の通知が出てから、続けて始めた操作が終わるまで */
  afterFailure: boolean;
  /** 失敗の通知に代えてドックに出す進行の見出し */
  progress: string | null;
  /** ページの上端の保存の状態（.save-state）に付ける */
  saveStateEl: RefObject<HTMLParagraphElement | null>;
}

export function useFailureProgress(state: EditorState): FailureProgress {
  // 失敗の後に操作を始めると session は失敗の記録を消すので、通知も消える。保存の状態の表示はページの上端に
  // あり、下までスクロールしていると進んでいる手応えが無いため、終わるまで同じ場所に進行の通知を残す。
  // 「もう一度保存する」を押す前に本文の blur が保存を始めると、ボタンが消えて押せないので、押したかどうかでなく
  // 失敗の通知が出ていたかどうかで決める。再送のボタンへ focus を戻す判断にも使うので、作成の失敗も数える
  const shownFailure = state.error !== null ? state.failedOp : null;
  const failure = shownFailure !== null && shownFailure.kind !== "create" ? shownFailure : null;
  const [afterFailure, setAfterFailure] = useState(false);
  if (shownFailure !== null && !afterFailure) setAfterFailure(true);
  else if (afterFailure && shownFailure === null && state.busy === null) setAfterFailure(false);
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
  const createFailure = shownFailure?.kind === "create" ? shownFailure : null;
  return { shownFailure, failure, createFailure, afterFailure, progress, saveStateEl };
}
