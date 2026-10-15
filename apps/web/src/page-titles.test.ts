import { afterEach, describe, expect, it } from "vitest";
import { forgetTitles, recallTitle, recallTitleFor, rememberTitle } from "./page-titles";

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
});
