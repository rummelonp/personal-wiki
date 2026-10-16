import { useSyncExternalStore } from "react";

const MINUTE = 60_000;

/** 分の頭に丸めた現在時刻。同じ分の間は同じ値を返すので、購読側は分が変わるときだけ描き直す。 */
const minuteNow = (): number => Math.floor(Date.now() / MINUTE) * MINUTE;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

const notify = () => {
  for (const listener of listeners) listener();
};

// 分の境目に合わせた timer を全購読者で 1 つだけ回す。購読者がいない間は止める
function schedule() {
  timer = setTimeout(
    () => {
      notify();
      schedule();
    },
    MINUTE - (Date.now() % MINUTE) + 50,
  );
}

// 背景のタブは timer が間引かれて遅れるので、画面に戻ったときに確かめ直す
const onVisible = () => {
  if (document.visibilityState === "visible") notify();
};

function subscribe(listener: () => void): () => void {
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
