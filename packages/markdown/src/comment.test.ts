import { parser } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { commentNodes, ObsidianComment } from "./comment";
import { Frontmatter } from "./frontmatter";
import { extractTags, Tag, tagNodes } from "./tag";
import { extractWikiLinks, WikiLink, wikiLinkNodes } from "./wikilink";

// Editor の parser と同じく WikiLink、Tag と一緒に載せる
const commentParser = parser.configure([Frontmatter, WikiLink, Tag, ObsidianComment]);

const { inline, block } = commentNodes;

/** コメントの node を出現順に `[node 名, source]` で返す */
function comments(text: string): [string, string][] {
  const found: [string, string][] = [];
  commentParser.parse(text).iterate({
    enter(node) {
      if (node.name !== inline && node.name !== block) return true;
      found.push([node.name, text.slice(node.from, node.to)]);
      return false;
    },
  });
  return found;
}

/** 文書の最上位の block の node 名 */
function topLevel(text: string): string[] {
  const names: string[] = [];
  for (let node = commentParser.parse(text).topNode.firstChild; node; node = node.nextSibling) {
    names.push(node.name);
  }
  return names;
}

function hasNode(text: string, name: string): boolean {
  let found = false;
  commentParser.parse(text).iterate({
    enter(node) {
      if (node.name === name) found = true;
      return !found;
    },
  });
  return found;
}

describe("inline comment", () => {
  it("parses %%text%% inside a paragraph", () => {
    expect(comments("前 %%メモ%% 後")).toEqual([[inline, "%%メモ%%"]]);
  });

  it("parses a comment between letters", () => {
    expect(comments("a%%b%%c")).toEqual([[inline, "%%b%%"]]);
  });

  it("parses a comment across a soft line break in the same paragraph", () => {
    expect(comments("前 %%a\nb%% 後")).toEqual([[inline, "%%a\nb%%"]]);
  });

  it("parses a comment that closes on the line where it opens as inline", () => {
    expect(comments("%%a%% 後")).toEqual([[inline, "%%a%%"]]);
    expect(topLevel("%%a%% 後")).toEqual(["Paragraph"]);
  });

  it("leaves an unclosed %% in the middle of a paragraph as written", () => {
    expect(comments("前 %%閉じない")).toEqual([]);
    expect(comments("前 %%a\n\nb%% 後")).toEqual([]);
    expect(comments("50% と 20%")).toEqual([]);
  });

  it("does not parse inside a code span, a fenced code block, or after an escape", () => {
    expect(comments("`%%x%%`")).toEqual([]);
    expect(comments("```\n%%\nx\n%%\n```")).toEqual([]);
    expect(comments("\\%%x%%")).toEqual([]);
  });

  it("parses a comment inside a blockquote or a list item", () => {
    expect(comments("> 前 %%a%% 後")).toEqual([[inline, "%%a%%"]]);
    expect(comments("- 前 %%a%% 後")).toEqual([[inline, "%%a%%"]]);
    // 引用の中の複数行は 1 つの段落として inline で読む
    expect(comments("> %%\n> a\n> %%")).toEqual([[inline, "%%\n> a\n> %%"]]);
  });

  it("does not collide with an HTML comment", () => {
    expect(comments("<!-- x -->")).toEqual([]);
    expect(hasNode("前 <!-- x --> 後", "Comment")).toBe(true);
  });
});

