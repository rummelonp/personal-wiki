import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { dispatchWhenSettled, isCompositionUnsettled, parseAhead } from "@personal-wiki/editor";
import type { ScrollAnchor, ScrollAnchorSource } from "./scroll-restore";
import { stickyHeaderBottom } from "./sticky-header";

const clampOffset = (view: EditorView, offset: number): number =>
  Math.min(Math.max(0, offset), view.state.doc.length);

/**
 * ヘッダーの下端に見えている本文の行を読む。本文の上端がヘッダーの下に在るとき（先頭付近）と、
 * 本文の下端がヘッダーより上に出たとき（本文の下に続く内容を見ているとき）は、本文の行では
 * 位置を言い表せないので null。
 *
 * 空行は座標が推定の高さのまま残りやすく、測った後と食い違うので、次の文字のある行を使う。
 *
 * lineBlockAtHeight と coordsAtPos は measure を同期に走らせる。変換が落ち着く前に走らせると、
 * 確定文字列の DOM 変更を読む前に IME の settle が先に走りうる（IME 不変条件 1）。
 * 呼び出し側（bodyScrollAnchor）が、落ち着く前はこの関数を呼ばない。
 */
function readAnchor(view: EditorView): ScrollAnchor | null {
  const header = stickyHeaderBottom();
  const top = view.documentTop;
  if (top > header || top + view.contentHeight < header) return null;
  const { doc } = view.state;
  let line = doc.lineAt(view.lineBlockAtHeight(header - top).from);
  while (line.text.trim() === "" && line.number < doc.lines) line = doc.line(line.number + 1);
  const rect = view.coordsAtPos(line.from, 1);
  if (rect === null) return null;
  return { offset: line.from, delta: rect.top - header };
}

/**
 * 戻した後、画面の高さが変わるたびに行を元の位置へ合わせ直す期間（ms）。
 * 画面の外の行の測り直しは、描いた後の数フレームから、wikilink の存在が届いた後まで続く。
 */
const HOLD_MS = 3000;

/**
 * 自分が移した直後にスクロールが届くまでの間（ms）。CodeMirror は移動を次のフレームの measure で行い、
 * 位置が落ち着くまで数フレーム続けて直すことがある。この間のスクロールは利用者の操作とみなさない。
 */
const OWN_MOVE_MS = 150;

/** 利用者の操作と履歴の移動。合わせ直しの間に起きたら、スクロールを奪い返さずに合わせ直しをやめる */
const TAKEOVER_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown", "popstate"] as const;

/** 外からの dispatch を落ち着いた後の 1 回にまとめる key */
const moveKey = Symbol("scrollToAnchor");

const currentUrl = (): string => `${window.location.pathname}${window.location.search}`;

/**
 * `anchor` の行を、読んだときと同じ位置（ヘッダーの下端から delta）へ移す。
 * sticky-header の scrollMargins が上端をヘッダーの下に寄せるので、yMargin はその下への距離になる。
 *
 * 移した後に、行より上の高さが変わると（測られていなかった行が測り直される、本文の上の要素が
 * 増えるなど）、スクロール量は同じまま画面の行がずれる。CodeMirror は、フォーカスも操作も無い
 * window のスクロールのずれを補正しない。そこで HOLD_MS の間、画面の高さが変わるたびに
 * 行の位置を見て、ずれていれば移し直す。
 *
 * 次のどれかが起きたら合わせ直しをやめる。
 * - 利用者の操作（wheel、touch、pointer、key）や popstate
 * - path か query が変わった
 * - 自分が移したのではないスクロール。スクロールバーのドラッグは pointer のイベントが届かない
 * - view が外れた
 *
 * selection は動かさず focus も取らない。IME の変換が落ち着く前は、移動も位置の測定も控える。
 */
function applyAnchor(view: EditorView, anchor: ScrollAnchor): boolean {
  const offset = clampOffset(view, anchor.offset);
  const url = currentUrl();
  let expectedY = window.scrollY;
  let ownMoveUntil = 0;
  let stopped = false;

  /** 測るので、変換が落ち着いた後にだけ呼ぶ */
  const atTarget = (): boolean => {
    const rect = view.coordsAtPos(offset, 1);
    return rect !== null && Math.abs(rect.top - stickyHeaderBottom() - anchor.delta) <= 1;
  };

  const move = () => {
    dispatchWhenSettled(view, moveKey, () => {
      // 保留している間に止めた移動は、落ち着いた後に実行するとスクロールを奪い返す
      if (stopped) return;
      // 遠くの行へ移すと、背景の解析が追いつくまで Markdown の記号のまま見えるので、先に解析しておく
      parseAhead(view, offset);
      ownMoveUntil = performance.now() + OWN_MOVE_MS;
      view.dispatch({
        // 位置の測定（coordsAtPos(offset, 1)）と同じ側に合わせる
        effects: EditorView.scrollIntoView(EditorSelection.cursor(offset, 1), {
          y: "start",
          yMargin: anchor.delta,
        }),
      });
    });
  };

  const onResize = () => {
    if (!view.dom.isConnected || currentUrl() !== url) return stop();
    if (isCompositionUnsettled(view)) return;
    if (atTarget()) expectedY = window.scrollY;
    else move();
  };
  const onScroll = () => {
    if (currentUrl() !== url) return stop();
    const y = window.scrollY;
    if (performance.now() < ownMoveUntil || Math.abs(y - expectedY) <= 2) {
      expectedY = y;
      return;
    }
    // 行が目標の位置に在るスクロールは、利用者の操作とみなさない。遅い端末で OWN_MOVE_MS を過ぎて
    // 届いた自分の移動か、本文の外の高さの変化をブラウザの scroll anchoring が補ったスクロールである
    if (!isCompositionUnsettled(view) && atTarget()) expectedY = y;
    else stop();
  };

  const resizes = new ResizeObserver(onResize);
  const timer = setTimeout(() => stop(), HOLD_MS);
  function stop() {
    stopped = true;
    clearTimeout(timer);
    resizes.disconnect();
    window.removeEventListener("scroll", onScroll);
    for (const type of TAKEOVER_EVENTS) window.removeEventListener(type, stop, true);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  for (const type of TAKEOVER_EVENTS) window.addEventListener(type, stop, { capture: true });
  resizes.observe(document.documentElement);
  move();
  return true;
}

export function bodyScrollAnchor(view: EditorView): ScrollAnchorSource {
  return {
    // 変換が落ち着く前は測れない。前に読めた行は、打った分だけカーソルを追ってスクロールした後には
    // 古いので、null を返してスクロール量で戻させる
    read: () => (isCompositionUnsettled(view) ? null : readAnchor(view)),
    apply: (anchor) => applyAnchor(view, anchor),
  };
}
