// 保存した NUL は、SQLite の length() と LIKE を NUL で止める。NUL より後ろの語は 2 文字以下の
// 検索（LIKE）で引けず、抜粋の長さも狂う。書き込みで受けなければ防げるので、保存の前に拒む。
const NUL = "\u0000";

// 改行とタブは singleLineTitle が空白にするので、この検査は畳んだ後の title に掛ける。
// 1 行の title に混ぜる用途の無い制御文字は、残りをすべて拒む
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を検出するのが目的
const TITLE_CONTROL_CHARS = /[\u0000-\u001f]/;

/** 本文と追記の text が NUL を含むか。タブ、改行、復帰を含め、NUL 以外の制御文字は受ける。 */
export function textHasNul(text: string): boolean {
  return text.includes(NUL);
}

/** title が C0 の制御文字（NUL など）を含むか。`singleLineTitle` の後の title に使う。 */
export function titleHasControlChar(title: string): boolean {
  return TITLE_CONTROL_CHARS.test(title);
}
