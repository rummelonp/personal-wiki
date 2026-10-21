import { ANONYMOUS_SEARCH_MIN_CHARS } from "@personal-wiki/domain/search";
import { describe, expect, it } from "vitest";
import { type BuildRowsInput, buildRows, type Row, rowKey } from "./switcher-rows";

const memo = { id: "p-memo", title: "メモ" };
const memoApp = { id: "p-memo-app", title: "メモアプリ" };
const anonymousShort = "a".repeat(ANONYMOUS_SEARCH_MIN_CHARS - 1);
const anonymousEnough = "a".repeat(ANONYMOUS_SEARCH_MIN_CHARS);

function build(input: Partial<BuildRowsInput> = {}) {
  return buildRows({
    trimmed: "",
    owner: true,
    initialQuery: "",
    candidates: [],
    settled: true,
    failed: false,
    ...input,
  });
}

function kinds(rows: readonly Row[]): string[] {
  return rows.map(rowKey);
}

describe("buildRows", () => {
  it("語が空のときは候補だけを並べる", () => {
    const built = build({ candidates: [memo, memoApp] });
    expect(kinds(built.rows)).toEqual(["page-p-memo", "page-p-memo-app"]);
    expect(built.hasClearRow).toBe(false);
    expect(built.noMatch).toBe(false);
  });

  it("title が完全に一致するときは、候補、本文検索の順で、作成を出さない", () => {
    const built = build({ trimmed: "メモ", candidates: [memo, memoApp] });
    expect(kinds(built.rows)).toEqual(["page-p-memo", "page-p-memo-app", "content-search"]);
  });

  it("完全一致の比較は title の畳み込みで行う", () => {
    const built = build({
      trimmed: "ＡＢＣ",
      candidates: [{ id: "p-abc", title: "abc" }],
    });
    expect(kinds(built.rows)).toEqual(["page-p-abc", "content-search"]);
  });

  it("完全一致が無いときは、本文検索、候補、作成の順にする", () => {
    const built = build({ trimmed: "メ", candidates: [memo, memoApp] });
    expect(kinds(built.rows)).toEqual([
      "content-search",
      "page-p-memo",
      "page-p-memo-app",
      "create",
    ]);
  });

  it("候補が無くても、語があれば本文検索と作成を出す", () => {
    const built = build({ trimmed: "新しい語" });
    expect(kinds(built.rows)).toEqual(["content-search", "create"]);
    expect(built.noMatch).toBe(false);
  });

  it("匿名には、本文検索を出せる長さの語でも作成を出さない", () => {
    const built = build({
      trimmed: anonymousEnough,
      owner: false,
      candidates: [{ id: "p-a", title: `${anonymousEnough}b` }],
    });
    expect(kinds(built.rows)).toEqual(["content-search", "page-p-a"]);
  });

  it("匿名の語が本文検索の最小の長さに満たないときは、本文検索を出さず案内に回す", () => {
    const built = build({
      trimmed: anonymousShort,
      owner: false,
      candidates: [{ id: "p-a", title: `${anonymousShort}b` }],
    });
    expect(built.contentSearchTooShort).toBe(true);
    expect(kinds(built.rows)).toEqual(["page-p-a"]);
  });

  it("匿名の語が最小の長さに届けば本文検索を出す", () => {
    const built = build({ trimmed: anonymousEnough, owner: false });
    expect(built.contentSearchTooShort).toBe(false);
    expect(kinds(built.rows)).toEqual(["content-search"]);
  });

  it("owner には本文検索の長さの制限をかけない", () => {
    const built = build({ trimmed: "a", owner: true });
    expect(built.contentSearchTooShort).toBe(false);
    expect(kinds(built.rows)).toEqual(["content-search", "create"]);
  });

  it("匿名の短い語で候補も無いときだけ、行が無く noMatch になる", () => {
    const built = build({ trimmed: anonymousShort, owner: false });
    expect(built.rows).toEqual([]);
    expect(built.noMatch).toBe(true);
    expect(built.contentSearchTooShort).toBe(true);
  });

  it("1 回目の取得が済むまでは、作成を出さず noMatch にもしない", () => {
    const built = build({ trimmed: anonymousShort, owner: false, settled: false });
    expect(built.noMatch).toBe(false);
    expect(kinds(build({ trimmed: "新しい語", settled: false }).rows)).toEqual(["content-search"]);
  });

  it("取得に失敗したときは、作成を出さず noMatch にもしない", () => {
    expect(kinds(build({ trimmed: "新しい語", failed: true }).rows)).toEqual(["content-search"]);
    expect(build({ trimmed: anonymousShort, owner: false, failed: true }).noMatch).toBe(false);
  });

  it("検索結果の画面から開いて語を消したときは、先頭に検索の解除を置く", () => {
    const built = build({ initialQuery: "メモ", candidates: [memo] });
    expect(kinds(built.rows)).toEqual(["clear-search", "page-p-memo"]);
    expect(built.hasClearRow).toBe(true);
  });

  it("検索の解除は、語が空のときだけ出す", () => {
    const built = build({ trimmed: "メ", initialQuery: "メモ", candidates: [memo] });
    expect(built.hasClearRow).toBe(false);
    expect(kinds(built.rows)).not.toContain("clear-search");
  });

  it("開いたときの語が空白だけなら、検索の解除を出さない", () => {
    expect(build({ initialQuery: "  ", candidates: [memo] }).hasClearRow).toBe(false);
  });

  it("語が空で候補も無いときは、行が無くても noMatch にしない", () => {
    const built = build();
    expect(built.rows).toEqual([]);
    expect(built.noMatch).toBe(false);
  });
});

describe("rowKey", () => {
  it("候補は id、ほかは種類で識別する", () => {
    expect(rowKey({ kind: "page", candidate: memo })).toBe("page-p-memo");
    expect(rowKey({ kind: "create" })).toBe("create");
    expect(rowKey({ kind: "content-search" })).toBe("content-search");
    expect(rowKey({ kind: "clear-search" })).toBe("clear-search");
  });
});
