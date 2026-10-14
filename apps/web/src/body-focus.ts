/**
 * 作った直後のページを開くとき、本文のエディタにカーソルを置くための印。
 *
 * ページの URL を開く経路は、一覧からの遷移も戻る操作も同じなので、URL や履歴の state には
 * 持たせない（戻るたびにモバイルのキーボードが出る）。作成した本人が直後に開く 1 回だけに
 * 効かせるため、メモリ上に page id を 1 つ持つ。title は作成時に決まっているので、
 * 続けて打つのは本文である。
 */
let requested: string | null = null;

export function requestBodyFocus(pageId: string): void {
  requested = pageId;
}

/** 印を消さない。StrictMode が初期化を 2 回走らせても、同じ答えを返すため */
export function wantsBodyFocus(pageId: string): boolean {
  return requested === pageId;
}

export function clearBodyFocusRequest(pageId: string): void {
  if (requested === pageId) requested = null;
}
