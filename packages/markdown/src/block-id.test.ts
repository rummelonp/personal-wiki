import { describe, expect, it } from "vitest";
import { extractBlockIds } from "./block-id";

describe("extractBlockIds", () => {
  it("parses a block id at the end of a paragraph", () => {
    const text = "これは段落です。 ^abc123";
    const from = text.indexOf("^");
    expect(extractBlockIds(text)).toEqual([{ id: "abc123", from, to: text.length }]);
  });

  it("parses multiple block ids across paragraphs", () => {
    const text = "最初の段落。 ^first\n\n二番目の段落。 ^second";
    expect(extractBlockIds(text).map((ref) => ref.id)).toEqual(["first", "second"]);
  });

  it("returns refs in document order", () => {
    const text = "a ^one\n\nb ^two\n\nc ^three";
    expect(extractBlockIds(text).map((ref) => ref.id)).toEqual(["one", "two", "three"]);
  });

  it("ignores a caret that is not at the end of the paragraph", () => {
    expect(extractBlockIds("2^10 はべき乗であって block id ではない")).toEqual([]);
  });

  it("ignores a bare caret with no id body", () => {
    expect(extractBlockIds("末尾の記号 ^")).toEqual([]);
  });

  it("does not treat the interior ^ of a [[Title^blockid]] reference as an assignment", () => {
    expect(extractBlockIds("[[Title^blockid]]")).toEqual([]);
  });

  it("still parses a standalone block id next to a WikiLink", () => {
    const text = "[[Title^blockid]] を参照する段落。 ^myblock";
    expect(extractBlockIds(text).map((ref) => ref.id)).toEqual(["myblock"]);
  });

  it("does not parse inside a code span", () => {
    expect(extractBlockIds("`^abc`")).toEqual([]);
  });

  // 抽出の parser は GFM Table を解析しない（block-id.ts の blockIdParser）。表は 1 つの段落として
  // 扱われ、`cx.end` は表の末尾になる。Editor の構文木（GFM 入り）とはここで解析単位が違う。
  describe("GFM table syntax", () => {
    const TABLE = "| a | b |\n| - | - |\n| c | d |";

    it("ignores an id at the end of a body cell", () => {
      expect(extractBlockIds("| a | b |\n| - | - |\n| c | d ^cellid |")).toEqual([]);
    });

    it("ignores an id at the end of a header cell", () => {
      expect(extractBlockIds("| a ^hid | b |\n| - | - |\n| c | d |")).toEqual([]);
    });

    it("parses an id written after the last pipe of the last row", () => {
      const text = `${TABLE} ^trail`;
      expect(extractBlockIds(text)).toEqual([
        { id: "trail", from: text.indexOf("^"), to: text.length },
      ]);
    });

    it("parses an id on the line right after the table", () => {
      expect(extractBlockIds(`${TABLE}\n^next`).map((ref) => ref.id)).toEqual(["next"]);
    });

    it("parses an id in its own paragraph after the table", () => {
      const text = `${TABLE}\n\n^tableid`;
      expect(extractBlockIds(text)).toEqual([
        { id: "tableid", from: text.indexOf("^"), to: text.length },
      ]);
    });

    it("parses an id at the end of a paragraph that contains pipes but no delimiter row", () => {
      expect(extractBlockIds("a | b\nc | d ^pipes").map((ref) => ref.id)).toEqual(["pipes"]);
    });

    it("parses an id after a pipe line followed by a setext underline", () => {
      expect(extractBlockIds("a | b\n--- ^setext").map((ref) => ref.id)).toEqual(["setext"]);
    });
  });
});
