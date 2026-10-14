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
 * キーボードが出ている間は、台をキーボードの上へ上げる。iOS の Safari はキーボードが出ても layout viewport
 * を縮めないので、fixed の下端はキーボードの裏に隠れる。visual viewport の下端との差を台の下端に足す。
 * layout viewport が縮む環境では差が 0 になり、何も足さない。
 * 通知が覆える高さの上限も、見えている高さ（visual viewport）の割合で決める。
 */
function followVisualViewport(dock: HTMLElement): () => void {
  const viewport = window.visualViewport;
  if (viewport === null) return () => {};
  let last: number | null = null;
  const update = () => {
    // ピンチで拡大している間は、visual viewport の下端と fixed の下端が対応しないので動かさない
    const inset =
      viewport.scale > 1.01
        ? 0
        : Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    dock.style.setProperty("--notice-inset", `${Math.round(inset)}px`);
    dock.style.setProperty("--notice-room", `${Math.round(viewport.height)}px`);
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
  };
}

/** 台の位置を visual viewport に合わせ、高さの変化を文書の余白とイベントで知らせる。戻り値で解除する。 */
export function bindNoticeDock(dock: HTMLElement): () => void {
  const root = document.documentElement;
  const stopFollowing = followVisualViewport(dock);
  let last = -1;
  const announce = () => {
    const height = noticeDockHeight();
    if (height === last) return;
    last = height;
    root.style.setProperty("--notice-height", `${Math.round(height)}px`);
    document.dispatchEvent(new Event(NOTICE_DOCK_RESIZE));
  };
  // 描画する環境（jsdom など）に無いときは、高さの追従を省く
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(announce);
  observer?.observe(dock);
  // 子の増減（display: none との切り替え）は大きさの変化として届かない場合があるので、併せて見る
  const children = new MutationObserver(announce);
  children.observe(dock, { childList: true });
  announce();
  return () => {
    stopFollowing();
    observer?.disconnect();
    children.disconnect();
    root.style.removeProperty("--notice-height");
  };
}
