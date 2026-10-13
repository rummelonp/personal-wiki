import { describe, expect, it } from "vitest";
import { fragmentTextOf, hashOfLink, parseFragment } from "./page-fragment";

const link = (heading: string | null, blockId: string | null = null) => ({ heading, blockId });

describe("fragmentTextOf", () => {
  it("見出しはそのまま、block は ^ を付けた形にする", () => {
    expect(fragmentTextOf(link("見出し"))).toBe("見出し");
    expect(fragmentTextOf(link("^abc"))).toBe("^abc");
    expect(fragmentTextOf(link(null, "abc"))).toBe("^abc");
  });

  it("見出しを重ねた block 参照は block だけを指す", () => {
    expect(fragmentTextOf(link("A#^abc"))).toBe("^abc");
    expect(fragmentTextOf(link("A#B"))).toBe("A#B");
  });

  it("場所を指さない link は null", () => {
    expect(fragmentTextOf(link(null))).toBeNull();
  });
});

describe("hashOfLink と parseFragment", () => {
  it("title の URL と同じ encodeURIComponent で符号化する", () => {
    expect(hashOfLink(link("見出し A/B"))).toBe(`#${encodeURIComponent("見出し A/B")}`);
    expect(hashOfLink(link("A#B"))).toBe("#A%23B");
    expect(hashOfLink(link(null, "abc"))).toBe("#%5Eabc");
    expect(hashOfLink(link(null))).toBe("");
  });

  it("符号化した hash を元の場所に戻す", () => {
    for (const heading of ["見出し A/B", "A#B", "100% 100%25", "a b"]) {
      expect(parseFragment(hashOfLink(link(heading)))).toEqual({ kind: "heading", heading });
    }
    expect(parseFragment(hashOfLink(link(null, "abc-1")))).toEqual({ kind: "block", id: "abc-1" });
  });

  it("符号化されていない ^ と前後の空白も読む", () => {
    expect(parseFragment("#^abc")).toEqual({ kind: "block", id: "abc" });
    expect(parseFragment("#%20見出し%20")).toEqual({ kind: "heading", heading: "見出し" });
  });

  it("場所を指さない hash と壊れた hash は null", () => {
    for (const hash of ["", "#", "#%20", "#^", "#%5E", "#%E0%A4%A", "見出し"]) {
      expect(parseFragment(hash)).toBeNull();
    }
  });
});
