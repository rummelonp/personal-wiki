import type { SyntaxNode } from "@lezer/common";
import { GFM, parser } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { markdownLink } from "./markdown-link";

const gfmParser = parser.configure(GFM);

// リンクの文字列の中に現れると、外側のリンクが文字列として崩れたか、別の構文に化けたことを表す node。
// Entity は文字参照で、表示では別の文字に化ける。
// GFM の拡張の autolink（`https://` で始まる裸の URL）は lezer ではリンクの文字列の中にも URL の node を
// 作るが、外側のリンクは崩れないので含めない
const FOREIGN_NODES = new Set([
  "Link",
  "Image",
  "Autolink",
  "InlineCode",
  "HTMLTag",
  "Comment",
  "Entity",
]);

/**
 * 箇条書きの 1 行として解析し、リンクが 1 つだけ行の残り全体を占めることを確かめて、escape を解いた
 * 文字列と宛先を返す。
 */
function parseListItemLink(markdown: string) {
  const line = `- ${markdown}`;
  const tree = gfmParser.parse(line);
  const links: SyntaxNode[] = [];
  tree.iterate({
    enter(node) {
      if (node.name === "Link") links.push(node.node);
    },
  });
  expect(links, line).toHaveLength(1);
  const link = links[0] as SyntaxNode;
  expect([link.from, link.to], line).toEqual([2, line.length]);

  const marks = link.getChildren("LinkMark");
  const labelFrom = marks[0]?.to ?? -1;
  const labelTo = marks[1]?.from ?? -1;
  let text = "";
  let pos = labelFrom;
  for (let child = link.firstChild; child !== null; child = child.nextSibling) {
    if (child.from < labelFrom || child.to > labelTo) continue;
    expect(FOREIGN_NODES.has(child.name), `${line}: ${child.name}`).toBe(false);
    if (child.name === "Escape") {
      text += line.slice(pos, child.from) + line.slice(child.from + 1, child.to);
      pos = child.to;
    }
  }
  text += line.slice(pos, labelTo);
  const url = link.getChildren("URL").find((node) => node.from >= labelTo);
  return { text, url: url === undefined ? null : line.slice(url.from, url.to) };
}

describe("markdownLink", () => {
  it("リンクの文字列の Markdown の記号で、リンクが崩れたり入れ子になったりしない", () => {
    const texts = [
      "plain",
      "a]b",
      "[a",
      "[[x]]",
      "a [b](c) d",
      "![x](y)",
      "a\\",
      "a\\]",
      "\\`",
      "`a`",
      "`](x)`",
      "a ` b",
      "<https://example.com>",
      "<b>x</b>",
      "a <!-- c -->",
      "https://example.com",
      "*a*",
      "a_b_",
      "~~a~~",
      "&amp;",
      "&#38; &#x26; &copy;",
      "a & b;",
      "a (b) c",
      "日本語のタイトル",
    ];
    for (const text of texts) {
      const url = `https://wiki.example/${encodeURIComponent(text)}`;
      const parsed = parseListItemLink(markdownLink(text, url));
      expect(parsed.text, text).toBe(text);
      expect(decodeURIComponent(parsed.url ?? ""), text).toBe(decodeURIComponent(url));
    }
  });

  it("宛先の ( と ) を percent-encoding にし、対にならない括弧でも宛先が途中で切れない", () => {
    for (const text of ["a)", "(a", "a (b)", ")("]) {
      const url = `https://wiki.example/${encodeURIComponent(text)}`;
      const link = markdownLink(text, url);
      expect(link.slice(link.indexOf("](") + 2, -1)).not.toMatch(/[()]/);
      expect(decodeURIComponent(parseListItemLink(link).url ?? "")).toBe(
        `https://wiki.example/${text}`,
      );
    }
  });

  it("要らない記号は escape しない", () => {
    expect(markdownLink("C++ *x* _y_ & (z)", "https://wiki.example/x")).toBe(
      "[C++ *x* _y_ & (z)](https://wiki.example/x)",
    );
  });
});
