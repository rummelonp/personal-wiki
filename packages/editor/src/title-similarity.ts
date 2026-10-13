/**
 * WikiLink autocomplete の候補表示専用の緩い類似度判定。
 * `title_key` の正規化（`@personal-wiki/domain/title` の `foldTitle`）は変更しない。
 * NFKC は波ダッシュ（U+301C）と全角チルダ由来の ASCII チルダ（U+007E）を統合しない
 * （両方とも他方への decomposition mapping を持たない）ため、ここで別途まとめる。
 */
const CONFUSABLE_GROUPS: readonly (readonly [string, ...string[]])[] = [
  ["〜", "～", "~", "⁓", "∼"],
];

const CONFUSABLE_MAP: ReadonlyMap<string, string> = new Map(
  CONFUSABLE_GROUPS.flatMap((group) => group.map((ch) => [ch, group[0]] as const)),
);

/** 同じ見た目の同値類にある文字を代表字へ畳む。`normalize` 済みの文字列に適用する。 */
export function collapseConfusables(text: string): string {
  let result = "";
  for (const ch of text) {
    result += CONFUSABLE_MAP.get(ch) ?? ch;
  }
  return result;
}

/**
 * a と b が 1 文字の挿入・削除・置換だけで一致するか（編集距離 <= 1）。
 * 候補生成は打鍵のたびに全ページに対して走るため、任意の編集距離を許す DP ではなく
 * O(length) の定数距離チェックにとどめる。
 */
export function isOneEditAway(a: string, b: string): boolean {
  const shorter = [...a];
  const longer = [...b];
  if (shorter.length > longer.length) return isOneEditAway(b, a);
  if (longer.length - shorter.length > 1) return false;

  let i = 0;
  let j = 0;
  let usedEdit = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
      continue;
    }
    if (usedEdit) return false;
    usedEdit = true;
    if (shorter.length === longer.length) i++; // 置換
    j++; // 削除・挿入
  }
  return true;
}
