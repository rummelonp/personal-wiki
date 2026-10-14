import { describe, expect, it } from "vitest";
import { searchQueryLength } from "./search";

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
