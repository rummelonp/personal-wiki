/**
 * 検索の索引に入れる文字列と検索語に掛ける正規化。trigram は全角英数や半角カナを畳まないので、
 * 保存側と検索側で必ず同じ関数を通す。
 */
export function foldForSearch(text: string): string {
  return text.normalize("NFKC");
}

/**
 * trigram の索引で引ける検索語の最小の長さ（code point の数）。これより短い語は索引で引けず、
 * サーバーは本文を全ページ走査して照合する。
 */
export const TRIGRAM_MIN_CHARS = 3;

/**
 * ログインしていない検索の最小の長さ。全ページの走査は 1 回で数千行を読み、D1 の読み取りの無料枠を
 * 少ない要求で使い切れるので、匿名には索引で引ける長さだけを許す。owner と token は短い語も探せる。
 */
export const ANONYMOUS_SEARCH_MIN_CHARS = TRIGRAM_MIN_CHARS;

/**
 * サーバーが照合に使う形（foldForSearch の後に前後の空白を除いたもの）での検索語の長さ。
 * TRIGRAM_MIN_CHARS との比較はこの値で行う。NFKC で文字数が変わる語（半角カナの濁点、`㌀` など）がある。
 */
export function searchQueryLength(raw: string): number {
  return [...foldForSearch(raw).trim()].length;
}
