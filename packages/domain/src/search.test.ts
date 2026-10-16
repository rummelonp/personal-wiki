import { describe, expect, it } from "vitest";
import { prepareSearchQuery, SEARCH_MAX_QUERY_CHARS, searchQueryLength } from "./search";

describe("searchQueryLength", () => {
  it("NFKC の後に前後の空白を除いた code point の数を返す", () => {
    expect(searchQueryLength("  ab　")).toBe(2);
    // 半角カナの濁点は前の文字と 1 文字になり、`㌀` は 4 文字に開く
    expect(searchQueryLength("ｶﾞｷ")).toBe(2);
    expect(searchQueryLength("㌀")).toBe(4);
    // サロゲートペアは 1 文字
    expect(searchQueryLength("𠮷野")).toBe(2);
  });
});

describe("prepareSearchQuery", () => {
  it("NFKC にそろえ、前後の空白を除く", () => {
    expect(prepareSearchQuery("  ＡＢＣ \n")).toEqual({ ok: true, query: "ABC" });
  });

  it("空や空白だけは empty", () => {
    expect(prepareSearchQuery(" 　")).toEqual({ ok: false, reason: "empty" });
  });

  it("途中のタブ、改行、NUL、DEL は control_char", () => {
    for (const raw of ["a\tb", "a\nb", "a\u0000", "a\u007fb"]) {
      expect(prepareSearchQuery(raw), JSON.stringify(raw)).toEqual({
        ok: false,
        reason: "control_char",
      });
    }
  });

  it(`${SEARCH_MAX_QUERY_CHARS} 文字まで受け、超えたら too_long。絵文字は 1 文字と数える`, () => {
    expect(prepareSearchQuery("a".repeat(SEARCH_MAX_QUERY_CHARS)).ok).toBe(true);
    expect(prepareSearchQuery("😀".repeat(SEARCH_MAX_QUERY_CHARS)).ok).toBe(true);
    expect(prepareSearchQuery("a".repeat(SEARCH_MAX_QUERY_CHARS + 1))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });
});
