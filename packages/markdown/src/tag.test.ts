import { describe, expect, it } from "vitest";
import { extractTags, frontmatterTagName } from "./tag";

describe("extractTags", () => {
  it("parses a single #tag", () => {
    expect(extractTags("見出し #tag 本文")).toEqual(["tag"]);
  });

  it("parses multiple tags", () => {
    expect(extractTags("#one #two #three")).toEqual(["one", "two", "three"]);
  });

  it("parses a Japanese tag", () => {
    expect(extractTags("#タグ 本文")).toEqual(["タグ"]);
  });

  it("parses a nested tag with a slash", () => {
    expect(extractTags("#foo/bar")).toEqual(["foo/bar"]);
  });

  it("does not parse a bare #", () => {
    expect(extractTags("# ")).toEqual([]);
    expect(extractTags("#")).toEqual([]);
  });

  it("does not parse the # of an ATX heading", () => {
    expect(extractTags("# Heading\nbody #tag")).toEqual(["tag"]);
  });

  it("does not parse inside a code span", () => {
    expect(extractTags("`#tag`")).toEqual([]);
  });

  it("does not parse inside a fenced code block", () => {
    expect(extractTags("```\n#tag\n```")).toEqual([]);
  });

  it("does not double-count a #Heading inside a WikiLink", () => {
    expect(extractTags("[[Title#Heading]]")).toEqual([]);
  });

  it("still parses a standalone tag next to a WikiLink", () => {
    expect(extractTags("[[Title#Heading]] #tag")).toEqual(["tag"]);
  });

  it("parses tags inside GFM table cells", () => {
    expect(extractTags("| #head | c |\n| - | - |\n| x | #body |")).toEqual(["head", "body"]);
  });
});

describe("extractTags の境界", () => {
  it.each([
    ["https://example.com/page#section"],
    ["foo#bar"],
    ["[リンク](https://example.com/#top)"],
    ["<https://example.com/#top>"],
    ["https://example.com/?t=YWJjZA==#section"],
    ["==a==#b"],
    ["a==#b"],
    ["x===#a"],
    ["100%%#x"],
    ["[[a]]#tag"],
    ["<b>#t</b>"],
    ["a_#b"],
    ["**a**#b"],
    ["2*#x"],
  ])("# の直前が境界でなければ tag にしない: %s", (text) => {
    expect(extractTags(text)).toEqual([]);
  });

  it("tag の途中の `#` は区切りにしない", () => {
    expect(extractTags("#tag#other")).toEqual(["tag"]);
    expect(extractTags("a #ok と https://example.com/a#b")).toEqual(["ok"]);
  });

  it.each([
    ["**#tag**"],
    ["*#tag*"],
    ["__#tag**"],
    ["_#tag*"],
    ["~~#tag~~"],
    ["(#tag)"],
    ["[#tag](https://x)"],
    ["（#tag）"],
    ["「#tag」"],
    ["『#tag』"],
    ["前 %%#tag%% 後"],
    ["==#tag=="],
    ["x ***#tag***"],
    ["((#tag))"],
    ["**(#tag)**"],
    ["前\n**==#tag==**"],
  ])("開きの区切り記号の直後は tag にする: %s", (text) => {
    expect(extractTags(text)).toEqual(["tag"]);
  });

  it("`_` は tag の文字なので、閉じの `_` は tag に含まれる", () => {
    expect(extractTags("_#tag_ __#tag__")).toEqual(["tag_", "tag__"]);
  });

  it("開きの区切り記号の直前が語の途中なら tag にしない", () => {
    expect(extractTags("a(#t)")).toEqual([]);
    expect(extractTags("a**#t**")).toEqual([]);
    expect(extractTags("x **a**(#t)")).toEqual([]);
  });

  it("`Ⅻ` のような文字として書かれる数値は tag にする", () => {
    expect(extractTags("#Ⅻ")).toEqual(["Ⅻ"]);
  });

  it("行頭、空白、タブ、改行、全角空白の直後は tag にする", () => {
    expect(extractTags("#a")).toEqual(["a"]);
    expect(extractTags("x #b")).toEqual(["b"]);
    expect(extractTags("x\t#c")).toEqual(["c"]);
    expect(extractTags("x\n#d")).toEqual(["d"]);
    expect(extractTags("メモ\u3000#e")).toEqual(["e"]);
    expect(extractTags("- #f\n> #g")).toEqual(["f", "g"]);
  });

  it("記号だけの本体は tag にしない", () => {
    for (const text of ["#/", "#-", "#_", "#--", "#_-", "x #/ y"]) {
      expect(extractTags(text)).toEqual([]);
    }
  });

  it("記号を含んでも文字があれば tag にする", () => {
    expect(extractTags("#-a #_b")).toEqual(["-a", "_b"]);
  });

  it("数字だけの本体は tag にしない（issue 参照を拾わない）", () => {
    for (const text of ["#1984", "#123 を参照", "x #２０２６", "#2026/10", "#1-2", "#1_2"]) {
      expect(extractTags(text)).toEqual([]);
    }
    expect(extractTags("#y1984 #2026/q4")).toEqual(["y1984", "2026/q4"]);
  });

  it("`/` が先頭、末尾、連続にある形は tag にしない", () => {
    expect(extractTags("#/a")).toEqual([]);
    expect(extractTags("#tag/")).toEqual([]);
    expect(extractTags("#a/b/")).toEqual([]);
    expect(extractTags("#a//b")).toEqual([]);
    expect(extractTags("#a/b/c")).toEqual(["a/b/c"]);
  });

  it("ハイライトとコメントの開きの直後は tag にする", () => {
    expect(extractTags("==#a== %%#b%%")).toEqual(["a", "b"]);
    expect(extractTags("a=#b")).toEqual([]);
  });
});

describe("frontmatterTagName", () => {
  it.each(["仕事", "foo/bar", "a-b_c", "y1984", "2026/q4"])(
    "tag として読める値を返す: %s",
    (value) => {
      expect(frontmatterTagName(value)).toBe(value);
      // 本文に `#値` と書いたときと同じ tag になる、が判定の規約
      expect(extractTags(`#${value}`)).toEqual([value]);
    },
  );

  it("前後の空白と、先頭の `#` を 1 つだけ落とす", () => {
    expect(frontmatterTagName("  仕事  ")).toBe("仕事");
    expect(frontmatterTagName("#仕事")).toBe("仕事");
    expect(frontmatterTagName("##仕事")).toBe(null);
  });

  it.each([
    "",
    "~",
    "a, b",
    "a b",
    "#",
    "a#b",
    "[[a]]",
    "-",
    "_",
    "/",
    "a/",
    "/a",
    "1984",
    "２０２６",
    "2026/10",
    "1-2",
  ])("tag として読めない値は null: %s", (value) => {
    expect(frontmatterTagName(value)).toBe(null);
  });
});
