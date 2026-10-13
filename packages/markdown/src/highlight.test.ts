import { parser, Strikethrough } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { Frontmatter } from "./frontmatter";
import { Highlight, highlightNodes } from "./highlight";
import { extractTags, Tag, tagNodes } from "./tag";
import { extractWikiLinks, WikiLink, wikiLinkNodes } from "./wikilink";

// Editor の parser と同じく、WikiLink・Tag・GFM の Strikethrough と一緒に載せる
const highlightParser = parser.configure([Frontmatter, WikiLink, Tag, Strikethrough, Highlight]);

/** ハイライトされる範囲の中身（`==` を除いたテキスト）を出現順に返す */
function highlighted(text: string): string[] {
  const found: string[] = [];
  highlightParser.parse(text).iterate({
    enter(node) {
      if (node.name !== highlightNodes.highlight) return true;
      found.push(text.slice(node.from + 2, node.to - 2));
      return true;
    },
  });
  return found;
}

/** `name` の node が `==...==` の中にあるか */
function nestedIn(text: string, name: string): boolean {
  let nested = false;
  highlightParser.parse(text).iterate({
    enter(node) {
      if (node.name !== name) return true;
      for (let p = node.node.parent; p; p = p.parent) {
        if (p.name === highlightNodes.highlight) nested = true;
      }
      return false;
    },
  });
  return nested;
}

describe("Highlight", () => {
  it("parses ==text==", () => {
    expect(highlighted("前 ==ハイライト== 後")).toEqual(["ハイライト"]);
  });

  it("parses a highlight at the start of a line", () => {
    expect(highlighted("==先頭== 後")).toEqual(["先頭"]);
  });

  it("parses a highlight in the middle of a word", () => {
    expect(highlighted("a==b==c")).toEqual(["b"]);
  });

  it("parses a highlight across a soft line break in the same paragraph", () => {
    expect(highlighted("==a\nb==")).toEqual(["a\nb"]);
  });

  it("does not parse across paragraphs", () => {
    expect(highlighted("==a\n\nb==")).toEqual([]);
  });

  it("does not parse an unclosed ==", () => {
    expect(highlighted("==閉じない")).toEqual([]);
    expect(highlighted("a == b")).toEqual([]);
  });

  it("does not open or close next to whitespace inside the delimiters", () => {
    expect(highlighted("== text ==")).toEqual([]);
    expect(highlighted("== text==")).toEqual([]);
    expect(highlighted("==text ==")).toEqual([]);
  });

  // 既知の差。開きの `==` の前が文字で後ろが句読点、閉じの `==` の前が句読点で
  // 後ろが文字だと、どちらも flanking にならない。Obsidian と一致するかは確かめていない。
  it("does not parse between letters when the content starts and ends with punctuation", () => {
    expect(highlighted("文==「強調」==文")).toEqual([]);
    expect(highlighted("文 ==「強調」== 文")).toEqual(["「強調」"]);
    expect(highlightParser.parse("文 ~~「取消」~~ 文").toString()).toContain("Strikethrough");
    expect(highlightParser.parse("文~~「取消」~~文").toString()).not.toContain("Strikethrough");
  });

  it("leaves runs of three or more = as written", () => {
    expect(highlighted("===text===")).toEqual([]);
    expect(highlighted("==text===")).toEqual([]);
    expect(highlighted("===text==")).toEqual([]);
    expect(highlighted("a === b === c")).toEqual([]);
    expect(highlighted("x !== y と ==z== ")).toEqual(["z"]);
  });

  it("does not parse an escaped =", () => {
    expect(highlighted("\\==text==")).toEqual([]);
    expect(highlighted("\\=\\=text\\=\\=")).toEqual([]);
  });

  it("does not parse inside a code span or a fenced code block", () => {
    expect(highlighted("`==x==`")).toEqual([]);
    expect(highlighted("```\n==x==\n```")).toEqual([]);
  });

  it("treats a line of = under a paragraph as a setext heading underline", () => {
    const tree = highlightParser.parse("見出し\n==");
    expect(tree.topNode.firstChild?.name).toBe("SetextHeading1");
    expect(highlighted("見出し\n==")).toEqual([]);
  });

  it("nests with emphasis, strikethrough, and links in both directions", () => {
    expect(highlighted("**==x==**")).toEqual(["x"]);
    expect(highlighted("==**x**==")).toEqual(["**x**"]);
    expect(highlighted("==~~x~~==")).toEqual(["~~x~~"]);
    expect(highlighted("[==x==](https://example.com)")).toEqual(["x"]);
  });

  it("keeps a WikiLink and a tag inside a highlight as their own nodes", () => {
    expect(highlighted("==[[Title|Label]]==")).toEqual(["[[Title|Label]]"]);
    expect(nestedIn("==[[Title|Label]]==", wikiLinkNodes.link)).toBe(true);
    expect(highlighted("==#tag==")).toEqual(["#tag"]);
    expect(nestedIn("==#tag==", tagNodes.tag)).toBe(true);
  });
});

/**
 * links/tags の抽出（`extractDerived`）は Highlight を載せない parser を使う。
 * Obsidian はハイライトの中のリンクとタグもリンク一覧・タグ一覧に数えるので、
 * Highlight の有無で抽出結果が変わらないことを、Highlight を載せた parser との比較で固定する。
 */
describe("extraction is unaffected by highlights", () => {
  const docs = [
    "==[[Title]]== と ==[[Other|Label]]==",
    "==#tag== と ==前 #日本語 後==",
    "a==[[Title]]==b ==#x==",
    "== [[Spaced]] == と ===[[Run]]===",
    "==[[Heading#Section]]== ==![[Embed]]==",
  ];

  it("extracts WikiLinks and tags inside highlights", () => {
    expect(extractWikiLinks(docs[0] ?? "").map((ref) => ref.target)).toEqual(["Title", "Other"]);
    expect(extractTags(docs[1] ?? "")).toEqual(["tag", "日本語"]);
  });

  for (const doc of docs) {
    it(`finds the same links and tags with or without Highlight: ${JSON.stringify(doc)}`, () => {
      const links: [number, number][] = [];
      const tagNames: string[] = [];
      highlightParser.parse(doc).iterate({
        enter(node) {
          if (node.name === wikiLinkNodes.link) links.push([node.from, node.to]);
          if (node.name === tagNodes.name) tagNames.push(doc.slice(node.from, node.to));
          return true;
        },
      });
      expect(extractWikiLinks(doc).map((ref) => [ref.from, ref.to])).toEqual(links);
      expect(extractTags(doc)).toEqual(tagNames);
    });
  }
});
