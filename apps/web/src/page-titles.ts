import { foldTitle } from "@personal-wiki/domain";

/*
 * ページを開く直前に分かっている id → title。`/p/<id>` を開いて本文を取っている間、
 * title だけは先に出せるようにする（URL に title が無いため）。
 * history.state には置かない。戻るの復元（scroll-restore）が state の形を決めているので触れない。
 */
const titles = new Map<string, string>();

/*
 * title の key → title。title の URL は空白を `_` で表すので、URL の文字列のままでは `a b` のページを
 * 開く途中に `a_b` と出てしまう。開く直前に分かっている表記があれば、そちらを出す。
 */
const titlesByKey = new Map<string, string>();

export function rememberTitle(id: string, title: string): void {
  titles.set(id, title);
  titlesByKey.set(foldTitle(title), title);
}

export function recallTitle(id: string): string | undefined {
  return titles.get(id);
}

/** URL から取り出した title と同じページを指す、覚えている表記。 */
export function recallTitleFor(urlTitle: string): string | undefined {
  return titlesByKey.get(foldTitle(urlTitle));
}

/** ログアウトの後に、draft だった title を匿名の画面へ持ち越さない。 */
export function forgetTitles(): void {
  titles.clear();
  titlesByKey.clear();
}
