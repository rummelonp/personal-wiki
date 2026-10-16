import { describe, expect, it } from "vitest";
import {
  checkPageInput,
  findControlChar,
  findNul,
  MAX_BODY_BYTES,
  MAX_TITLE_BYTES,
  utf8ByteLength,
} from "./page-input";

// domain は実行環境の型を読まないので、照合に使う TextEncoder の型だけをここで宣言する
declare const TextEncoder: new () => { encode(text: string): Uint8Array };

const encoded = (text: string) => new TextEncoder().encode(text).length;

describe("utf8ByteLength", () => {
  it("TextEncoder と同じバイト数を返す", () => {
    for (const text of [
      "",
      "abc",
      "é", // 2 バイト
      "ߩ", // 2 バイトの上端 U+07FF の手前
      "߿",
      "ࠀ", // 3 バイトの下端
      "あ",
      "￿",
      "😀", // サロゲートペアで 4 バイト
      "a😀b👨‍👩‍👧",
      "\ud83d", // 対にならない high
      "\ude00", // 対にならない low
      "a\ude00\ud83d", // low が先、末尾が high
      "\ud83d😀", // high が続いた後の対
      "abc\ud83d", // 末尾の high
    ]) {
      expect(utf8ByteLength(text), JSON.stringify(text)).toBe(encoded(text));
    }
  });
});

describe("findControlChar", () => {
  it("C0 と DEL を見つけ、C0 の外の文字は見逃す", () => {
    for (let code = 0; code <= 0x1f; code++) {
      expect(findControlChar(`a${String.fromCharCode(code)}b`)?.index).toBe(1);
    }
    expect(findControlChar("a\u007fb")).toEqual({
      index: 1,
      line: 1,
      column: 2,
      codePoint: "U+007F",
    });
    expect(findControlChar("a\u0080b c")).toBeNull();
    expect(findControlChar("")).toBeNull();
  });

  it("column は絵文字を 1 文字と数える", () => {
    expect(findControlChar("😀😀\u0001")).toEqual({
      index: 4,
      line: 1,
      column: 3,
      codePoint: "U+0001",
    });
  });
});

describe("findNul", () => {
  it("NUL だけを見つけ、タブ、改行、ほかの制御文字は見逃す", () => {
    expect(findNul("a\tb\r\nc\nd\u0001\u001f\u007f")).toBeNull();
    expect(findNul("会議メモ")).toBeNull();
    expect(findNul("end\u0000")?.index).toBe(3);
  });

  it("行と列を、\\r\\n を 1 つの改行、行頭、絵文字の後で数える", () => {
    expect(findNul("\u0000")).toEqual({ index: 0, line: 1, column: 1, codePoint: "U+0000" });
    expect(findNul("a\r\nb\r\n\u0000")).toEqual({
      index: 6,
      line: 3,
      column: 1,
      codePoint: "U+0000",
    });
    expect(findNul("1\n2\n😀あ\u0000")).toEqual({
      index: 7,
      line: 3,
      column: 3,
      codePoint: "U+0000",
    });
    // 行頭が改行そのものの文字列でも、前の行に数えない
    expect(findNul("\n\u0000")).toEqual({ index: 1, line: 2, column: 1, codePoint: "U+0000" });
  });
});

describe("checkPageInput", () => {
  const check = (title: string, body = "") =>
    checkPageInput(title, body, { checkControlChars: true });

  it("1 行の title、title_key、バイト数を返し、問題が無ければ problems は空", () => {
    const result = check(" a\r\nb\tc ", "本文");
    expect(result).toEqual({
      title: "a b c",
      titleKey: "a b c",
      titleBytes: 5,
      bodyBytes: 6,
      problems: [],
    });
  });

  it("title の DEL を拒み、生の改行とタブは空白にして通す", () => {
    expect(check("a\u007fb").problems).toEqual([
      {
        reason: "control_char",
        field: "title",
        at: { index: 1, line: 1, column: 2, codePoint: "U+007F" },
      },
    ]);
    expect(check("a\nb\tc").problems).toEqual([]);
  });

  it("title の位置は 1 行に整えた後の title で数える", () => {
    expect(check("  x\ny\u0001").problems).toEqual([
      {
        reason: "control_char",
        field: "title",
        at: { index: 3, line: 1, column: 4, codePoint: "U+0001" },
      },
    ]);
  });

  it("title の上限の境目を UTF-8 のバイト数で決める", () => {
    expect(check("a".repeat(MAX_TITLE_BYTES)).problems).toEqual([]);
    expect(check("a".repeat(MAX_TITLE_BYTES + 1)).problems).toEqual([
      { reason: "title_too_long", bytes: MAX_TITLE_BYTES + 1, max: MAX_TITLE_BYTES },
    ]);
    // 絵文字（4 バイト）が境目をまたぐ
    const straddle = `${"a".repeat(MAX_TITLE_BYTES - 2)}😀`;
    expect(check(straddle).problems).toEqual([
      { reason: "title_too_long", bytes: MAX_TITLE_BYTES + 2, max: MAX_TITLE_BYTES },
    ]);
  });

  it("本文の上限の境目を UTF-8 のバイト数で決める", () => {
    expect(check("t", "a".repeat(MAX_BODY_BYTES)).problems).toEqual([]);
    expect(check("t", "a".repeat(MAX_BODY_BYTES + 1)).problems).toEqual([
      { reason: "body_too_large", bytes: MAX_BODY_BYTES + 1, max: MAX_BODY_BYTES },
    ]);
    const straddle = `${"a".repeat(MAX_BODY_BYTES - 1)}😀`;
    expect(check("t", straddle).problems).toEqual([
      { reason: "body_too_large", bytes: MAX_BODY_BYTES + 3, max: MAX_BODY_BYTES },
    ]);
  });

  it("問題をすべて、空の title、title の制御文字、本文の NUL、title の超過、本文の超過の順に返す", () => {
    const longTitle = `${"a".repeat(MAX_TITLE_BYTES)}\u0001`;
    const body = `\u0000${"b".repeat(MAX_BODY_BYTES)}`;
    expect(check(longTitle, body).problems.map((p) => p.reason)).toEqual([
      "control_char",
      "control_char",
      "title_too_long",
      "body_too_large",
    ]);
    const empty = check("   ", "a".repeat(MAX_BODY_BYTES + 1));
    expect(empty.titleKey).toBeNull();
    expect(empty.problems.map((p) => p.reason)).toEqual(["invalid_title", "body_too_large"]);
  });

  it("checkControlChars が false なら制御文字を調べない", () => {
    const result = checkPageInput("a\u0001", "b\u0000", { checkControlChars: false });
    expect(result.problems).toEqual([]);
  });
});
