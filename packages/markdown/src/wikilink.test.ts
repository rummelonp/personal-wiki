import { parser } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { extractWikiLinks, splitWikiLinkContent, WikiLink, wikiLinkNodes } from "./wikilink";

const refs = (text: string) =>
  extractWikiLinks(text).map((ref) => ({
    target: ref.target,
    label: ref.label,
    slice: text.slice(ref.from, ref.to),
  }));

describe("extractWikiLinks", () => {
  it("parses [[Title]]", () => {
    expect(refs("see [[Title]] here")).toEqual([
      { target: "Title", label: null, slice: "[[Title]]" },
    ]);
  });

  it("parses [[Title|Label]] and keeps both halves", () => {
    expect(refs("[[Amazon Web Services|AWS]]")).toEqual([
      { target: "Amazon Web Services", label: "AWS", slice: "[[Amazon Web Services|AWS]]" },
    ]);
  });

  it("parses a Japanese title", () => {
    expect(refs("本文の中の [[日本語のページ名]] を拾う")).toEqual([
      { target: "日本語のページ名", label: null, slice: "[[日本語のページ名]]" },
    ]);
  });

  it("parses a Japanese title with a label", () => {
    expect(refs("[[日本語のページ名|別名]]")).toEqual([
      { target: "日本語のページ名", label: "別名", slice: "[[日本語のページ名|別名]]" },
    ]);
  });

  it("finds every link on a line", () => {
    expect(refs("[[A]] and [[B|b]]").map((r) => r.target)).toEqual(["A", "B"]);
  });

  it("ignores an unclosed [[", () => {
    expect(refs("[[Title")).toEqual([]);
    expect(refs("[[Title]")).toEqual([]);
    expect(refs("[[")).toEqual([]);
  });

  it("ignores a line that is only [[ and still finds links on the following lines", () => {
    expect(refs("前の行\n[[\n[[次]]")).toEqual([{ target: "次", label: null, slice: "[[次]]" }]);
    expect(refs("[[\n\n[[次|つぎ]]")).toEqual([
      { target: "次", label: "つぎ", slice: "[[次|つぎ]]" },
    ]);
  });

  it("does not span a line break", () => {
    expect(refs("[[Title\nstill]]")).toEqual([]);
  });

  it("takes only the innermost link when brackets nest", () => {
    expect(refs("[[a[[b]]c]]")).toEqual([{ target: "b", label: null, slice: "[[b]]" }]);
  });

  it("does not parse an escaped bracket", () => {
    expect(refs("\\[[Title]]")).toEqual([]);
  });

  it("rejects an empty or whitespace-only target", () => {
    expect(refs("[[]]")).toEqual([]);
    expect(refs("[[   ]]")).toEqual([]);
    expect(refs("[[|Label]]")).toEqual([]);
  });

  it("parses a same-page heading and block reference as links with an empty target", () => {
    expect(refs("[[#見出し]] と [[#^abc]]")).toEqual([
      { target: "", label: null, slice: "[[#見出し]]" },
      { target: "", label: null, slice: "[[#^abc]]" },
    ]);
  });

  it("falls back to the target when the label is empty", () => {
    expect(refs("[[Title|]]")).toEqual([{ target: "Title", label: null, slice: "[[Title|]]" }]);
  });

  it("keeps a second pipe inside the label", () => {
    expect(refs("[[Title|a|b]]")).toEqual([
      { target: "Title", label: "a|b", slice: "[[Title|a|b]]" },
    ]);
  });

  it("trims surrounding spaces", () => {
    expect(refs("[[ Title | Label ]]")).toEqual([
      { target: "Title", label: "Label", slice: "[[ Title | Label ]]" },
    ]);
  });

  it("does not treat a single-bracket markdown link as a WikiLink", () => {
    expect(refs("[text](https://example.com)")).toEqual([]);
  });

  it("reports positions that slice back to the original text", () => {
    const text = "冒頭 [[ページ|表示]] 末尾";
    const [ref] = extractWikiLinks(text);
    expect(ref).toBeDefined();
    expect(text.slice(ref?.from ?? 0, ref?.to ?? 0)).toBe("[[ページ|表示]]");
  });

  it("does not parse inside inline code", () => {
    expect(refs("`[[Title]]`")).toEqual([]);
  });

  it("parses [[Title#Heading]]", () => {
    const [ref] = extractWikiLinks("[[Title#Heading]]");
    expect(ref).toMatchObject({ target: "Title", heading: "Heading", blockId: null });
  });

  it("parses [[Title^blockid]]", () => {
    const [ref] = extractWikiLinks("[[Title^blockid]]");
    expect(ref).toMatchObject({ target: "Title", heading: null, blockId: "blockid" });
  });

  it("parses [[Title#Heading|Label]]", () => {
    const [ref] = extractWikiLinks("[[Title#Heading|Label]]");
    expect(ref).toMatchObject({ target: "Title", heading: "Heading", label: "Label" });
  });

  it("parses ![[Embed]] as an embed", () => {
    const [ref] = extractWikiLinks("![[Embed]]");
    expect(ref).toMatchObject({ target: "Embed", isEmbed: true });
  });

  it("marks a plain [[Link]] as not an embed", () => {
    const [ref] = extractWikiLinks("[[Link]]");
    expect(ref).toMatchObject({ isEmbed: false });
  });

  // 抽出の parser は GFM Table を解析しない（wikilink.ts の wikiLinkParser）。表の行の `|` で
  // link が分かれないことを、既存ページの links を変えない前提として固定する。
  it("extracts links inside GFM table rows, including an unescaped label pipe", () => {
    const text = "| h | x |\n| - | - |\n| [[C|D]] | [[E]] |";
    expect(extractWikiLinks(text)).toMatchObject([
      { target: "C", label: "D", from: text.indexOf("[[C") },
      { target: "E", label: null },
    ]);
  });

  describe("escaped label pipe (\\|)", () => {
    it("reads \\| as the label separator inside a table row", () => {
      const text = "| h | x |\n| - | - |\n| [[C\\|D]] | [[E]] |";
      expect(extractWikiLinks(text)).toMatchObject([
        { target: "C", label: "D", labelSeparator: "\\|", from: text.indexOf("[[C") },
        { target: "E", label: null, labelSeparator: null },
      ]);
    });

    it("reads \\| as the label separator outside a table too", () => {
      expect(refs("see [[C\\|D]] here")).toEqual([{ target: "C", label: "D", slice: "[[C\\|D]]" }]);
    });

    it("strips the backslash from a heading or block id before \\|", () => {
      expect(extractWikiLinks("[[T#H\\|L]]")).toMatchObject([
        { target: "T", heading: "H", label: "L" },
      ]);
      expect(extractWikiLinks("[[T^id\\|L]]")).toMatchObject([
        { target: "T", blockId: "id", label: "L" },
      ]);
    });

    it("reads the size of an image embed written with \\|", () => {
      expect(extractWikiLinks("![[a.png\\|300]]")).toMatchObject([
        { target: "a.png", label: "300", isEmbed: true },
      ]);
    });

    it("keeps later pipes in the label as written", () => {
      expect(refs("[[T\\|a\\|b]]")).toEqual([
        { target: "T", label: "a\\|b", slice: "[[T\\|a\\|b]]" },
      ]);
      expect(refs("[[T|a\\|b]]")).toEqual([{ target: "T", label: "a\\|b", slice: "[[T|a\\|b]]" }]);
    });

    it("keeps a backslash that is not right before the first pipe", () => {
      expect(refs("[[C\\]]")).toEqual([{ target: "C\\", label: null, slice: "[[C\\]]" }]);
      expect(refs("[[C\\D|E]]")).toEqual([{ target: "C\\D", label: "E", slice: "[[C\\D|E]]" }]);
    });

    it("treats an empty label or target the same as with |", () => {
      expect(refs("[[C\\|]]")).toEqual([{ target: "C", label: null, slice: "[[C\\|]]" }]);
      expect(refs("[[\\|L]]")).toEqual([]);
    });

    it("puts the backslash in the separator node, not the target node", () => {
      const text = "[[C\\|D]]";
      const nodes: Record<string, string> = {};
      parser
        .configure([WikiLink])
        .parse(text)
        .iterate({
          enter(node) {
            nodes[node.name] = text.slice(node.from, node.to);
          },
        });
      expect(nodes).toMatchObject({
        [wikiLinkNodes.target]: "C",
        [wikiLinkNodes.separator]: "\\|",
        [wikiLinkNodes.label]: "D",
      });
    });
  });
});

