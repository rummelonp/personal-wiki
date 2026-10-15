import { describe, expect, it } from "vitest";
import { diffLines, diffWords, type LineDiff, type WordDiff } from "./diff";

/**
 * 両側の行番号が 1 から連番で、その番号の行の内容と一致すること（両側を復元できることを含む）と、
 * 変更箇所の中で delete が insert より先に並ぶことを確かめる。
 */
function expectConsistent(
  diff: readonly LineDiff[],
  beforeLines: readonly string[],
  afterLines: readonly string[],
): void {
  expect(
    diff.filter((line) => line.kind !== "insert").map((line) => [line.oldLine, line.text]),
  ).toEqual(beforeLines.map((text, index) => [index + 1, text]));
  expect(
    diff.filter((line) => line.kind !== "delete").map((line) => [line.newLine, line.text]),
  ).toEqual(afterLines.map((text, index) => [index + 1, text]));
  expect(diff.every((line) => line.kind !== "insert" || line.oldLine === null)).toBe(true);
  expect(diff.every((line) => line.kind !== "delete" || line.newLine === null)).toBe(true);
  expect(
    diff.some((line, index) => line.kind === "delete" && diff[index - 1]?.kind === "insert"),
  ).toBe(false);
}

function equalCount(diff: readonly LineDiff[]): number {
  return diff.filter((line) => line.kind === "equal").length;
}

