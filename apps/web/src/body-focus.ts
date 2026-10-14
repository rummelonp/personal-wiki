/**
 * 作った直後のページを開くとき、本文のエディタにカーソルを置くための印。
 *
 * ページの URL を開く経路は、一覧からの遷移も戻る操作も同じなので、URL や履歴の state には
 * 持たせない（戻るたびにモバイルのキーボードが出る）。作成した本人が直後に開く 1 回だけに
 * 効かせるため、メモリ上に page id を 1 つ持つ。title は作成時に決まっているので、
 * 続けて打つのは本文である。
 */
let requested: string | null = null;
let holder: HTMLInputElement | null = null;

/**
 * 本文が focus を受け取るまで、キーボードを出したままにする不可視の input を足して focus する。
 *
 * iOS は、キーボードが出ている間に編集可能な要素の間で focus を移すとキーボードを保つ。
 * 作成のダイアログを閉じると title の input が blur してキーボードが閉じ、本文の focus は
 * ページの取得後（ユーザー操作の外）になるので、そのままではキーボードが出ない。
 * 閉じた直後に別の input へ focus を移して間をつなぎ、本文の focus で受け渡す（シミュレータで確認）。
 * キーボードが出ていない環境では、本文の focus までの間、画面に見えない要素が focus を持つだけである。
 *
 * font-size は 16px 未満だと iOS がページを拡大するため、16px にする。
 */
function holdKeyboard(): void {
  releaseKeyboard();
  if (typeof document === "undefined") return;
  const input = document.createElement("input");
  // aria-hidden は focus 中の要素に付けると支援技術の扱いが不定なので、名前を付けて残す。
  // autocomplete="off" は、iOS の QuickType や自動入力の候補を出さないため
  input.setAttribute("aria-label", "本文を準備中");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("data-body-focus-holder", "");
  input.tabIndex = -1;
  Object.assign(input.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    padding: "0",
    border: "0",
    opacity: "0",
    pointerEvents: "none",
    fontSize: "16px",
  });
  // 本文が focus を取った、または利用者が別の所へ移ったら役目は終わる
  input.addEventListener("blur", () => {
    if (holder === input) releaseKeyboard();
  });
  document.body.append(input);
  input.focus({ preventScroll: true });
  holder = input;
}

function releaseKeyboard(): void {
  // 外すと blur が発火して blur の側から再び呼ばれるので、先に参照を手放す
  const current = holder;
  holder = null;
  current?.remove();
}

export function requestBodyFocus(pageId: string): void {
  requested = pageId;
  holdKeyboard();
}

/** 印を消さない。StrictMode が初期化を 2 回走らせても、同じ答えを返すため */
export function wantsBodyFocus(pageId: string): boolean {
  return requested === pageId;
}

export function clearBodyFocusRequest(pageId: string): void {
  if (requested !== pageId) return;
  requested = null;
  releaseKeyboard();
}
