import { describe, expect, it } from "vitest";
import { listHeading, listTitleClass } from "./list-heading";

describe("listTitleClass", () => {
  it("検索の見出しだけ、開き括弧の空きを詰める", () => {
    expect(listTitleClass(listHeading("メモ", ""))).toBe("list-title list-title-quoted");
    expect(listTitleClass(listHeading("", "設計"))).toBe("list-title");
    expect(listTitleClass(listHeading("", ""))).toBe("list-title");
  });
});

describe("listHeading", () => {
  it("公開範囲の絞り込みを見出しに入れ、tag と組み合わせる。検索中はどちらも使わない", () => {
    expect(listHeading("", "", "draft")).toBe("下書き");
    expect(listHeading("", "", "public")).toBe("公開ページ");
    expect(listHeading("", "設計", "draft")).toBe("タグ「設計」の下書き");
    expect(listHeading("", "設計", "public")).toBe("タグ「設計」の公開ページ");
    expect(listHeading("", "設計", "")).toBe("タグ「設計」");
    expect(listHeading("メモ", "設計", "draft")).toBe("「メモ」の検索結果");
  });
});
