import { caseFold } from "@personal-wiki/domain/title";
import { Fragment, type ReactNode } from "react";

export interface TextSegment {
  text: string;
  marked: boolean;
}

interface Unit {
  /** text の中の範囲（UTF-16） */
  start: number;
  end: number;
  /** NFKC に畳み、title の比較（foldTitle）と同じ case fold をかけた文字列 */
  folded: string;
}

const nfkc = (text: string) => text.normalize("NFKC");

/**
 * 前の文字と NFKC で合成される文字を、前の文字と 1 つにする（か + 結合濁点、半角の「ｶ」+「ﾞ」、分解された Hangul の字母）。
 * 半角の濁点 U+FF9E は一般カテゴリが Lm で結合文字（\p{M}）に当たらないので、合成の有無で判定する。
 * 分けると、畳んだ「が」の位置を元の文字の範囲に戻せず、強調が外れる。
 */
function unitsOf(text: string): Unit[] {
  const units: Unit[] = [];
  let offset = 0;
  for (const char of text) {
    const end = offset + char.length;
    const last = units.at(-1);
    if (
      last !== undefined &&
      nfkc(text.slice(last.start, end)) !== nfkc(text.slice(last.start, offset)) + nfkc(char)
    ) {
      last.end = end;
    } else units.push({ start: offset, end, folded: "" });
    offset = end;
  }
  for (const unit of units) {
    unit.folded = caseFold(nfkc(text.slice(unit.start, unit.end)));
  }
  return units;
}

/** 語は空白を含めて文字どおりに当てる。検索 API の trigram も、空白を含む語を 1 つの並びとして照合する。 */
function foldNeedles(needles: readonly string[]): string[] {
  return needles.map((needle) => caseFold(nfkc(needle)).trim()).filter((needle) => needle !== "");
}

/**
 * text を、needles のどれかに当たる部分とそれ以外に分ける。
 * 大文字小文字を区別せず、全角英数や半角カナは NFKC で畳んで比べる。
 * case fold は title の比較（foldTitle）と同じ規則で、quick switcher の絞り込みと一致箇所がずれない。
 * 検索 API は ß や ς を畳まないので、検索結果ではそれらの語だけ API の一致より広く塗ることがある。
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
