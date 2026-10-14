/*
 * ページを開く直前に分かっている id → title。`/p/<id>` を開いて本文を取っている間、
 * title だけは先に出せるようにする（URL に title が無いため）。
 * history.state には置かない。戻るの復元（scroll-restore）が state の形を決めているので触れない。
 */
const titles = new Map<string, string>();

export function rememberTitle(id: string, title: string): void {
  titles.set(id, title);
}

export function recallTitle(id: string): string | undefined {
  return titles.get(id);
}

/** ログアウトの後に、draft だった title を匿名の画面へ持ち越さない。 */
export function forgetTitles(): void {
  titles.clear();
}
