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

  it("絞らない一覧は、更新日時の順だけを「最近の更新」と呼び、ほかの並びでは「すべてのページ」と呼ぶ", () => {
    expect(listHeading("", "", "", "updated")).toBe("最近の更新");
    expect(listHeading("", "", "", "created")).toBe("すべてのページ");
    expect(listHeading("", "", "", "title")).toBe("すべてのページ");
    expect(listHeading("", "設計", "", "title")).toBe("タグ「設計」");
    expect(listHeading("", "", "draft", "created")).toBe("下書き");
    expect(listHeading("メモ", "", "", "title")).toBe("「メモ」の検索結果");
  });
});
