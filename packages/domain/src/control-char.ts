// title と検索語で拒む文字。1 行の文字列に混ぜる用途の無い C0 と DEL をまとめて拒む。
// 判定と除去で同じ定義を使うよう、ここにだけ書く
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を検出するのが目的
export const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

export const CONTROL_CHARS = new RegExp(CONTROL_CHAR.source, "g");
