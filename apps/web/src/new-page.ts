import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { navigate, newPageHref } from "./route";

/** 新規作成の画面を開いた 1 回分。 */
export interface NewPageRequest {
  /** 開くたびに増える。`/?new` を開いたまま開き直しても、編集の画面を作り直す合図にする */
  serial: number;
  /** title 欄の初期値。空でなければ、開いてすぐに作る */
  title: string;
}

let current: NewPageRequest = { serial: 0, title: "" };
const listeners = new Set<() => void>();
const leaving = new Set<() => void>();

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

// 戻る・進むで `/?new` に来たときは、前に渡した title で作り直さない（作ったページと title が重なる）。
// serial は変えない。変えると、`/?new` のまま hash だけ戻ったときにも編集の画面が作り直される
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    if (current.title !== "") publish({ serial: current.serial, title: "" });
  });
}

export function useNewPageRequest(): NewPageRequest {
  return useSyncExternalStore(subscribe, () => current);
}

/**
 * 開いている編集の画面が、新規作成の画面に移る直前に退避を書く手順を登録する。戻り値で外す。
 *
 * 作る前のページの退避は 1 つの key を共有する。次の画面のセッションは描画の中で退避を読み、
 * 前の画面の unmount（で呼ぶ leave）はその後に走るので、移る前に書いておかないと、次の画面が
 * 前の内容を知らずに同じ key を上書きする。
 */
export function registerLeaveBeforeNewPage(leave: () => void): () => void {
  leaving.add(leave);
  return () => {
    leaving.delete(leave);
  };
}

/**
 * 新規作成の画面を開く。title を渡すと本文に、渡さなければ title 欄にカーソルを置く。
 *
 * クリックなどの操作の中で呼ぶこと。iOS の Safari は、操作の中で focus した入力欄にだけ
 * キーボードを出すので、flushSync で画面と editor の mount（autoFocus の effect）までを
 * この呼び出しの中で済ませる。
 */
export function openNewPage(options: { title?: string } = {}): void {
  for (const leave of [...leaving]) leave();
  flushSync(() => {
    publish({ serial: current.serial + 1, title: options.title ?? "" });
    navigate(newPageHref);
  });
}
