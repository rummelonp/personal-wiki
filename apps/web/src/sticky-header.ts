import { EditorView } from "@codemirror/view";
import { noticeDockHeight } from "./notice-dock";

/**
 * ヘッダーの下端の位置（viewport の上端から）。ヘッダーは画面の上端に残るので、本文のスクロール先は
 * この下に置く。高さを CSS と二重に持たないよう、スクロールの時点で測る。ヘッダーが無い画面では 0。
 */
export function stickyHeaderBottom(): number {
  const header = document.querySelector("header.header");
  return header === null ? 0 : Math.max(0, header.getBoundingClientRect().bottom);
}

/**
 * 見出しへの移動やカーソル行のスクロールで、対象がヘッダーの下と、画面の下端に重なる通知の台の
 * 上に隠れないようにする。通知は本文を動かさず重なるので、打っている行はスクロールで逃がす。
 * CodeMirror は CSS の scroll-padding を読まず、この facet だけを見る。
 */
export const scrollBelowStickyHeader = EditorView.scrollMargins.of(() => ({
  top: stickyHeaderBottom(),
  bottom: noticeDockHeight(),
}));
