import { err, ok, type Result } from "./result";

declare const titleKeyBrand: unique symbol;

/**
 * 正規化済みの page title。`normalizeTitleKey` だけが作る。
 *
 * 生の title 文字列を title_key として DB やリンク解決に渡す取り違えを型で止める。
 */
export type TitleKey = string & { readonly [titleKeyBrand]: true };

export type TitleKeyError = { readonly kind: "empty_title" };

/**
 * `toLowerCase` では Unicode の default case fold と異なる結果になる既知の文字だけの例外表。
 * 波ダッシュ等、NFKC で吸収されない他の表記ゆれは意図的に対象外。
 * `toLowerCase` の後に引く。`toLowerCase` は語末の `Σ` を `ς` にする（"ΑΣ" -> "ας"）ので、
 * 先に引くと "ΑΣ" と "ασ" が別の key になる。`ẞ` は `toLowerCase` で `ß` になる。
 */
const CASE_FOLD_EXCEPTIONS: Readonly<Record<string, string>> = {
  ß: "ss",
  ς: "σ",
};

function caseFold(text: string): string {
  return text.toLowerCase().replace(/[ßς]/g, (ch) => CASE_FOLD_EXCEPTIONS[ch] ?? ch);
}

/**
 * title_key と同じ比較規則で文字列を畳む。空文字列も返す全域関数。
 *
 * NFKC 正規化で全角/半角の英数・記号ゆれ（例: "Ａ" -> "A", "ｱ" -> "ア"）を吸収し、
 * 前後の空白を trim、連続する空白を単一スペースへ畳んでから case fold する。
 * autocomplete の入力途中の query のように、空でありうる文字列を title と突き合わせるときに使う。
 */
export function foldTitle(text: string): string {
  return caseFold(text.normalize("NFKC").trim().replace(/\s+/g, " "));
}

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/g;

/**
 * title の入力文字列を、`pages.title` に保存する 1 行の title にする。
 * 改行は 1 つずつ空白に置き換え、前後の空白を trim する。
 * title が 1 行であることは入力側だけでは保証できないので、Editor の入力 filter とこの関数の 2 か所で防ぐ。
 */
export function singleLineTitle(text: string): string {
  return text.replace(LINE_BREAK, " ").trim();
}

/** WikiLink の構文（`[[target|label]]`、`#heading`、`^blockid`）と重なり、target に書けない文字 */
const WIKILINK_UNSAFE_CHARS = ["[", "]", "|", "#", "^"] as const;

/**
 * title に含まれる、WikiLink の target にできない文字を出現順に重複なく返す。
 * こうした title も保存はできる（既存の note 名を import で拒めない）が、WikiLink からは
 * 辿れないので、title 欄に警告を出すために使う。
 *
 * 末尾の `\` も返す。label 付きの link では、後ろの `|` と合わせて区切り `\|` と読まれ、
 * target から外れる。rename の Rewrite links が `[[A|B]]` を `[[C\|B]]` の形に書き換えると、
 * 解決先が変わってしまう。
 */
export function wikiLinkUnsafeChars(title: string): string[] {
  const unsafe = WIKILINK_UNSAFE_CHARS.filter((ch) => title.includes(ch)).sort(
    (a, b) => title.indexOf(a) - title.indexOf(b),
  );
  return title.endsWith("\\") ? [...unsafe, "\\"] : unsafe;
}

/**
 * page title から一意キー（title_key）を算出する。
 *
 * このキーの一意制約は unique(title_key) where deleted_at is null で担保する。
 * WikiLink の解決も同じ関数を通す必要があるため、正規化ロジックはこの 1 箇所にだけ置く
 * （DB 側の generated column にはしない）。
 */
export function normalizeTitleKey(title: string): Result<TitleKey, TitleKeyError> {
  const key = foldTitle(title);
  if (key.length === 0) {
    return err({ kind: "empty_title" });
  }
  return ok(key as TitleKey);
}
