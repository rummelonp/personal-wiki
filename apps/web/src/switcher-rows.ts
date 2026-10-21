import { ANONYMOUS_SEARCH_MIN_CHARS, searchQueryLength } from "@personal-wiki/domain/search";
import { foldTitle } from "@personal-wiki/domain/title";
import type { PageCandidate } from "@personal-wiki/editor/page-index";

/**
 * 先頭の行が Enter の既定で、選択と Enter の動作を同じ配列から引く。並びは次のとおり。
 * - title が完全に一致するページがあるとき: 候補、「本文から検索」。既定はその完全一致のページ。
 * - 無いとき: 「本文から検索」、候補、「作成」。既定は「本文から検索」。
 * 語を打って Enter しただけで要らないページができないよう、「作成」は既定にせず末尾に置く。
 * 候補の取得に失敗して 1 件も無いときは、title の完全一致を確かめられないので「作成」を出さない。
 * 匿名が本文を検索できる長さに満たない間は、行き止まりの画面へ移さないよう「本文から検索」を出さない。
 * 検索結果の画面で開いて語を消したときは、先頭に「検索を解除」の行を置き、Enter で最近の更新へ戻す。
 * 結果の画面に語を直す欄が無いので、語を空にして確定する手段をここに持つ。
 */
export type Row =
  | { kind: "page"; candidate: PageCandidate }
  | { kind: "create" }
  | { kind: "content-search" }
  | { kind: "clear-search" };

// 選択は位置でなく行の識別子で持つ。候補が後から変わっても、選んでいる行に追従させる
export function rowKey(row: Row): string {
  return row.kind === "page" ? `page-${row.candidate.id}` : row.kind;
}

export interface BuildRowsInput {
  /** 入力語の前後の空白を除いたもの */
  trimmed: string;
  owner: boolean;
  /** 開いたときに入力欄へ入れた語。語を空にしたとき「検索を解除」の行を出すかの判断に使う */
  initialQuery: string;
  /** `trimmed` で絞った候補。先頭が最も一致する */
  candidates: readonly PageCandidate[];
  /** 1 回目の取得が済んだか */
  settled: boolean;
  /** 取得に失敗して候補が取れていないか */
  failed: boolean;
}

export interface BuiltRows {
  rows: Row[];
  /** 「検索を解除」の行があるか */
  hasClearRow: boolean;
  /** 匿名が本文を検索できる長さに満たないか */
  contentSearchTooShort: boolean;
  /** 語があり、取得が済んで失敗もしておらず、並べる行が 1 つも無いか */
  noMatch: boolean;
}

export function buildRows({
  trimmed,
  owner,
  initialQuery,
  candidates,
  settled,
  failed,
}: BuildRowsInput): BuiltRows {
  // 部分一致の候補があるだけで「作成」を隠すと、「メモ」を作れなくなる。完全一致が無いときに出す。
  // 完全一致は score が最上位なので、上限で切った候補の先頭に必ず入っている
  const hasExactTitle =
    candidates[0] !== undefined && foldTitle(candidates[0].title) === foldTitle(trimmed);
  const contentSearchTooShort =
    trimmed !== "" && !owner && searchQueryLength(trimmed) < ANONYMOUS_SEARCH_MIN_CHARS;
  const pageRows = candidates.map((candidate): Row => ({ kind: "page", candidate }));
  const contentSearchRows: Row[] =
    trimmed !== "" && !contentSearchTooShort ? [{ kind: "content-search" }] : [];
  const createRows: Row[] =
    trimmed !== "" && owner && !hasExactTitle && settled && !failed ? [{ kind: "create" }] : [];
  const clearRows: Row[] =
    trimmed === "" && initialQuery.trim() !== "" ? [{ kind: "clear-search" }] : [];
  const rows: Row[] = hasExactTitle
    ? [...pageRows, ...contentSearchRows]
    : [...clearRows, ...contentSearchRows, ...pageRows, ...createRows];
  return {
    rows,
    hasClearRow: clearRows.length > 0,
    contentSearchTooShort,
    // 行が 1 つでもあれば、一致が無いことは並びから分かる。行が無いのは、匿名が本文を検索できない短い語で
    // 候補も無いときだけ
    noMatch: trimmed !== "" && settled && !failed && rows.length === 0,
  };
}