describe("block comment", () => {
  it("parses from a line that opens with %% to the line that closes it, across blank lines", () => {
    const doc = "前\n\n%%\nメモ\n\nまだメモ\n%%\n\n後";
    expect(comments(doc)).toEqual([[block, "%%\nメモ\n\nまだメモ\n%%"]]);
    expect(topLevel(doc)).toEqual(["Paragraph", block, "Paragraph"]);
  });

  it("keeps text on the opening and closing lines inside the comment", () => {
    expect(comments("%% メモ\n続き %%")).toEqual([[block, "%% メモ\n続き %%"]]);
  });

  it("opens right after a paragraph line", () => {
    const doc = "本文\n%%\nメモ\n%%";
    expect(topLevel(doc)).toEqual(["Paragraph", block]);
    expect(comments(doc)).toEqual([[block, "%%\nメモ\n%%"]]);
  });

  it("runs to the end of the document when it is not closed", () => {
    expect(comments("前\n\n%%\nメモ\n\n後")).toEqual([[block, "%%\nメモ\n\n後"]]);
  });

  it("ends at the closing %% and leaves the rest of that line out of the comment", () => {
    expect(comments("%%\nメモ\n%% 後ろ")).toEqual([[block, "%%\nメモ\n%%"]]);
  });

  it("reads a %% line as the close of a comment opened earlier in the paragraph", () => {
    const doc = "Some text %%\nmulti\n%%\n\n後";
    expect(comments(doc)).toEqual([[inline, "%%\nmulti\n%%"]]);
    expect(topLevel(doc)).toEqual(["Paragraph", "Paragraph"]);
  });

  it("does not flip later comments after a paragraph that closes a comment on a %% line", () => {
    const doc = "前 %%a\n%% 後\n\n本文1\n\n%%\nc\n%%\n\n本文2";
    expect(comments(doc)).toEqual([
      [inline, "%%a\n%%"],
      [block, "%%\nc\n%%"],
    ]);
    expect(topLevel(doc)).toEqual(["Paragraph", "Paragraph", block, "Paragraph"]);
  });

  // 既知の差：段落の中で開いた `%%` は空行を越えられないので、空行の後の閉じの
  // `%%` は block の開きとして読まれ、後ろが文書末までコメントになる。
  it("opens a block at a closing %% when the comment was opened across a blank line", () => {
    expect(comments("- item\n%%\na\n\nb\n%%\n後")).toEqual([[block, "%%\n後"]]);
    expect(comments("本文 %%\n\nb\n%%\n後")).toEqual([[block, "%%\n後"]]);
  });

  // 既知の差：block の中身は解析しないので、コードの中の `%%` でも閉じる。
  it("closes a block at a %% inside a code span or a fenced code block", () => {
    expect(comments("%%\n`%%` は区切り\n%%\n後")).toEqual([
      [block, "%%\n`%%"],
      [block, "%%\n後"],
    ]);
    const fenced = "%%\n```\n%%\n```\n後";
    expect(comments(fenced)).toEqual([[block, "%%\n```\n%%"]]);
    expect(topLevel(fenced)).toEqual([block, "FencedCode"]);
  });

  it("opens a block at a line of %%% that does not close", () => {
    expect(comments("%%%\nx\n\n本文")).toEqual([[block, "%%%\nx\n\n本文"]]);
  });

  it("is not recognized in indented code, a list item, or the frontmatter", () => {
    expect(comments("    %%\n    x")).toEqual([]);
    expect(comments("- %%\n  x")).toEqual([]);
    expect(comments("---\n%%\n---\n本文")).toEqual([]);
  });
});

describe("comment content", () => {
  it("does not parse WikiLinks, tags, or emphasis inside a comment", () => {
    for (const doc of ["%%[[Page]] #tag **b**%%", "%%\n[[Page]] #tag **b**\n%%"]) {
      expect(hasNode(doc, wikiLinkNodes.link)).toBe(false);
      expect(hasNode(doc, tagNodes.tag)).toBe(false);
      expect(hasNode(doc, "StrongEmphasis")).toBe(false);
    }
  });
});

/**
 * links/tags の抽出には ObsidianComment を載せない。Obsidian はコメントの中の
 * link も backlink や graph に数える。載せるとコメントの中の link と tag が
 * 抽出から消え、保存済みのページから派生データを作り直したときに backlink が黙って減る。
 */
describe("extraction keeps links and tags inside comments", () => {
  it("extracts WikiLinks inside inline and block comments", () => {
    expect(extractWikiLinks("前 %%[[Page]]%% 後").map((ref) => ref.target)).toEqual(["Page"]);
    expect(extractWikiLinks("%%\n[[Page]]\n\n[[Other]]\n%%").map((ref) => ref.target)).toEqual([
      "Page",
      "Other",
    ]);
  });

  it("extracts tags inside inline and block comments", () => {
    expect(extractTags("前 %%#tag%% 後")).toEqual(["tag"]);
    expect(extractTags("%%\n#tag\n%%")).toEqual(["tag"]);
  });
});
