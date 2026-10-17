import { type RefObject, useEffect, useState } from "react";

/**
 * 要素が画面に少しでも入っている間 true。スクロールする親（右の列の中など）に隠れた分も外れる。
 * 最初の判定が届くまでは true にして、マウント直後の処理を待たせない。
 * IntersectionObserver が無い環境では、判定できないので true のままにする。
 */
export function useIntersecting(ref: RefObject<Element | null>): boolean {
  const [intersecting, setIntersecting] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries.at(-1);
      if (last !== undefined) setIntersecting(last.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return intersecting;
}
