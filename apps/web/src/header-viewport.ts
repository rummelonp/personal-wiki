import { keyboardShown } from "./notice-dock";

/**
 * sticky のヘッダーを visual viewport の上端に置く。iOS の Safari はキーボードが出ると、layout viewport を
 * 縮めずに visual viewport をその中で下へずらすことがある。layout viewport の上端に貼り付くヘッダーは、
 * ずれた分だけ見える範囲の上へ隠れるので、その分を sticky の top に足す。
 * 追うのはキーボードが出ている間だけにする。iOS は文書の端で弾むスクロールの間も offsetTop を動かし、
 * それを追うとヘッダーが本文の途中へ跳ねる。ピンチで拡大している間は読み手が見える範囲を動かしているので、
 * これも追わない。戻り値で解除する。
 */
export function followVisualViewportTop(header: HTMLElement): () => void {
  const viewport = window.visualViewport;
  if (viewport === null) return () => {};
  const update = () => {
    const offset = keyboardShown(viewport) ? Math.max(0, viewport.offsetTop) : 0;
    if (offset === 0) header.style.removeProperty("top");
    else header.style.top = `${Math.round(offset)}px`;
  };
  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    header.style.removeProperty("top");
  };
}
