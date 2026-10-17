import { CONTROL_CHAR } from "./control-char";
import { normalizeTitleKey, singleLineTitle, type TitleKey } from "./title";

/**
 * 本文の上限（UTF-8 のバイト数）。保存のたびに本文の Markdown を解析して派生データを作るので、
 * Workers Free の CPU 10ms で決める。dev の Mac（Node、warm）で解析を測った値:
 *   リンクと強調の多い本文: 28KB で 8.5ms、100KB で 24.8ms、286KB で 69ms、1MB で約 260〜300ms
 *   平文: 22KB で 3.4ms、219KB で 21ms
 * リンクの多い本文では 64KiB でも 10ms を超えうる。本番の CPU 時間を測ってから見直す。
 * D1 の 1 行 2MB（revisions の行は title と body を両方持つ）には、この上限なら十分収まる。
 */
export const MAX_BODY_BYTES = 65_536;

/**
 * title の上限（UTF-8 のバイト数）。title は一覧やリンクの解決で何度も読み書きし、title_key の
 * インデックスにも入るので、本文と別に小さく抑える。
 */
export const MAX_TITLE_BYTES = 1024;

/**
 * UTF-8 にしたときのバイト数。TextEncoder と同じく、対にならないサロゲートは U+FFFD の 3 バイトと数える。
 * 入力のたびに本文全体を数えるので、配列を作らずに数える。
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (isSurrogatePairAt(text, i)) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isSurrogatePairAt(text: string, i: number): boolean {
  const high = text.charCodeAt(i);
  const low = text.charCodeAt(i + 1);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/** 文字列の中の 1 文字の位置。 */
export interface CharAt {
  /** UTF-16 の位置（0 始まり）。エディタの選択を動かすのに使う */
  index: number;
  /** 1 始まり。`\n` で区切るので `\r\n` も 1 つの改行になる。title は 1 行なので常に 1 */
  line: number;
  /** 行頭からのコードポイントの数（1 始まり）。人に「N 文字目」と伝える値 */
  column: number;
  /** `U+0001` の形 */
  codePoint: string;
}

function positionOf(text: string, index: number): CharAt {
  const lineStart = index === 0 ? 0 : text.lastIndexOf("\n", index - 1) + 1;
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < lineStart; i = text.indexOf("\n", i + 1)) {
    line++;
  }
  let column = 1;
  for (let i = lineStart; i < index; i++) {
    if (isSurrogatePairAt(text, i)) i++;
    column++;
  }
  const hex = text.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0");
  return { index, line, column, codePoint: `U+${hex}` };
}

/** 最初の C0 の制御文字か DEL の位置。title と検索語が拒む文字で、改行とタブも含む。 */
export function findControlChar(text: string): CharAt | null {
  const match = CONTROL_CHAR.exec(text);
  return match === null ? null : positionOf(text, match.index);
}

/**
 * 最初の NUL の位置。本文と追記の text で拒むのは NUL だけで、タブや改行などほかの制御文字は受ける。
 *
 * 保存した NUL は、SQLite の length() と LIKE を NUL で止める。NUL より後ろの語は 2 文字以下の
 * 検索（LIKE）で引けず、抜粋の長さも狂う。書き込みで受けなければ防げるので、保存の前に拒む。
 */
export function findNul(text: string): CharAt | null {
  const index = text.indexOf("\u0000");
  return index === -1 ? null : positionOf(text, index);
}

export type PageInputProblem =
  | { reason: "invalid_title" }
  | { reason: "control_char"; field: "title" | "body"; at: CharAt }
  | { reason: "title_too_long"; bytes: number; max: number }
  | { reason: "body_too_large"; bytes: number; max: number };

export interface PageInputCheck {
  /** 保存する 1 行の title（singleLineTitle の後） */
  title: string;
  /** title が空か空白だけなら null */
  titleKey: TitleKey | null;
  titleBytes: number;
  bodyBytes: number;
  /** 見つかった問題のすべて。サーバーは先頭の 1 件を返す */
  problems: PageInputProblem[];
}

/**
 * 保存する title と本文が規則に合うかを調べる。成功しても title と本文のバイト数を返す。
 * 問題は途中で止めずにすべて返す。作る前のページで title が空の間も、本文の超過を出せるようにするため。
 *
 * checkControlChars が false なら制御文字を調べない。追記は既存の本文を渡し直すので、NUL を含む
 * 既存のページに追記できなくならないよう、呼び出し側で追記する text だけを調べる。
 */
export function checkPageInput(
  rawTitle: string,
  body: string,
  { checkControlChars }: { checkControlChars: boolean },
): PageInputCheck {
  const title = singleLineTitle(rawTitle);
  const key = normalizeTitleKey(title);
  const titleBytes = utf8ByteLength(title);
  const bodyBytes = utf8ByteLength(body);
  const problems: PageInputProblem[] = [];
  if (!key.ok) problems.push({ reason: "invalid_title" });
  if (checkControlChars) {
    // 改行とタブは singleLineTitle が空白にしたので、残りの制御文字だけがここで見つかる
    const titleAt = findControlChar(title);
    if (titleAt !== null) problems.push({ reason: "control_char", field: "title", at: titleAt });
    const bodyAt = findNul(body);
    if (bodyAt !== null) problems.push({ reason: "control_char", field: "body", at: bodyAt });
  }
  if (titleBytes > MAX_TITLE_BYTES) {
    problems.push({ reason: "title_too_long", bytes: titleBytes, max: MAX_TITLE_BYTES });
  }
  if (bodyBytes > MAX_BODY_BYTES) {
    problems.push({ reason: "body_too_large", bytes: bodyBytes, max: MAX_BODY_BYTES });
  }
  return { title, titleKey: key.ok ? key.value : null, titleBytes, bodyBytes, problems };
}
