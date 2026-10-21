import { Facet, Prec } from "@codemirror/state";
import { EditorView, repositionTooltips, tooltips, ViewPlugin } from "@codemirror/view";
import { tooltipSpace } from "@personal-wiki/editor";
import { NOTICE_CARET_GAP, NOTICE_DOCK_RESIZE, noticeDockRect } from "./notice-dock";

/**
 * ヘッダーの下端の位置（viewport の上端から）。ヘッダーは画面の上端に残るので、本文のスクロール先は
 * この下に置く。高さを CSS と二重に持たないよう、スクロールの時点で測る。ヘッダーが無い画面では 0。
 */
export function stickyHeaderBottom(): number {
  const header = document.querySelector("header.header");
  return header === null ? 0 : Math.max(0, header.getBoundingClientRect().bottom);
}

/** scrollBelowStickyHeaderWith に渡された extraTop。scrollMargins と scrollTopMargin が同じ値を読むために facet に置く。 */
const extraTops = Facet.define<(view: EditorView) => number>();

function extraTopOf(view: EditorView): number {
  return view.state.facet(extraTops).reduce((sum, extraTop) => sum + extraTop(view), 0);
}

/**
 * scrollIntoView が対象の上端を置く下限（viewport の上端から）。ヘッダーの下端に extraTop を足した高さで、
 * scrollMargins の上の余白と同じ値を返す。script から移した focus がスクロールを要するかの判定は、
 * この値を上端に使う。CodeMirror はこの値にさらに yMargin（既定 5px）を足した位置より上を寄せるが、
 * その帯に入った行は見えているので、判定では動かさない側に扱う。
 */
export function scrollTopMargin(view: EditorView): number {
  return stickyHeaderBottom() + extraTopOf(view);
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
 * 見出しへの移動やカーソル行のスクロールで、対象がヘッダーの下と、画面の下端に重なる通知のドックの
 * 上に隠れないようにする。通知は本文を動かさず重なるので、打っている行はスクロールで逃がす。
 * ドックの上は NOTICE_CARET_GAP だけ空ける。tooltip の読み手には空けない（窓はドックの上端まで使える）。
 * CodeMirror は CSS の scroll-padding を読まず、この facet だけを見る。
 *
 * scrollIntoView 以外の読み手には、本文の箱に実際に重なる分だけを返す。箱がヘッダーの下にあるのに
 * viewport からの絶対値を返すと、tooltip の見える範囲が二重に削られて補完の窓が隠れる。
 * 重なる分はヘッダーとドックそれぞれの高さで頭打ちにする。頭打ちしないと、スクロールで箱の上端が
 * 画面の外へ出たとき、drag の自動スクロール（window 基準で読む）が常に上向きに働く。
 * drag にとって正しいのは絶対値なので、箱がヘッダーに一部隠れている間は drag の閾値が少し下がる。
 * 補完の窓が見えることを優先した。
 * 箱の上端が画面の外にあるとき、上側は header を返すので窓を隠す判定には足りない。
 * 上側の正しさは tooltipSpaceBelowChrome の top に頼っている。
 *
 * CodeMirror は、scrollHeight か scrollWidth が client の大きさを超える祖先を overflow の指定によらず
 * スクロールする箱とみなし、余白を足した矩形をその箱の内側に切り詰める。エディタの祖先の要素が
 * 1px でも外へはみ出すと、ここで返す余白が効かなくなる。
 */
function scrollMarginsBelow() {
  return EditorView.scrollMargins.of((view) => {
    const header = stickyHeaderBottom();
    const dock = noticeDockRect();
    if (scrolling.delete(view)) {
      return {
        top: header + extraTopOf(view),
        bottom: dock === null ? 0 : dock.height + NOTICE_CARET_GAP,
      };
    }
    const box = view.scrollDOM.getBoundingClientRect();
    return {
      top: Math.min(Math.max(header - box.top, 0), header),
      bottom: dock === null ? 0 : Math.min(Math.max(box.bottom - dock.top, 0), dock.height),
    };
  });
}

/**
 * 補完の窓を置ける範囲から、ヘッダーと通知のドックを除く。ドックの位置は高さからでなく rect で読む。
 * iOS のキーボードが出るとドックが持ち上がり、画面の下端からの高さでは足りないため。
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

/**
 * ドックが出入りしたり高さが変わったりしても、visual viewport は動かないので、開いている窓は置き直されない。
 * ドックの上端が変わったときに置き直し、窓がドックの下に残らないようにする。
 */
const repositionOnDockChange = ViewPlugin.define((view) => {
  const doc = view.dom.ownerDocument;
  const reposition = () => repositionTooltips(view);
  doc.addEventListener(NOTICE_DOCK_RESIZE, reposition);
  return { destroy: () => doc.removeEventListener(NOTICE_DOCK_RESIZE, reposition) };
});

/**
 * `extraTop` は、スクロールの対象をヘッダーの下からさらに離す高さ。ヘッダーと対象の間に、対象に付いて
 * 見せたい要素があるときに使う（title 欄の上の保存の状態）。補完の窓の範囲には足さない。
 */
export function scrollBelowStickyHeaderWith(extraTop: (view: EditorView) => number) {
  return [
    extraTops.of(extraTop),
    markScrolling,
    scrollMarginsBelow(),
    tooltipSpaceBelowChrome,
    repositionOnDockChange,
  ];
}

export const scrollBelowStickyHeader = scrollBelowStickyHeaderWith(() => 0);
