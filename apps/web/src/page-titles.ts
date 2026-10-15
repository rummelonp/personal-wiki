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

/**
 * title の表記だけを覚える。まだ無いページへのリンクを押して移るとき、URL の文字列がそのまま title になる
 * ので、移った先の帯で `_` を空白に読み替えさせない。
 */
export function rememberTitleFor(title: string): void {
  titlesByKey.set(foldTitle(title), title);
}

export function recallTitle(id: string): string | undefined {
  return titles.get(id);
}

/** URL から取り出した title と同じページを指す、覚えている表記。 */
export function recallTitleFor(urlTitle: string): string | undefined {
  return titlesByKey.get(foldTitle(urlTitle));
}

/*
 * urlTitle（packages/domain の page-path.ts）が空白の並びを 1 つの `_` にした形。先頭、末尾、連続の `_` や
 * 空白を含む URL は、この形にならないので title の `_` そのものと見る。
 */
const UNDERSCORED_WORDS = /^[^\s_]+(?:_[^\s_]+)*$/;

/**
 * 開く途中の帯に出す title。覚えた表記が無いとき、`_` でつないだ URL は空白の title として出す。
 * 空白の title の方が `_` を含む title より多いので、この読み替えを既定にする。`_` を含む title は、
 * 開く前に表記が分かる経路（一覧、リンク）では覚えた表記が出る。URL の直接アクセスなどで
 * 覚えていないときだけ、取得が終わるまで空白で出て、終わると本当の title に変わる。
 */
export function loadingTitleFor(urlTitle: string): string {
  return (
    recallTitleFor(urlTitle) ??
    (UNDERSCORED_WORDS.test(urlTitle) ? urlTitle.replaceAll("_", " ") : urlTitle)
  );
}

/** ログアウトの後に、draft だった title を匿名の画面へ持ち越さない。 */
export function forgetTitles(): void {
  titles.clear();
  titlesByKey.clear();
}
