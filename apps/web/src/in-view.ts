import { stickyHeaderBottom } from "./sticky-header";

/**
 * 要素の一部が、利用者に見えている範囲に入っているか。見える範囲は、画面の上端に残るヘッダーの下から、
 * キーボードなどを除いた visual viewport の下端まで。IntersectionObserver ではなく同期で測るのは、
 * 呼び出し側が scroll と resize で測り直し、試験でも同じ手順で確かめられるため。
 */
export function isInView(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const viewport = window.visualViewport;
  const top = Math.max(stickyHeaderBottom(), viewport?.offsetTop ?? 0);
  const bottom = viewport === null ? window.innerHeight : viewport.offsetTop + viewport.height;
  return rect.bottom > top && rect.top < bottom;
}
