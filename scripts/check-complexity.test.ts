import { describe, expect, it } from "vitest";
import { compare, readReport, toBaseline } from "./check-complexity.mjs";

type Fn = { name: string; line: number; cognitive: number; children?: Fn[] };

function report(files: Record<string, Fn[]>, parseErrors = 0) {
  return {
    files: Object.entries(files).map(([path, functions]) => ({ path, functions })),
    summary: { parse_error_count: parseErrors },
  };
}

const fn = (name: string, cognitive: number, children: Fn[] = [], line = 1): Fn => ({
  name,
  line,
  cognitive,
  children,
});

describe("readReport", () => {
  it("解析できなかったファイルがあれば失敗にする", () => {
    expect(() => readReport(JSON.stringify(report({}, 2)))).toThrow(
      "2 件のファイルを解析できなかった",
    );
  });

  it("解析の失敗がなければ出力をそのまま返す", () => {
    const r = report({ "a.ts": [fn("f", 1)] });
    expect(readReport(JSON.stringify(r))).toEqual(r);
  });
});

describe("toBaseline", () => {
  it("上限を超える関数だけを、入れ子の名前の並びを key にして載せる", () => {
    const r = report({
      "a.ts": [fn("outer", 20, [fn("<anonymous>", 16), fn("small", 3)]), fn("fine", 15)],
    });
    expect(toBaseline(r, "1.8.4", 15)).toEqual({
      cccc: "1.8.4",
      maxCognitive: 15,
      functions: { "a.ts:outer": [20], "a.ts:outer > <anonymous>": [16] },
    });
  });

  it("同じ key の関数は値の大きい順に並べる", () => {
    const r = report({ "a.ts": [fn("<anonymous>", 17), fn("<anonymous>", 30)] });
    expect(toBaseline(r, "1.8.4", 15).functions).toEqual({ "a.ts:<anonymous>": [30, 17] });
  });
});

describe("compare", () => {
  const baseline = (functions: Record<string, number[]>) => ({
    cccc: "1.8.4",
    maxCognitive: 15,
    functions,
  });

  it("baseline と同じなら違いはない", () => {
    const r = report({ "a.ts": [fn("big", 20), fn("small", 3)] });
    expect(compare(r, baseline({ "a.ts:big": [20] }))).toEqual({ worse: [], stale: [] });
  });

  it("新しく上限を超えた関数を拾う", () => {
    const r = report({ "a.ts": [fn("big", 16, [], 12)] });
    expect(compare(r, baseline({}))).toEqual({
      worse: ["a.ts:big (12 行): 16 で上限を超えた"],
      stale: [],
    });
  });

  it("baseline より上がった関数を拾う", () => {
    const r = report({ "a.ts": [fn("big", 25, [], 3)] });
    expect(compare(r, baseline({ "a.ts:big": [20] })).worse).toEqual([
      "a.ts:big (3 行): 20 から 25 に上がった",
    ]);
  });

  it("行番号が変わっても同じ関数として比べる", () => {
    const r = report({ "a.ts": [fn("big", 20, [], 300)] });
    expect(compare(r, baseline({ "a.ts:big": [20] }))).toEqual({ worse: [], stale: [] });
  });

  it("下がった関数と、上限以下になるか消えた関数を baseline の古い値として拾う", () => {
    const r = report({ "a.ts": [fn("lower", 18, [], 5), fn("fixed", 10)] });
    const result = compare(
      r,
      baseline({ "a.ts:lower": [20], "a.ts:fixed": [16], "b.ts:gone": [30] }),
    );
    expect(result.worse).toEqual([]);
    expect(result.stale).toEqual([
      "a.ts:fixed: 16 から上限以下になった",
      "a.ts:lower (5 行): 20 から 18 に下がった",
      "b.ts:gone: 30 から上限以下になった",
    ]);
  });

  it("同じ key の関数が増えたら、増えた分を上限を超えた関数として拾う", () => {
    const r = report({ "a.ts": [fn("<anonymous>", 20, [], 1), fn("<anonymous>", 17, [], 9)] });
    expect(compare(r, baseline({ "a.ts:<anonymous>": [20] }))).toEqual({
      worse: ["a.ts:<anonymous> (9 行): 17 で上限を超えた"],
      stale: [],
    });
  });

  it("同じ key の関数どうしは、並べ替えても値の組が同じなら違いはない", () => {
    const r = report({ "a.ts": [fn("<anonymous>", 17), fn("<anonymous>", 30)] });
    expect(compare(r, baseline({ "a.ts:<anonymous>": [30, 17] }))).toEqual({
      worse: [],
      stale: [],
    });
  });

  it("別の入れ子にある同じ名前の関数は別の key にする", () => {
    const r = report({ "a.ts": [fn("a", 0, [fn("enter", 20)]), fn("b", 0, [fn("enter", 20)])] });
    expect(compare(r, baseline({ "a.ts:a > enter": [20] })).worse).toEqual([
      "a.ts:b > enter (1 行): 20 で上限を超えた",
    ]);
  });
});
