import { describe, expect, it } from "vitest";
import {
  createHeadingSectionExtractor,
  extractHeadingSection,
  extractLinkableHeadings,
  isBlockReferenceHeading,
} from "./heading-section";

describe("extractHeadingSection", () => {
  it("takes the heading line up to the next heading of the same level", () => {
    const text = "前文\n\n## A\n\nA の本文\n\n### A-1\n\n子の本文\n\n## B\n\nB の本文";
    expect(extractHeadingSection(text, "A")).toBe("## A\n\nA の本文\n\n### A-1\n\n子の本文");
  });

  it("stops at a heading of a higher level", () => {
    const text = "## A\n\n本文\n\n# Top\n\n後";
    expect(extractHeadingSection(text, "A")).toBe("## A\n\n本文");
  });

  it("runs to the end of the document when no later heading closes the section", () => {
    const text = "# Top\n\n## A\n\n本文\n\n### Sub\n\n末尾\n\n";
    expect(extractHeadingSection(text, "A")).toBe("## A\n\n本文\n\n### Sub\n\n末尾");
  });

  it("reads setext headings as level 1 and 2", () => {
    const text = "A\n===\n\n本文\n\nB\n---\n\nB の本文\n\nC\n===\n\n後";
    expect(extractHeadingSection(text, "A")).toBe("A\n===\n\n本文\n\nB\n---\n\nB の本文");
    expect(extractHeadingSection(text, "B")).toBe("B\n---\n\nB の本文");
  });

  it("matches a multi-line setext heading by its lines joined with a space", () => {
    expect(extractHeadingSection("長い\n見出し\n---\n\n本文", "長い 見出し")).toBe(
      "長い\n見出し\n---\n\n本文",
    );
  });

  it("ignores the closing hashes of an ATX heading", () => {
    expect(extractHeadingSection("## A ##\n\n本文", "A")).toBe("## A ##\n\n本文");
  });

  it("does not count # lines inside code, comments, or frontmatter as headings", () => {
    const text = [
      "---",
      "# not heading",
      "---",
      "## A",
      "",
      "```",
      "## B",
      "```",
      "",
      "%%",
      "## B",
      "%%",
      "",
      "A の続き",
      "",
      "## B",
      "",
      "本当の B",
    ].join("\n");
    expect(extractHeadingSection(text, "not heading")).toBeNull();
    expect(extractHeadingSection(text, "B")).toBe("## B\n\n本当の B");
    expect(extractHeadingSection(text, "A")).toBe(
      ["## A", "", "```", "## B", "```", "", "%%", "## B", "%%", "", "A の続き"].join("\n"),
    );
  });

  it("does not split at headings nested in quotes or lists", () => {
    const text = "## A\n\n> ## quoted\n\n- ## listed\n\n## B";
    expect(extractHeadingSection(text, "A")).toBe("## A\n\n> ## quoted\n\n- ## listed");
    expect(extractHeadingSection(text, "quoted")).toBeNull();
  });

  it("follows a nested path within the enclosing section", () => {
    const text = "# X\n\n## Same\n\nX の中\n\n# Y\n\n## Same\n\nY の中";
    expect(extractHeadingSection(text, "Y#Same")).toBe("## Same\n\nY の中");
    expect(extractHeadingSection(text, " Y # Same ")).toBe("## Same\n\nY の中");
    expect(extractHeadingSection(text, "X#Missing")).toBeNull();
  });

  it("does not follow a nested path to a heading outside the enclosing section", () => {
    // 同じか上の level の見出しは親の範囲を閉じるので、親の中の見出しにならない
    expect(extractHeadingSection("## A\n\n本文\n\n## B\n\nB の本文", "A#B")).toBeNull();
    expect(extractHeadingSection("## A\n\n本文\n\n# B\n\nB の本文", "A#B")).toBeNull();
  });

  it("targets a heading with a caret in the middle", () => {
    expect(extractHeadingSection("## A^b\n\n本文", "A^b")).toBe("## A^b\n\n本文");
  });

  it("takes the first of duplicate headings", () => {
    expect(extractHeadingSection("## A\n\n1 つ目\n\n## A\n\n2 つ目", "A")).toBe("## A\n\n1 つ目");
  });

  it("compares the heading text exactly, without folding case", () => {
    expect(extractHeadingSection("## Heading\n\n本文", "heading")).toBeNull();
    expect(extractHeadingSection("## **強調** 見出し\n\n本文", "**強調** 見出し")).toBe(
      "## **強調** 見出し\n\n本文",
    );
  });

  it("returns null for a missing heading or an empty path", () => {
    expect(extractHeadingSection("## A\n\n本文", "B")).toBeNull();
    expect(extractHeadingSection("## A\n\n本文", "#")).toBeNull();
  });
});

describe("createHeadingSectionExtractor", () => {
  it("extracts several headings from the same text", () => {
    const extract = createHeadingSectionExtractor("## A\n\nA の本文\n\n## B\n\nB の本文");
    expect(extract("B")).toBe("## B\n\nB の本文");
    expect(extract("A")).toBe("## A\n\nA の本文");
    expect(extract("C")).toBeNull();
  });
});

describe("extractLinkableHeadings", () => {
  it("lists ATX and setext headings in document order", () => {
    const text = "# A\n\nB\n---\n\n長い\n見出し\n===\n\n### C ###";
    expect(extractLinkableHeadings(text)).toEqual(["A", "B", "長い 見出し", "C"]);
  });

  it("drops headings that a WikiLink cannot point at", () => {
    const text = "# 正常\n\n## a#b\n\n## a|b\n\n## [x]\n\n## ^id\n\n## 末尾";
    expect(extractLinkableHeadings(text)).toEqual(["正常", "末尾"]);
  });

  it("keeps a ^ that is not at the start", () => {
    expect(extractLinkableHeadings("# A^b")).toEqual(["A^b"]);
  });

  it("lists a repeated heading once", () => {
    expect(extractLinkableHeadings("# A\n\n## A\n\n# B")).toEqual(["A", "B"]);
  });

  it("skips headings in code, comments, frontmatter, and quotes", () => {
    const text = "---\ntitle: x\n---\n\n```\n# code\n```\n\n%% # hidden %%\n\n> # quoted\n\n# 実際";
    expect(extractLinkableHeadings(text)).toEqual(["実際"]);
  });

  it("returns only headings that extractHeadingSection resolves", () => {
    const text = "# A\n\nB\n---\n\n## a#b\n\n## C";
    for (const heading of extractLinkableHeadings(text)) {
      expect(extractHeadingSection(text, heading)).not.toBeNull();
    }
  });
});

describe("isBlockReferenceHeading", () => {
  it("detects a block reference written after a #", () => {
    expect(isBlockReferenceHeading("^abc")).toBe(true);
    expect(isBlockReferenceHeading("A#^abc")).toBe(true);
    expect(isBlockReferenceHeading("見出し")).toBe(false);
    expect(isBlockReferenceHeading("2^10")).toBe(false);
  });
});
