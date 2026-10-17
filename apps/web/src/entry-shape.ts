/*
 * 直前に受け取った一覧で、タグの有る行が多かったか。読み込み中のスケルトンの行の高さを、
 * 本物の行に合わせるために使う。タグの有る行はチップの帯の分だけ高く、合わせないと読み込みが終わった
 * 瞬間に 2 行目から下がずれる。
 *
 * 前の一覧の行の形を 1 行ずつ写さず、多数かどうかだけを持つ。絞り込みを変えると中身が入れ替わって
 * 1 行ずつの形は当たらず、写す分だけコードも増える。
 *
 * module の変数に置く。保存先に sessionStorage を使うと、読めない環境の分岐が増える。
 * 再読み込みで消えても、その後の最初の読み込みはタグの無い行（受け取っていないときの既定）で出すだけである。
 * 数えるのは、受け取った一覧の全体（「さらに表示」で足した分を含む）。一番新しい一覧が、
 * 次に開く一覧の形に最も近い。件数が同数なら、タグの無い行を取る。
 */
let taggedRowsMajority = false;

/** 空の一覧は形の手がかりにならないので、覚えているものを残す。 */
export function rememberEntryShape(entries: readonly { tags: readonly unknown[] }[]): void {
  if (entries.length === 0) return;
  const tagged = entries.filter((entry) => entry.tags.length > 0).length;
  taggedRowsMajority = tagged * 2 > entries.length;
}

/** スケルトンの行にチップの帯を足すか。まだ一覧を受け取っていないときは足さない。 */
export function expectTaggedRows(): boolean {
  return taggedRowsMajority;
}

export function forgetEntryShape(): void {
  taggedRowsMajority = false;
}
