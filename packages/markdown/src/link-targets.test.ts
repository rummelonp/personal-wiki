import { describe, expect, it } from "vitest";
import { extractLinkTargets } from "./link-targets";

describe("extractLinkTargets", () => {
  it("returns the headings and the block ids with a line of each block", () => {
    const text = "# 見出し\n\n段落 ^p1\n\n- 項目 ^li";
    expect(extractLinkTargets(text)).toEqual({
      headings: ["見出し"],
      blocks: [
        { id: "p1", preview: "段落" },
        { id: "li", preview: "- 項目" },
      ],
    });
  });

  it("uses the line of the block above for an id on its own line", () => {
    const text = "> 引用\n> 二行目\n\n^quote\n\n後の段落";
    expect(extractLinkTargets(text).blocks).toEqual([{ id: "quote", preview: "> 二行目" }]);
  });

  it("uses the last line of a multi-line paragraph", () => {
    expect(extractLinkTargets("一行目\n二行目 ^multi").blocks).toEqual([
      { id: "multi", preview: "二行目" },
    ]);
  });

  it("keeps only the first of a repeated id", () => {
    expect(extractLinkTargets("先 ^dup\n\n後 ^dup").blocks).toEqual([{ id: "dup", preview: "先" }]);
  });

  it("returns nothing for text without headings or blocks", () => {
    expect(extractLinkTargets("本文だけ")).toEqual({ headings: [], blocks: [] });
    expect(extractLinkTargets("")).toEqual({ headings: [], blocks: [] });
  });

  it("does not take a ^ in the middle of a line as a block id", () => {
    expect(extractLinkTargets("x^2 を使う").blocks).toEqual([]);
  });
});
