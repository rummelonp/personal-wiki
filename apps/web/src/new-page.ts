import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { navigate, newPageHref, parseRoute } from "./route";

/** 新規作成の画面を開いた 1 回分。 */
export interface NewPageRequest {
  /** 開くたびに増える。`/?new` を開いたまま開き直しても、編集の画面を作り直す合図にする */
  serial: number;
  /**
   * title 欄の初期値。空でなければ、開いてすぐに作る。画面が受け取ったら consumeNewPageTitle で
   * 空に戻す（使い捨て）。残すと、同じ serial の画面を開き直したときに同じ title でもう一度作る
   */
  title: string;
}

let current: NewPageRequest = { serial: 0, title: "" };
/** 作れた新規作成の画面の serial。作れた後の URL は `/p/<id>` に置き換わっている */
let createdSerial: number | null = null;
const listeners = new Set<() => void>();

function publish(next: NewPageRequest): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const onNewPageRoute = () =>
  parseRoute(window.location.pathname, window.location.search).name === "new";

// 戻る・進むで `/?new` に来たとき、表示中の新規作成の画面が作れていれば、新しい画面に作り直す。
// 作ったページを `/?new` の URL のまま出さない（作った後に hash を移ってから戻ると起きる）。
// 作れていなければ serial を変えない。変えると、`/?new` のまま hash だけ戻ったときに打ちかけの画面が
// 作り直される
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    if (onNewPageRoute() && createdSerial === current.serial) {
      publish({ serial: current.serial + 1, title: "" });
    }
  });
}

export function useNewPageRequest(): NewPageRequest {
  return useSyncExternalStore(subscribe, () => current);
}

/** 新規作成の画面の title を受け取った。描画の中では呼ばない（別の部品の更新になる）。 */
export function consumeNewPageTitle(serial: number): void {
  if (current.serial === serial && current.title !== "") publish({ serial, title: "" });
}

/** 新規作成の画面でページを作れた。 */
export function markNewPageCreated(serial: number): void {
  createdSerial = serial;
}

/** 表示中の新規作成の画面が、title なしの開き直しを引き受けたら true を返す。 */
type KeepScreen = () => boolean;
let keepScreen: KeepScreen | null = null;

/** 表示中の新規作成の画面として、title なしの開き直しを引き受ける関数を登録する。 */
export function registerNewPageScreen(keep: KeepScreen): () => void {
  keepScreen = keep;
  return () => {
    if (keepScreen === keep) keepScreen = null;
  };
}

/**
 * 新規作成の画面を開く。title を渡すと本文に、渡さなければ title 欄にカーソルを置く。
 * `/?new` から開き直すときは履歴を置き換え、戻るで同じ `/?new` を何度もたどらせない。
 * replace を渡すと、今の画面の履歴を置き換える。作った後に戻ると、その画面の 1 つ前へ戻る。
 *
 * `/?new` で title なしに開き直すときは、表示中の画面が引き受ければ（内容があるとき）開き直さない。
 * 開き直すと、閉じた画面の内容を次の画面が復元の案内に出し、title 欄にカーソルが入らない。
 *
 * クリックなどの操作の中で呼ぶこと。iOS の Safari は、操作の中で focus した入力欄にだけ
 * キーボードを出すので、flushSync で画面と editor の mount（autoFocus）までを
 * この呼び出しの中で済ませる。
 */
export function openNewPage(options: { title?: string; replace?: boolean } = {}): void {
  const replace = options.replace === true || onNewPageRoute();
  if (replace && !options.title && keepScreen?.() === true) return;
  flushSync(() => {
    publish({ serial: current.serial + 1, title: options.title ?? "" });
    navigate(newPageHref, { replace });
  });
}
