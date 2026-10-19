export interface BodyEdit {
  old: string;
  new: string;
}

/** 失敗した edit の 1 件。index は edits の中の位置（0 始まり） */
export type BodyEditFailure =
  | { index: number; reason: "empty_old" }
  | { index: number; reason: "not_found" }
  /** matches は一致の数を 2 で打ち切った値で、2 は「2 か所以上」を表す */
  | { index: number; reason: "ambiguous"; matches: number }
  /** with は、本文でこの edit より先に始まった edit のうち、最も後ろまで届くものの index */
  | { index: number; reason: "overlap"; with: number };

/**
 * 適用の順序で結果が変わらないよう、すべての old を「適用する前の本文」に対して数える。
 * 先の edit の new に後の edit の old が現れても、それには一致しない。
 *
 * 一致は完全一致で、重なる一致も数える（"aa" は "aaa" に 2 件）。2 件以上なら位置を決められないので
 * 失敗にする。失敗は最初の 1 件で止めず、直すために全件を返す。
 */
export function applyBodyEdits(
  body: string,
  edits: readonly BodyEdit[],
): { ok: true; body: string } | { ok: false; failures: BodyEditFailure[] } {
  const failures: BodyEditFailure[] = [];
  const located: { index: number; start: number; end: number }[] = [];
  edits.forEach((edit, index) => {
    // "" はどの位置にも一致して数えきれない。入力の schema でも弾くが、ここでも無限ループにしない
    if (edit.old === "") {
      failures.push({ index, reason: "empty_old" });
      return;
    }
    const matches = countMatches(body, edit.old);
    if (matches.count === 0) failures.push({ index, reason: "not_found" });
    else if (matches.count > 1)
      failures.push({ index, reason: "ambiguous", matches: matches.count });
    else located.push({ index, start: matches.first, end: matches.first + edit.old.length });
  });
  // 位置が決まった edit どうしだけを比べる。一致しなかった edit には位置が無い
  const byStart = located.toSorted((a, b) => a.start - b.start);
  let furthest: (typeof located)[number] | undefined;
  for (const current of byStart) {
    if (furthest !== undefined && current.start < furthest.end) {
      failures.push({ index: current.index, reason: "overlap", with: furthest.index });
    }
    if (furthest === undefined || current.end > furthest.end) furthest = current;
  }
  if (failures.length > 0) return { ok: false, failures: failures.toSorted(byIndex) };

  let result = "";
  let cursor = 0;
  for (const { index, start, end } of byStart) {
    result += body.slice(cursor, start) + (edits[index] as BodyEdit).new;
    cursor = end;
  }
  return { ok: true, body: result + body.slice(cursor) };
}

function byIndex(a: BodyEditFailure, b: BodyEditFailure): number {
  return a.index - b.index;
}

/**
 * 一致を 2 件目で数えるのをやめる。1 件か 2 件以上かが分かれば足り、重なる一致をすべて数えると
 * 同じ文字が続く本文と長い old で 本文長 × old 長 の時間がかかる。
 */
export function countMatches(body: string, needle: string): { count: 0 | 1 | 2; first: number } {
  const first = body.indexOf(needle);
  if (first === -1) return { count: 0, first };
  return { count: body.indexOf(needle, first + 1) === -1 ? 1 : 2, first };
}
