import { Fragment, type ReactNode } from "react";

export interface TextSegment {
  text: string;
  marked: boolean;
}

interface Unit {
  /** text の中の範囲（UTF-16） */
  start: number;
  end: number;
  /** 検索と同じ NFKC に畳み、大文字小文字をそろえた文字列 */
  folded: string;
}

/** 基底の文字とそれに続く結合文字を 1 つにする。NFKC で合成される組（か + 濁点など）を分けないため。 */
function unitsOf(text: string): Unit[] {
  const units: Unit[] = [];
  let offset = 0;
  for (const char of text) {
    const end = offset + char.length;
    const last = units.at(-1);
    if (last !== undefined && /^\p{M}/u.test(char)) last.end = end;
    else units.push({ start: offset, end, folded: "" });
    offset = end;
  }
  for (const unit of units) {
    unit.folded = text.slice(unit.start, unit.end).normalize("NFKC").toLowerCase();
  }
  return units;
}

/** 語は空白を含めて文字どおりに当てる。検索 API の trigram も、空白を含む語を 1 つの並びとして照合する。 */
function foldNeedles(needles: readonly string[]): string[] {
  return needles
    .map((needle) => needle.normalize("NFKC").toLowerCase().trim())
    .filter((needle) => needle !== "");
}

/**
 * text を、needles のどれかに当たる部分とそれ以外に分ける。
 * 検索 API と同じく、大文字小文字を区別せず、全角英数や半角カナは NFKC で畳んで比べる。
 * 畳むと長さが変わる文字があるので、畳んだ文字列での位置を元の文字の範囲に戻して切る。
 */
export function splitMatches(text: string, needles: readonly string[]): TextSegment[] {
  const folds = foldNeedles(needles);
  if (folds.length === 0 || text === "") return [{ text, marked: false }];

  const units = unitsOf(text);
  const folded = units.map((unit) => unit.folded).join("");
  // 畳んだ文字列の位置から、それを作った unit の番号を引く
  const owner: number[] = [];
  units.forEach((unit, i) => {
    for (let k = 0; k < unit.folded.length; k++) owner.push(i);
  });

  // 語ごとに探して範囲をまとめる。語どうしが重なる当たり（abc と cde）も 1 つの範囲になる
  const found: Array<[number, number]> = [];
  for (const needle of folds) {
    for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, at + 1)) {
      const first = owner[at];
      const last = owner[at + needle.length - 1];
      if (first !== undefined && last !== undefined) {
        found.push([(units[first] as Unit).start, (units[last] as Unit).end]);
      }
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  const ranges: Array<[number, number]> = [];
  for (const [start, end] of found) {
    const previous = ranges.at(-1);
    if (previous !== undefined && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else ranges.push([start, end]);
  }
  if (ranges.length === 0) return [{ text, marked: false }];

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), marked: false });
    segments.push({ text: text.slice(start, end), marked: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), marked: false });
  return segments;
}

/** 当たった部分を `<mark>` で囲む。要素で組むので、text が HTML として解釈されることはない。 */
export function highlightMatches(text: string, needles: readonly string[]): ReactNode {
  const segments = splitMatches(text, needles);
  if (segments.length === 1 && !(segments[0] as TextSegment).marked) return text;
  return segments.map((segment, i) => {
    const key = `${i}-${segment.text}`;
    return segment.marked ? (
      <mark key={key}>{segment.text}</mark>
    ) : (
      <Fragment key={key}>{segment.text}</Fragment>
    );
  });
}