function lcsLength(a: readonly string[], b: readonly string[]): number {
  let previous = new Array<number>(b.length + 1).fill(0);
  for (const lineA of a) {
    const current = [0];
    for (let j = 0; j < b.length; j++) {
      current.push(
        lineA === b[j] ? (previous[j] ?? 0) + 1 : Math.max(previous[j + 1] ?? 0, current[j] ?? 0),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

// テストの再現性のために seed 固定の擬似乱数を使う（mulberry32）。
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("diffLines", () => {
  it("変更が無ければすべて equal で、行番号は両側で一致する", () => {
    expect(diffLines("Title\n本文", "Title\n本文")).toEqual([
      { kind: "equal", text: "Title", oldLine: 1, newLine: 1 },
      { kind: "equal", text: "本文", oldLine: 2, newLine: 2 },
    ]);
  });

  it("行の追加を insert として、後続の equal の新しい行番号をずらして返す", () => {
    expect(diffLines("a\nc", "a\nb\nc")).toEqual([
      { kind: "equal", text: "a", oldLine: 1, newLine: 1 },
      { kind: "insert", text: "b", oldLine: null, newLine: 2 },
      { kind: "equal", text: "c", oldLine: 2, newLine: 3 },
    ]);
  });

  it("行の削除を delete として返す", () => {
    expect(diffLines("a\nb\nc", "a\nc")).toEqual([
      { kind: "equal", text: "a", oldLine: 1, newLine: 1 },
      { kind: "delete", text: "b", oldLine: 2, newLine: null },
      { kind: "equal", text: "c", oldLine: 3, newLine: 2 },
    ]);
  });

  it("書き換えた行は、削除した行を挿入した行より先に並べる", () => {
    expect(diffLines("a\nb\nc\nd", "a\nB\nC\nd")).toEqual([
      { kind: "equal", text: "a", oldLine: 1, newLine: 1 },
      { kind: "delete", text: "b", oldLine: 2, newLine: null },
      { kind: "delete", text: "c", oldLine: 3, newLine: null },
      { kind: "insert", text: "B", oldLine: null, newLine: 2 },
      { kind: "insert", text: "C", oldLine: null, newLine: 3 },
      { kind: "equal", text: "d", oldLine: 4, newLine: 4 },
    ]);
  });

  it("空文字列は空行 1 行として扱う（CodeMirror の行の数え方）", () => {
    expect(diffLines("", "")).toEqual([{ kind: "equal", text: "", oldLine: 1, newLine: 1 }]);
    expect(diffLines("", "a")).toEqual([
      { kind: "delete", text: "", oldLine: 1, newLine: null },
      { kind: "insert", text: "a", oldLine: null, newLine: 1 },
    ]);
  });

  it("末尾の改行の追加は空行 1 行の insert として見える", () => {
    expect(diffLines("a", "a\n")).toEqual([
      { kind: "equal", text: "a", oldLine: 1, newLine: 1 },
      { kind: "insert", text: "", oldLine: null, newLine: 2 },
    ]);
  });

  it("\\r は行の内容の一部として比べるので、改行コードだけの違いも差分になる", () => {
    expect(diffLines("a\r\nb", "a\nb")).toEqual([
      { kind: "delete", text: "a\r", oldLine: 1, newLine: null },
      { kind: "insert", text: "a", oldLine: null, newLine: 1 },
      { kind: "equal", text: "b", oldLine: 2, newLine: 2 },
    ]);
  });

  it("同じ内容の行が複数あっても、一致する行数が最大になる", () => {
    const diff = diffLines("x\na\nx\nb\nx", "a\nx\nb\nx\nc");
    expect(diff.filter((line) => line.kind === "equal").map((line) => line.text)).toEqual([
      "a",
      "x",
      "b",
      "x",
    ]);
  });

  it("行の比較は完全一致で、前後の空白や全角と半角を同一視しない", () => {
    const diff = diffLines("Ａ\n a", "A\na");
    expect(diff.map((line) => line.kind)).toEqual(["delete", "delete", "insert", "insert"]);
  });

  it("ランダムな入力で、行番号が両側の行と対応し、一致する行数が最長共通部分列と等しい", () => {
    const next = random(20260912);
    const alphabet = ["a", "b", "c", "d", "日本語", ""];
    let unique = 0;
    // 片側にしか無い行（探索から外す経路）と、両側に繰り返し出る行（探索する経路）を混ぜる。
    const randomLines = (maxLength: number) =>
      Array.from({ length: Math.floor(next() * maxLength) }, () =>
        next() < 0.2
          ? `unique ${unique++}`
          : (alphabet[Math.floor(next() * alphabet.length)] ?? ""),
      );
    const lengths = [
      [40, 40],
      [4, 40],
      [40, 4],
    ] as const;

    for (let i = 0; i < 1500; i++) {
      const [maxBefore, maxAfter] = lengths[i % lengths.length] ?? [40, 40];
      const beforeLines = randomLines(maxBefore);
      const afterLines = randomLines(maxAfter);
      const before = beforeLines.join("\n");
      const after = afterLines.join("\n");

      const diff = diffLines(before, after);

      expectConsistent(diff, before.split("\n"), after.split("\n"));
      expect(equalCount(diff)).toBe(lcsLength(before.split("\n"), after.split("\n")));
    }
  });

  // 全行を相手に O((N+M)·D) で探索すると、この規模では数十秒かかる。既定の testTimeout（5s）
  // は単体実行なら十分足りるが、並列実行時の CPU 競合下では超えることがある。
  it.each([
    { name: "全面的な書き換え", common: () => false },
    { name: "10 行ごとに空行を共通に残した書き換え", common: (i: number) => i % 10 === 0 },
  ])(
    "長いページの$nameでも差分を返す",
    ({ common }) => {
      const lines = (side: string) =>
        Array.from({ length: 50_000 }, (_, i) => (common(i) ? "" : `${side} ${i}`));
      const beforeLines = lines("old");
      const afterLines = lines("new");

      const diff = diffLines(beforeLines.join("\n"), afterLines.join("\n"));

      expectConsistent(diff, beforeLines, afterLines);
      expect(equalCount(diff)).toBe(beforeLines.filter((line) => line === "").length);
    },
    30_000,
  );
});

describe("diffWords", () => {
  function sides(diff: readonly WordDiff[]): [string, string] {
    return [
      diff
        .filter((part) => part.kind !== "insert")
        .map((part) => part.text)
        .join(""),
      diff
        .filter((part) => part.kind !== "delete")
        .map((part) => part.text)
        .join(""),
    ];
  }

  it("書き換えた語だけを削除と挿入にし、前後の語は equal に残す", () => {
    const diff = diffWords("the quick brown fox", "the slow brown fox");

    expect(diff).toEqual([
      { kind: "equal", text: "the " },
      { kind: "delete", text: "quick" },
      { kind: "insert", text: "slow" },
      { kind: "equal", text: " brown fox" },
    ]);
  });

  it("日本語の文も語の単位で比べ、変えていない語を equal に残す", () => {
    const before = "今日は雨が降っている。";
    const after = "今日は晴れが続いている。";

    const diff = diffWords(before, after);

    expect(sides(diff)).toEqual([before, after]);
    expect(diff[0]).toEqual({ kind: "equal", text: "今日は" });
    expect(diff.at(-1)).toEqual({ kind: "equal", text: "いる。" });
    expect(diff.some((part) => part.kind === "delete" && part.text.includes("雨"))).toBe(true);
    expect(diff.some((part) => part.kind === "insert" && part.text.includes("晴れ"))).toBe(true);
  });

  it("語を足しただけなら insert だけを返す", () => {
    expect(diffWords("a c", "a b c")).toEqual([
      { kind: "equal", text: "a " },
      { kind: "insert", text: "b " },
      { kind: "equal", text: "c" },
    ]);
  });

  it("同じ文なら equal 1 つ、片側が空なら削除か挿入 1 つにまとめる", () => {
    expect(diffWords("same text", "same text")).toEqual([{ kind: "equal", text: "same text" }]);
    expect(diffWords("", "new words")).toEqual([{ kind: "insert", text: "new words" }]);
    expect(diffWords("old words", "")).toEqual([{ kind: "delete", text: "old words" }]);
    expect(diffWords("", "")).toEqual([]);
  });

  it("続けて変えた語は 1 つの削除と 1 つの挿入にまとめ、削除を先に置く", () => {
    const diff = diffWords("keep one two keep", "keep three four keep");

    expect(diff).toEqual([
      { kind: "equal", text: "keep " },
      { kind: "delete", text: "one two" },
      { kind: "insert", text: "three four" },
      { kind: "equal", text: " keep" },
    ]);
  });

  it("末尾の空白は変えた語に含めず、変わらない区間として残す", () => {
    expect(diffWords("keep one ", "keep two ")).toEqual([
      { kind: "equal", text: "keep " },
      { kind: "delete", text: "one" },
      { kind: "insert", text: "two" },
      { kind: "equal", text: " " },
    ]);
    expect(diffWords("a b", "a b  ")).toEqual([
      { kind: "equal", text: "a b" },
      { kind: "insert", text: "  " },
    ]);
  });
});