describe("splitWikiLinkContent", () => {
  it("returns null for content that cannot form a link", () => {
    expect(splitWikiLinkContent("")).toBeNull();
    expect(splitWikiLinkContent("a[b")).toBeNull();
    expect(splitWikiLinkContent("a\nb")).toBeNull();
  });

  it("allows an empty target only for a heading or a block reference of the same page", () => {
    expect(splitWikiLinkContent("#見出し")).toMatchObject({
      target: "",
      heading: "見出し",
      blockId: null,
    });
    expect(splitWikiLinkContent("#^abc|ラベル")).toMatchObject({
      target: "",
      heading: "^abc",
      label: "ラベル",
    });
    expect(splitWikiLinkContent("#")).toBeNull();
    expect(splitWikiLinkContent("^abc")).toBeNull();
    expect(splitWikiLinkContent("#|ラベル")).toBeNull();
    expect(splitWikiLinkContent("#^")).toBeNull();
    expect(splitWikiLinkContent("# ^ |ラベル")).toBeNull();
  });

  it("splits on the first pipe only", () => {
    expect(splitWikiLinkContent("T|a|b")).toEqual({
      target: "T",
      label: "a|b",
      labelSeparator: "|",
      heading: null,
      blockId: null,
    });
  });

  it("splits on \\| and reports how the separator was written", () => {
    expect(splitWikiLinkContent("T\\|a")).toEqual({
      target: "T",
      label: "a",
      labelSeparator: "\\|",
      heading: null,
      blockId: null,
    });
  });
});
