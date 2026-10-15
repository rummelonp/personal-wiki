import { afterEach, describe, expect, it } from "vitest";
import {
  forgetTitles,
  loadingTitleFor,
  recallTitle,
  recallTitleFor,
  rememberTitle,
} from "./page-titles";

afterEach(forgetTitles);

describe("page-titles", () => {
  it("URL の title からは、`_` と空白や大文字小文字の違いを超えて覚えた表記を返す", () => {
    rememberTitle("id-1", "My Note");
    rememberTitle("id-2", "snake_case");
    expect(recallTitleFor("My_Note")).toBe("My Note");
    expect(recallTitleFor("my note")).toBe("My Note");
    expect(recallTitleFor("snake_case")).toBe("snake_case");
    expect(recallTitleFor("Other")).toBeUndefined();
  });

  it("forgetTitles は id と title のどちらの引き方も忘れる", () => {
    rememberTitle("id-1", "My Note");
    forgetTitles();
    expect(recallTitle("id-1")).toBeUndefined();
    expect(recallTitleFor("My_Note")).toBeUndefined();
  });

  describe("loadingTitleFor", () => {
    it("覚えた表記があれば、それを出す", () => {
      rememberTitle("id-1", "snake_case");
      expect(loadingTitleFor("snake_case")).toBe("snake_case");
    });

    it("覚えていない `_` でつないだ URL は、空白の title として出す", () => {
      expect(loadingTitleFor("My_Note")).toBe("My Note");
      expect(loadingTitleFor("a_b_c")).toBe("a b c");
    });

    it("空白の並びだけでは作られない形は、URL の文字列のまま出す", () => {
      expect(loadingTitleFor("__init__")).toBe("__init__");
      expect(loadingTitleFor("a__b")).toBe("a__b");
      expect(loadingTitleFor("_a")).toBe("_a");
      expect(loadingTitleFor("a b_c")).toBe("a b_c");
      expect(loadingTitleFor("メモ")).toBe("メモ");
    });
  });
});
