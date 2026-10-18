import { describe, expect, it } from "vitest";
import { applyBodyEdits } from "./body-edits";

describe("applyBodyEdits", () => {
  it("一意に一致する old を、本文の位置の順に new へ置き換える", () => {
    expect(
      applyBodyEdits("a-b-c", [
        { old: "c", new: "C" },
        { old: "a", new: "A" },
      ]),
    ).toEqual({ ok: true, body: "A-b-C" });
  });

  it("new が空なら old を消し、old の前後は変えない", () => {
    expect(applyBodyEdits("前 削除 後", [{ old: " 削除", new: "" }])).toEqual({
      ok: true,
      body: "前 後",
    });
  });

  it("完全一致で探し、大文字小文字と改行の違いを区別する", () => {
    expect(applyBodyEdits("Abc\r\nabc", [{ old: "abc\n", new: "" }])).toMatchObject({
      ok: false,
      failures: [{ index: 0, reason: "not_found" }],
    });
    expect(applyBodyEdits("Abc\r\nabc", [{ old: "Abc\r\n", new: "" }])).toEqual({
      ok: true,
      body: "abc",
    });
  });

  it("重なる一致も数えるので、同じ文字の連続は一意にならない", () => {
    expect(applyBodyEdits("aaa", [{ old: "aa", new: "b" }])).toEqual({
      ok: false,
      failures: [{ index: 0, reason: "ambiguous", matches: 2 }],
    });
  });

  it("空の old は無限に一致しないよう empty_old で拒む", () => {
    expect(applyBodyEdits("abc", [{ old: "", new: "x" }])).toEqual({
      ok: false,
      failures: [{ index: 0, reason: "empty_old" }],
    });
  });

  it("重なる edit は、本文で後から始まる側を overlap にし、先に始まった edit のうち最も後ろまで届くものの index を添える", () => {
    expect(
      applyBodyEdits("0123456789", [
        { old: "23456", new: "" },
        { old: "01234", new: "" },
        { old: "345", new: "" },
      ]),
    ).toEqual({
      ok: false,
      failures: [
        { index: 0, reason: "overlap", with: 1 },
        { index: 2, reason: "overlap", with: 0 },
      ],
    });
  });

  it("失敗は最初の 1 件で止めず、index の順に全件返す", () => {
    expect(
      applyBodyEdits("xx yy", [
        { old: "x", new: "" },
        { old: "zz", new: "" },
        { old: "yy", new: "" },
      ]),
    ).toEqual({
      ok: false,
      failures: [
        { index: 0, reason: "ambiguous", matches: 2 },
        { index: 1, reason: "not_found" },
      ],
    });
  });

  it("new に現れた文字列には後の edit の old が一致しない", () => {
    expect(
      applyBodyEdits("one two", [
        { old: "one", new: "two" },
        { old: "two", new: "three" },
      ]),
    ).toEqual({ ok: true, body: "two three" });
  });
});
