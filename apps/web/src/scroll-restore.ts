import { useLayoutEffect } from "react";

/*
 * 一覧からページを開いて戻ったとき、一覧のスクロール位置を戻す。
 *
 * ブラウザの復元は戻る（popstate）の時点で 1 度だけ動く。そのとき画面は一覧を取り直す前の短い
 * 状態（読み込み中の 1 行）なので、位置が 0 に丸められ、一覧が届いても戻らない。
 * そこで、ページを開く遷移の直前に位置を覚え、戻った後に一覧が描かれた時点で自分で戻す。
 * history.scrollRestoration は auto のままにする。ページどうしの戻りはブラウザの復元に任せる。
 */

/** 覚えておく位置の数。長く使っても増え続けないよう、古いものから捨てる */
const MAX_ENTRIES = 50;

/** パスとクエリごとの、離れる直前のスクロール位置 */
const positions = new Map<string, number>();

/** 戻った先で戻す位置。popstate で決め、一覧が描かれたときに使い切る */
let pending: { key: string; y: number } | null = null;

const currentKey = (): string => `${window.location.pathname}${window.location.search}`;

/** 履歴に積む遷移の直前に呼ぶ。この後の遷移で先頭へ戻す前の位置を、今の URL に紐づけて覚える。 */
export function rememberScroll(): void {
  pending = null;
  const y = window.scrollY;
  if (typeof y !== "number") return;
  const key = currentKey();
  // 入れ直して、最後に使ったものを新しい側に置く
  positions.delete(key);
  positions.set(key, y);
  if (positions.size > MAX_ENTRIES) {
    const oldest = positions.keys().next().value;
    if (oldest !== undefined) positions.delete(oldest);
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("popstate", () => {
    const key = currentKey();
    const y = positions.get(key);
    pending = y === undefined ? null : { key, y };
  });
}

/**
 * 戻る・進むで開いた一覧が描かれたとき（ready が true になったとき）、覚えていた位置へ戻す。
 * 位置は描画の前に戻して、先頭が一瞬見えるのを避ける。
 */
export function useRestoreScroll(ready: boolean): void {
  useLayoutEffect(() => {
    if (!ready || pending === null || pending.key !== currentKey()) return;
    const { y } = pending;
    pending = null;
    window.scrollTo(0, y);
  }, [ready]);
}
