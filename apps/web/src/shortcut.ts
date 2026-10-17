/** 呼び出しごとに読む。起動後に変わらないが、テストが userAgent を差し替えられるようにする。 */
function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(globalThis.navigator?.userAgent ?? "");
}

export function switcherShortcutLabel(): string {
  return isMac() ? "⌘K" : "Ctrl K";
}

export function switcherShortcutKeys(): string {
  return isMac() ? "Meta+K" : "Control+K";
}

/**
 * quick switcher を開閉するキーか。Mac は ⌘ だけ、それ以外は Ctrl だけを受ける。Mac の Ctrl+K は
 * CodeMirror が「行末まで削除」に使い、両方を受けると削除と switcher が同時に動く。
 * 編集コンポーネントなどが先に処理したキー（defaultPrevented）と、押しっぱなしの繰り返しは受けない。
 */
export function isSwitcherShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.key.toLowerCase() !== "k") return false;
  return isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
