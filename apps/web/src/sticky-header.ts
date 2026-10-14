import { Prec } from "@codemirror/state";
import { EditorView, tooltips } from "@codemirror/view";
import { tooltipSpace } from "@personal-wiki/editor";
import { noticeDockRect } from "./notice-dock";

/**
 * ヘッダーの下端の位置（viewport の上端から）。ヘッダーは画面の上端に残るので、本文のスクロール先は
 * この下に置く。高さを CSS と二重に持たないよう、スクロールの時点で測る。ヘッダーが無い画面では 0。
 */
export function stickyHeaderBottom(): number {
  const header = document.querySelector("header.header");
  return header === null ? 0 : Math.max(0, header.getBoundingClientRect().bottom);
}

/**
 * scrollIntoView の処理中の view。CodeMirror は scrollMargins を、scrollIntoView では viewport の端からの
 * 絶対値として読み、tooltip では scrollDOM の矩形から内側への幅として読む。
 * どちらの読み手かは渡されないので、scrollIntoView が margins を読む前に同期で回す scrollHandler で
 * 印を付けて見分ける（CodeMirror 内部の呼び出し順に頼っている）。
 * 座標が取れず margins を読まずに戻ると印が残る。microtask で外すので次の task には持ち越さないが、
 * 同じ measure の残りの周回では tooltip が絶対値を読みうる。
 */
const scrolling = new WeakSet<EditorView>();

const markScrolling = EditorView.scrollHandler.of((view) => {
  scrolling.add(view);
  queueMicrotask(() => scrolling.delete(view));
  return false;
});

/**
 * 見出しへの移動やカーソル行のスクロールで、対象がヘッダーの下と、画面の下端に重なる通知の台の
 * 上に隠れないようにする。通知は本文を動かさず重なるので、打っている行はスクロールで逃がす。
 * CodeMirror は CSS の scroll-padding を読まず、この facet だけを見る。
 *
 * scrollIntoView 以外の読み手には、本文の箱に実際に重なる分だけを返す。箱がヘッダーの下にあるのに
 * viewport からの絶対値を返すと、tooltip の見える範囲が二重に削られて補完の窓が隠れる。
 * 重なる分はヘッダーと台それぞれの高さで頭打ちにする。頭打ちしないと、スクロールで箱の上端が
 * 画面の外へ出たとき、drag の自動スクロール（window 基準で読む）が常に上向きに働く。
 * drag にとって正しいのは絶対値なので、箱がヘッダーに一部隠れている間は drag の閾値が少し下がる。
 * 補完の窓が見えることを優先した。
 * 箱の上端が画面の外にあるとき、上側は header を返すので窓を隠す判定には足りない。
 * 上側の正しさは tooltipSpaceBelowChrome の top に頼っている。
 */
const scrollMargins = EditorView.scrollMargins.of((view) => {
  const header = stickyHeaderBottom();
  const dock = noticeDockRect();
  if (scrolling.delete(view)) return { top: header, bottom: dock?.height ?? 0 };
  const box = view.scrollDOM.getBoundingClientRect();
  return {
    top: Math.min(Math.max(header - box.top, 0), header),
    bottom: dock === null ? 0 : Math.min(Math.max(box.bottom - dock.top, 0), dock.height),
  };
});

/**
 * 補完の窓を置ける範囲から、ヘッダーと通知の台を除く。台の位置は高さからでなく rect で読む。
 * iOS のキーボードが出ると台が持ち上がり、画面の下端からの高さでは足りないため。
 */
const tooltipSpaceBelowChrome = Prec.high(
  tooltips({
    tooltipSpace: (view) => {
      const space = tooltipSpace(view);
      const dock = noticeDockRect();
      return {
        ...space,
        top: Math.max(space.top, stickyHeaderBottom()),
        bottom: dock === null ? space.bottom : Math.min(space.bottom, dock.top),
      };
    },
  }),
);

export const scrollBelowStickyHeader = [markScrolling, scrollMargins, tooltipSpaceBelowChrome];
