/**
 * 通知を画面の下端に重ねて出す台（`.notice-dock`）と、本文のスクロールをつなぐ。
 *
 * 通知を本文の流れの中に入れると、出入りのたびに title と本文が動く。台は fixed で流れから外し、
 * 本文は動かさずに、台の高さだけ本文のスクロールの下の余白（scrollMargins）と文書の末尾の余白を取る。
 */

/** 台が本文を覆う範囲が変わったとき（通知の出入り、折り返しの変化、キーボードでの持ち上がり）に document へ送るイベント。 */
export const NOTICE_DOCK_RESIZE = "notice-dock-resize";

/** 台が覆っている範囲。通知が無ければ null。 */
export function noticeDockRect(): DOMRect | null {
  const dock = document.querySelector(".notice-dock");
  if (dock === null || dock.childElementCount === 0) return null;
  return dock.getBoundingClientRect();
}

/** 台が画面の下端から覆っている高さ。通知が無ければ 0。 */
export function noticeDockHeight(): number {
  return noticeDockRect()?.height ?? 0;
}

/**
 * キーボードとみなす、layout viewport と visual viewport の高さの差。URL バーの伸縮（100px 前後）より
 * 大きく、iOS のキーボード（最小でも 200px 台）より小さい。
 */
const KEYBOARD_MIN_HEIGHT = 150;

/** ピンチで拡大しているとみなす倍率。 */
const ZOOMED_SCALE = 1.01;

/** キーボードが出ているか。ピンチで拡大している間も visual viewport は縮むので、それは除く。 */
export function keyboardShown(viewport: VisualViewport): boolean {
  return (
    viewport.scale <= ZOOMED_SCALE && window.innerHeight - viewport.height > KEYBOARD_MIN_HEIGHT
  );
}

/**
 * キーボードが出ている間は、台をキーボードの上へ上げる。iOS の Safari はキーボードが出ても layout viewport
 * を縮めないので、fixed の下端はキーボードの裏に隠れる。visual viewport の下端との差を台の下端に足す。
 * layout viewport が縮む環境では差が 0 になり、何も足さない。
 *
 * 通知が覆える高さの上限は、見えている高さ（visual viewport）の割合で決める。
 * キーボードが出ている間は見える高さが半分ほどなので、台に data-keyboard を付け、通知を見出しと操作だけに畳む
 * （CSS）。ピンチで拡大している間は visual viewport が縮むが、画面が狭くなったわけではないので、
 * 上限は layout viewport から決める。
 */
function followVisualViewport(dock: HTMLElement): () => void {
  const viewport = window.visualViewport;
  if (viewport === null) return () => {};
  let last: number | null = null;
  const update = () => {
    const zoomed = viewport.scale > ZOOMED_SCALE;
    // ピンチで拡大している間は、visual viewport の下端と fixed の下端が対応しないので動かさない
    const inset = zoomed
      ? 0
      : Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    const room = zoomed ? window.innerHeight : viewport.height;
    dock.style.setProperty("--notice-inset", `${Math.round(inset)}px`);
    dock.style.setProperty("--notice-room", `${Math.round(room)}px`);
    dock.toggleAttribute("data-keyboard", keyboardShown(viewport));
    // 台が持ち上がると、高さが同じでも本文を覆う範囲が変わる。最初の設定は台が出る前なので知らせない
    const rounded = Math.round(inset);
    if (last !== null && rounded !== last) document.dispatchEvent(new Event(NOTICE_DOCK_RESIZE));
    last = rounded;
  };
  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    dock.style.removeProperty("--notice-inset");
    dock.style.removeProperty("--notice-room");
    dock.removeAttribute("data-keyboard");
  };
}

/** 重大度の高い順。台の中の並びと、畳まずに残す通知の選び方で同じ順を使う。 */
const TONE_RANK = ["notice-error", "notice-warn", "notice-info"];

function rankOf(notice: Element): number {
  const rank = TONE_RANK.findIndex((name) => notice.classList.contains(name));
  return rank === -1 ? TONE_RANK.length : rank;
}

/** 通知を台で初めて見た順。同じ重大度の中の順に使い、重大度が往復しても出た順に戻す。 */
const arrival = new WeakMap<Element, number>();
let arrivals = 0;

function compareNotices(a: Element, b: Element): number {
  return rankOf(a) - rankOf(b) || (arrival.get(a) ?? 0) - (arrival.get(b) ?? 0);
}

/**
 * 台の中の DOM の順を重大度の高い順に直す（同じ重大度の中は台で初めて見た順）。CSS の order で見た目だけを
 * 並べ替えると、Tab と読み上げの順が見た目とずれるため、DOM の順そのものを揃える。
 *
 * DOM で動かしてよいのは、通知ごとに別の createPortal で台に足しているため。React は台の兄弟を基準に
 * insertBefore せず、追加は appendChild、削除は対象の removeChild だけなので、順を入れ替えても食い違わない。
 * 1 つの portal に map で並べる形に変えると、React の想定する順と衝突する。
 *
 * 後ろにあって手前に出るべき通知（たいてい出たばかりのもの）だけを動かし、ほかの通知は動かさない。
 * ただし重大度が変わった既存の通知も動く。moveBefore は focus と状態を保つが、無い環境の insertBefore は
 * 削除と再挿入になり、focus が外れる（戻す）うえ、role=alert の通知は再び読み上げられうる。
 */
