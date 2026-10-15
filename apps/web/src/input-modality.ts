/**
 * 直前の操作が pointer だったか。通知が見出しへ移す focus に、枠（:focus-visible）を付けるかを決める。
 *
 * ブラウザの既定では決められない。ボタンを押してから通信の結果を待って移す focus は、その前に本文を
 * 打っていた keyboard の履歴で枠が付く（Chromium で実測。マウスで「もう一度保存する」を押した後も出た）。
 * 押した要素はすでに消えていて、枠を持っていたかも読めないので、操作の種類を自分で覚える。
 */
let pointerLast = false;

const rememberKeyboard = (event: KeyboardEvent) => {
  // 修飾キーを伴う打鍵は、他のアプリへの切り替えなどで入るので、keyboard の操作と数えない
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  pointerLast = false;
};
const rememberPointer = () => {
  pointerLast = true;
};

/** 操作の種類を覚える listener を window に張る。capture 相なのは、途中の handler が止めても取り逃さないため。 */
export function trackInputModality(): () => void {
  window.addEventListener("keydown", rememberKeyboard, true);
  window.addEventListener("pointerdown", rememberPointer, true);
  return () => {
    window.removeEventListener("keydown", rememberKeyboard, true);
    window.removeEventListener("pointerdown", rememberPointer, true);
    pointerLast = false;
  };
}

/** script から focus を移す。直前の操作が pointer なら枠を出さず、keyboard ならブラウザの既定のまま枠で示す。 */
export function focusAfterInput(element: HTMLElement, options: FocusOptions = {}): void {
  element.focus(pointerLast ? { ...options, focusVisible: false } : options);
}
