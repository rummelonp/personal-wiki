import { describe, expect, it } from "vitest";
import { collapseConfusables, isOneEditAway } from "./title-similarity";

describe("collapseConfusables", () => {
  it("folds wave dash and tilde variants to the same representative", () => {
    const folded = new Set(["Vol.1〜2", "Vol.1～2", "Vol.1~2"].map(collapseConfusables));
    expect(folded.size).toBe(1);
  });

  it("leaves unrelated characters untouched", () => {
    expect(collapseConfusables("東京タワー")).toBe("東京タワー");
  });
});

describe("isOneEditAway", () => {
  it("accepts a single substitution", () => {
    expect(isOneEditAway("wikipedia", "wikipadia")).toBe(true);
  });

  it("accepts a single insertion or deletion", () => {
    expect(isOneEditAway("ウィキペディア", "ウィキペディ")).toBe(true);
    expect(isOneEditAway("ウィキペディ", "ウィキペディア")).toBe(true);
  });

  it("accepts identical strings (0 edits is within the <= 1 budget)", () => {
    expect(isOneEditAway("same", "same")).toBe(true);
  });

  it("rejects two or more edits", () => {
    expect(isOneEditAway("wikipedia", "wikipedxy")).toBe(false);
  });

  it("rejects lengths more than one apart", () => {
    expect(isOneEditAway("a", "abc")).toBe(false);
  });
});