function sortBySeverity(dock: HTMLElement): void {
  const notices = [...dock.querySelectorAll<HTMLElement>(":scope > .notice")];
  for (const notice of notices) {
    if (!arrival.has(notice)) arrival.set(notice, arrivals++);
  }
  for (let i = 1; i < notices.length; i++) {
    const notice = notices[i];
    if (notice === undefined) continue;
    let target = i;
    while (target > 0 && compareNotices(notices[target - 1] as Element, notice) > 0) target--;
    if (target === i) continue;
    const before = notices[target] as HTMLElement;
    const focused = notice.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : null;
    const { moveBefore } = dock as HTMLElement & {
      moveBefore?: (node: Node, child: Node | null) => void;
    };
    if (moveBefore !== undefined) {
      moveBefore.call(dock, notice, before);
    } else {
      dock.insertBefore(notice, before);
      if (focused !== null && document.activeElement !== focused)
        focused.focus({ preventScroll: true });
    }
    notices.splice(i, 1);
    notices.splice(target, 0, notice);
  }
}

/**
 * 通知が 2 つ以上重なるときは、最も重大な 1 つ以外に data-folded を付ける。CSS が狭い画面で
 * それらを見出しと操作だけに畳み、重なった通知が画面の高さの多くを覆わないようにする。
 * 同じ重大度の中は出た順（DOM の順）で、先に出たものを残す。
 */
function markFolded(notices: Element[]): void {
  let keep: Element | null = null;
  for (const notice of notices) {
    if (keep === null || rankOf(notice) < rankOf(keep)) keep = notice;
  }
  for (const notice of notices)
    notice.toggleAttribute("data-folded", notices.length > 1 && notice !== keep);
}

/**
 * 台の上限に達して中でスクロールするとき、続きのある側を data-more-above / data-more-below で示す
 * （CSS が端を淡くぼかす）。iOS ではスクロールバーが隠れるので、これが続きの手がかりになる。
 * 小数のずれで端に着いても点き続けないよう、1px の余裕を見る。
 */
function markScrollEdges(dock: HTMLElement): void {
  dock.toggleAttribute("data-more-above", dock.scrollTop > 1);
  dock.toggleAttribute(
    "data-more-below",
    dock.scrollTop + dock.clientHeight < dock.scrollHeight - 1,
  );
}

/** 台の位置を visual viewport に合わせ、高さの変化を文書の余白とイベントで知らせる。戻り値で解除する。 */
export function bindNoticeDock(dock: HTMLElement): () => void {
  const root = document.documentElement;
  const stopFollowing = followVisualViewport(dock);
  let last = -1;
  const sync = () => {
    sortBySeverity(dock);
    markFolded([...dock.querySelectorAll(":scope > .notice")]);
    markScrollEdges(dock);
  };
  const announce = () => {
    sync();
    const height = noticeDockHeight();
    if (height === last) return;
    last = height;
    root.style.setProperty("--notice-height", `${Math.round(height)}px`);
    document.dispatchEvent(new Event(NOTICE_DOCK_RESIZE));
  };
  // 描画する環境（jsdom など）に無いときは、高さの追従を省く
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(announce);
  const observed = new Set<Element>();
  // 通知の重大度は class で表す。同じ通知の tone が変わると並びと畳む対象が変わるので、class の変化も見る。
  // 畳む印は data 属性で付けるため、畳んだ結果がこの監視を呼び直すことはない
  const toneChanges = new MutationObserver(() => announce());
  // 台の高さが上限で頭打ちの間は、通知の中身が増減しても台の大きさは変わらない。通知も見る
  const observeNotices = () => {
    if (observer === null) return;
    const current = new Set(dock.querySelectorAll(":scope > .notice"));
    for (const notice of observed) {
      if (!current.has(notice)) {
        observer.unobserve(notice);
        observed.delete(notice);
      }
    }
    for (const notice of current) {
      if (!observed.has(notice)) {
        observer.observe(notice);
        toneChanges.observe(notice, { attributes: true, attributeFilter: ["class"] });
        observed.add(notice);
      }
    }
  };
  observer?.observe(dock);
  const onScroll = () => markScrollEdges(dock);
  dock.addEventListener("scroll", onScroll, { passive: true });
  // 子の増減（display: none との切り替え）は大きさの変化として届かない場合があるので、併せて見る
  const children = new MutationObserver(() => {
    observeNotices();
    announce();
  });
  children.observe(dock, { childList: true });
  observeNotices();
  announce();
  return () => {
    stopFollowing();
    observer?.disconnect();
    children.disconnect();
    toneChanges.disconnect();
    dock.removeEventListener("scroll", onScroll);
    dock.removeAttribute("data-more-above");
    dock.removeAttribute("data-more-below");
    for (const notice of dock.querySelectorAll(":scope > .notice"))
      notice.removeAttribute("data-folded");
    root.style.removeProperty("--notice-height");
  };
}
