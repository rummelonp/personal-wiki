import { describe, expect, it } from "vitest";
import { listHeading, listTitleClass } from "./list-heading";

describe("listTitleClass", () => {
  it("検索の見出しだけ、開き括弧の空きを詰める", () => {
    expect(listTitleClass(listHeading("メモ", ""))).toBe("list-title list-title-quoted");
    expect(listTitleClass(listHeading("", "設計"))).toBe("list-title");
    expect(listTitleClass(listHeading("", ""))).toBe("list-title");
  });
});
