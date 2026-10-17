import { useSyncExternalStore } from "react";

const MINUTE = 60_000;

/**
 * 分の頭に切り捨てた現在時刻。同じ分の間は同じ値を返すので、購読側は分が変わるときだけ描き直す。
 * 表記は分の単位なので、最大 59 秒の遅れは表記の誤差に収まる。秒まで合わせると行ごとに変わる時刻が
 * ずれ、再描画が 1 分に何度も起きる。切り捨てた値は更新時刻より過去になることがあり、
 * そのとき `formatRelativeTime` は経過 0 として扱う。
 */
const minuteNow = (): number => Math.floor(Date.now() / MINUTE) * MINUTE;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

const notify = () => {
  for (const listener of listeners) listener();
};

// 分の境目に合わせた timer を全購読者で 1 つだけ回す。購読者がいない間は止める
function schedule() {
  // notify の中で購読者が全員やめて同期に購読し直すと、subscribe と callback の両方が登録する。
  // 連鎖が 2 本になると、購読者がいなくなっても片方が止まらずに残るので、登録の前に必ず 1 本にする
  clearTimeout(timer);
  timer = setTimeout(
    () => {
      notify();
      // notify の中で購読者が全員やめたときは、連鎖を続けない
      if (listeners.size > 0) schedule();
    },
    MINUTE - (Date.now() % MINUTE) + 50,
  );
}

// 背景のタブは timer が間引かれて遅れるので、画面に戻ったときに確かめ直す
const onVisible = () => {
  if (document.visibilityState === "visible") notify();
};

/** `useNow` の購読。テストが生の listener で timer の数を確かめるために export する。 */
export function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", notify);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", notify);
    }
  };
}

/** 相対表記のための現在時刻（ミリ秒）。分が変わるたびに更新される。 */
export function useNow(): number {
  return useSyncExternalStore(subscribe, minuteNow, minuteNow);
}
