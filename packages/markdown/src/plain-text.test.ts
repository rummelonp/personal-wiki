import { describe, expect, it } from "vitest";
import { extractPlainText, extractPlainTextParts } from "./plain-text";

describe("extractPlainText", () => {
  it("drops heading markers and keeps tags as words", () => {
    expect(
      extractPlainText(
        "## 振り返り\n- 読書会の準備を進めた\n- [[読書メモの書き方]] を更新した #weekly",
      ),
    ).toBe("振り返り 読書会の準備を進めた 読書メモの書き方 を更新した #weekly");
  });

  it("drops closing hashes and setext underlines", () => {
    expect(extractPlainText("# 題 #\n\n小見出し\n---\n本文")).toBe("題 小見出し 本文");
  });

  it("drops list markers of bullet, ordered and nested lists", () => {
    expect(extractPlainText("1. 一\n   - 二\n   * 三\n2. 四")).toBe("一 二 三 四");
  });

  it("drops task markers regardless of status", () => {
    expect(extractPlainText("- [ ] 付箋\n- [x] ノート\n- [-] 栞")).toBe("付箋 ノート 栞");
  });

  it("drops blockquote markers", () => {
    expect(extractPlainText("> 引用\n>> 入れ子\n\n本文")).toBe("引用 入れ子 本文");
  });

  it("drops emphasis, strikethrough and highlight markers", () => {
    expect(extractPlainText("a **太字** と *斜体* と ~~消去~~ と ==強調== b")).toBe(
      "a 太字 と 斜体 と 消去 と 強調 b",
    );
  });

  it("joins words across markers inside a word", () => {
    expect(extractPlainText("ab**cd**ef")).toBe("abcdef");
  });

  it("keeps the content of inline code and drops the backticks", () => {
    expect(extractPlainText("`[[ページ名]]` でページ同士をつなぐ。")).toBe(
      "[[ページ名]] でページ同士をつなぐ。",
    );
  });

  it("drops the fence lines and the info string of a fenced code block but keeps its content", () => {
    expect(extractPlainText("前\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\n後")).toBe(
      "前 const a = 1; const b = 2; 後",
    );
  });

  it("keeps the content of an indented code block", () => {
    expect(extractPlainText("前\n\n    code\n\n後")).toBe("前 code 後");
  });

  it("drops horizontal rules", () => {
    expect(extractPlainText("上\n\n***\n\n下\n\n___\n\n端")).toBe("上 下 端");
  });

  it("keeps only the text of a link", () => {
    expect(extractPlainText('[リンク](https://example.com "title") の先')).toBe("リンク の先");
  });

  it("keeps the text of a reference link and drops its definition", () => {
    expect(extractPlainText("[参照][r] を読む\n\n[r]: https://example.com")).toBe("参照 を読む");
  });

  it("keeps formatted text inside a link", () => {
    expect(extractPlainText("[**太字**](https://example.com)")).toBe("太字");
  });

  it("keeps an autolink as written", () => {
    expect(extractPlainText("<https://example.com> を開く")).toBe("https://example.com を開く");
  });

  it("drops images entirely", () => {
    expect(extractPlainText("前 ![代替](a.png) 後")).toBe("前 後");
  });

  it("drops embeds entirely, including the bang", () => {
    expect(extractPlainText("前 ![[画像.png]] 中 ![[別ページ#見出し]] 後")).toBe("前 中 後");
  });

  it("drops Obsidian comments, inline and block", () => {
    expect(extractPlainText("前 %%メモ%% 後\n\n%%\n複数行\nのメモ\n%%\n\n末")).toBe("前 後 末");
  });

  it("drops HTML comments and tags but keeps the text between tags", () => {
    expect(extractPlainText("前<!-- メモ -->後 <b>太</b>字")).toBe("前 後 太字");
  });

  it("drops a trailing block id", () => {
    expect(extractPlainText("段落の本文 ^abc-1\n\n- 項目 ^item")).toBe("段落の本文 項目");
  });

  it("drops a frontmatter block", () => {
    expect(extractPlainText("---\ntitle: 題\ntags: [a, b]\n---\n本文")).toBe("本文");
  });

  it("removes the backslash of an escaped character", () => {
    expect(extractPlainText("\\*星\\* と \\#tag")).toBe("*星* と #tag");
  });

  it("turns a table into cells separated by spaces and drops the delimiter row", () => {
    expect(extractPlainText("| 名前 | 値 |\n|---|:-:|\n| a | [[B]] |")).toBe("名前 値 a B");
  });

  it("collapses newlines and runs of whitespace", () => {
    expect(extractPlainText("一行目\n\n\n二行目\t\t三\r\n四　五")).toBe("一行目 二行目 三 四 五");
  });

  it("returns an empty string for an empty or syntax-only body", () => {
    expect(extractPlainText("")).toBe("");
    expect(extractPlainText("\n\n  \n")).toBe("");
    expect(extractPlainText("---\ntitle: x\n---\n")).toBe("");
    expect(extractPlainText("***")).toBe("");
  });

  it("does not throw on unbalanced syntax", () => {
    expect(extractPlainText("**閉じない *強調 `コード [リンク](")).toBe(
      "**閉じない *強調 `コード リンク(",
    );
  });

  describe("WikiLink", () => {
    it("shows the target for [[target]]", () => {
      expect(extractPlainText("[[読書メモの書き方]]")).toBe("読書メモの書き方");
    });

    it("shows the label for [[target|label]]", () => {
      expect(extractPlainText("[[読書メモの書き方|メモ術]]")).toBe("メモ術");
    });

    it("shows the label for an escaped pipe inside a table", () => {
      expect(extractPlainText("| a |\n|---|\n| [[T\\|ラベル]] |")).toBe("a ラベル");
    });

    it("keeps the heading and block id of the target as written, like the Editor", () => {
      expect(extractPlainText("[[Note#見出し]] と [[Note#^abc]] と [[Note#A#B|別名]]")).toBe(
        "Note#見出し と Note#^abc と 別名",
      );
    });

    it("falls back to the target when the label is empty", () => {
      expect(extractPlainText("[[Target|]]")).toBe("Target");
    });

    it("does not read a nested opening as a link", () => {
      expect(extractPlainText("[[a[[b]] c")).toBe("[[ab c");
    });
  });

  describe("truncated", () => {
    it("drops a WikiLink cut off at the end", () => {
      expect(extractPlainText("本文 [[読書メ", { truncated: true })).toBe("本文");
      expect(extractPlainText("本文 [[読書メモ]", { truncated: true })).toBe("本文");
      expect(extractPlainText("本文 [[読書メモ|別", { truncated: true })).toBe("本文");
      expect(extractPlainText("本文 [[", { truncated: true })).toBe("本文");
    });

    it("drops an embed cut off at the end, including the bang", () => {
      expect(extractPlainText("本文 ![[画像", { truncated: true })).toBe("本文");
    });

    it("keeps a closed WikiLink at the end", () => {
      expect(extractPlainText("本文 [[読書メモ]]", { truncated: true })).toBe("本文 読書メモ");
    });

    it("does not drop a cut-off fragment of other syntax", () => {
      expect(extractPlainText("本文 [リンク](http", { truncated: true })).toBe("本文 リンク(http");
    });

    it("drops a frontmatter whose closing delimiter was cut off", () => {
      expect(extractPlainText("---\ntitle: 長い題\ntags: [a, b, c", { truncated: true })).toBe("");
    });

    it("drops a closed frontmatter and keeps the body after it", () => {
      expect(extractPlainText("---\ntitle: 題\n---\n本文 [[リン", { truncated: true })).toBe(
        "本文",
      );
    });

    it("keeps a leading rule when the body is not cut off", () => {
      expect(extractPlainText("---\n本文")).toBe("本文");
    });

    it("keeps an unclosed code fence's content", () => {
      expect(extractPlainText("```ts\nconst a", { truncated: true })).toBe("const a");
    });
  });

  describe("fragment", () => {
    it("does not read a leading --- pair as a frontmatter", () => {
      expect(extractPlainText("---\n中の語\n---\n後", { fragment: true })).toBe("中の語 後");
      expect(extractPlainText("---\n中の語\n---\n後")).toBe("後");
    });

    it("keeps the body when the cut-off fragment starts with ---", () => {
      expect(extractPlainText("---\n本文 [[リン", { fragment: true, truncated: true })).toBe(
        "本文",
      );
    });

    describe("a table cut in the middle", () => {
      it("drops the pipes of rows that lost their header and delimiter row", () => {
        expect(extractPlainText("| a | [[B]] |\n| c | d |\n\n後", { fragment: true })).toBe(
          "a B c d 後",
        );
      });

      it("drops a delimiter row at the start and the pipes of the rows after it", () => {
        expect(extractPlainText("|---|:-:|\n| a | b |", { fragment: true })).toBe("a b");
      });

      it("drops a delimiter row at the start that omits the outer pipes", () => {
        for (const delimiter of ["|---|---", "---|---|", "---|---", ":--|--:", "--- | ---"]) {
          expect(extractPlainText(`${delimiter}\n| c | d |\n| e | f |`, { fragment: true })).toBe(
            "c d e f",
          );
        }
        expect(extractPlainText("|---|---", { fragment: true })).toBe("");
      });

      it("does not read a leading thematic break as a delimiter row", () => {
        expect(extractPlainText("---\n| c | d |", { fragment: true })).toBe("| c | d |");
        expect(extractPlainText("- - -\n| c | d |", { fragment: true })).toBe("| c | d |");
        expect(extractPlainText("***\n| c | d |", { fragment: true })).toBe("| c | d |");
        expect(extractPlainText("---\n本文", { fragment: true })).toBe("本文");
      });

      it("reads rows with a leading indent", () => {
        expect(extractPlainText("  | a | b |\n| c | d |", { fragment: true })).toBe("a b c d");
      });

      it("shows an escaped pipe as a pipe", () => {
        expect(extractPlainText("| a \\| b | c |\n| d | e |", { fragment: true })).toBe(
          "a | b c d e",
        );
      });

      it("still reads a table whose header is in the fragment", () => {
        expect(extractPlainText("前\n\n| x | y |\n|---|---|\n| a | b |", { fragment: true })).toBe(
          "前 x y a b",
        );
      });

      it("reads a fragment that starts at the header row as it is", () => {
        expect(extractPlainText("| x | y |\n|---|---|\n| a | b |", { fragment: true })).toBe(
          "x y a b",
        );
        expect(extractPlainText("| x | y |\n|:--|--:|\n| a | b |", { fragment: true })).toBe(
          "x y a b",
        );
      });

      it("reads a header row whose delimiter row lacks the outer pipes or is indented", () => {
        const rows = "| c | d |";
        for (const delimiter of [
          "|---|---",
          "---|---|",
          "--- | ---",
          ":--|--:",
          "    |---|---|",
          "   |---|---|",
        ]) {
          expect(extractPlainText(`| a | b |\n${delimiter}\n${rows}`, { fragment: true })).toBe(
            "a b c d",
          );
        }
      });

      it("reads a header row whose delimiter row has a different number of columns as a mid-table row", () => {
        // lezer は列数の合わない区切り行を表の区切りとみなさないので、先頭行は見出し行ではない
        expect(extractPlainText("| a | b |\n|---|\n| c | d |", { fragment: true })).toBe(
          "a b --- c d",
        );
      });

      it("does not show the supplied header when the next line makes a setext heading", () => {
        expect(extractPlainText("| a | b |\n---\n後", { fragment: true })).toBe("| a | b | 後");
        expect(extractPlainText("| a | b |\n| c | d |\n===\n後", { fragment: true })).toBe(
          "| a | b | | c | d | 後",
        );
      });

      it("does not apply to a whole body", () => {
        expect(extractPlainText("| a | b |")).toBe("| a | b |");
      });

      it("keeps a vertical bar in prose and in code", () => {
        expect(extractPlainText("a | b や x || y", { fragment: true })).toBe("a | b や x || y");
        expect(extractPlainText("|x| は絶対値", { fragment: true })).toBe("|x| は絶対値");
        expect(extractPlainText("```sh\n| a | b |\n```", { fragment: true })).toBe("| a | b |");
        expect(extractPlainText("本文\n| a | b |", { fragment: true })).toBe("本文 | a | b |");
      });
    });
  });
});

describe("extractPlainTextParts", () => {
  const withoutTags = (markdown: string) => extractPlainTextParts(markdown).textWithoutTrailingTags;

  it("keeps tags in text and drops tags at the end of a line from textWithoutTrailingTags", () => {
    const parts = extractPlainTextParts("本文です。 #メモ #使い方");
    expect(parts.text).toBe("本文です。 #メモ #使い方");
    expect(parts.textWithoutTrailingTags).toBe("本文です。");
  });

  it("drops a line made only of tags, wherever it is", () => {
    expect(withoutTags("#a #b\n\n本文\n\n#c\n\n続き")).toBe("本文 続き");
  });

  it("keeps a tag inside a sentence", () => {
    expect(withoutTags("今日は #メモ を書いた #日記")).toBe("今日は #メモ を書いた");
  });

  it("keeps tags followed by text, even when another tag ends the line", () => {
    expect(withoutTags("#メモ 今日のこと")).toBe("#メモ 今日のこと");
  });

  it("drops a tag at the end of a list item and a heading", () => {
    expect(withoutTags("# 見出し #tag\n- 項目 #x/y\n- 次")).toBe("見出し 項目 次");
  });

  it("does not treat code, URL fragments or wikilink headings as tags", () => {
    expect(withoutTags("`#code`\nhttps://example.com/#section\n[[A#見出し]]")).toBe(
      "#code https://example.com/#section A#見出し",
    );
  });

  it("does not treat a non-tag hash such as an issue number as a tag", () => {
    expect(withoutTags("対応 #123")).toBe("対応 #123");
  });

  it("drops tags followed only by syntax that the plain text erases", () => {
    expect(withoutTags("本文 #tag %%c%%")).toBe("本文");
    expect(withoutTags("本文 #tag <!-- c -->")).toBe("本文");
    expect(withoutTags("本文 #tag ^abc123")).toBe("本文");
    expect(withoutTags("本文 **#tag**")).toBe("本文");
    expect(withoutTags("本文 #tag ![[img.png]]")).toBe("本文");
  });

  it("keeps a tag in the middle of a paragraph, before a soft break", () => {
    expect(withoutTags("今日は #メモ\nを書いた")).toBe("今日は #メモ を書いた");
    expect(withoutTags("- 今日は #メモ\n  を書いた #日記")).toBe("今日は #メモ を書いた");
  });

  it("drops the tags at the last line of a paragraph and tag-only lines in a paragraph", () => {
    expect(withoutTags("段落。\n#a #b")).toBe("段落。");
    expect(withoutTags("前の文\n#a #b\n続き")).toBe("前の文 続き");
    expect(withoutTags("> 引用 #q\n\n- 項目 #i")).toBe("引用 項目");
  });

  it("keeps a tag followed by punctuation", () => {
    expect(withoutTags("本文 #メモ。")).toBe("本文 #メモ。");
    expect(withoutTags("本文 #メモ、 #使い方")).toBe("本文 #メモ、");
  });

  it("keeps tags in table cells", () => {
    expect(withoutTags("| a | b |\n|---|---|\n| x #t | y |")).toBe("a b x #t y");
  });

  it("returns the same text for a body without trailing tags", () => {
    const parts = extractPlainTextParts("## 振り返り\n- 準備 [[読書メモ]]");
    expect(parts.textWithoutTrailingTags).toBe(parts.text);
  });

  it("returns empty strings for a frontmatter cut by truncation", () => {
    expect(extractPlainTextParts("---\ntags: [a]", { truncated: true })).toEqual({
      text: "",
      textWithoutTrailingTags: "",
    });
  });
});

describe("extractPlainText inline", () => {
  const inline = (markdown: string) => extractPlainText(markdown, { inline: true });

  it("keeps a line-leading marker that is displayed as text", () => {
    expect(inline("1. 手順")).toBe("1. 手順");
    expect(inline("2026. 年の目標")).toBe("2026. 年の目標");
    expect(inline("- 牛乳")).toBe("- 牛乳");
    expect(inline("# 見出し風")).toBe("# 見出し風");
    expect(inline("> 引用風")).toBe("> 引用風");
    expect(inline("---")).toBe("---");
  });

  it("still drops inline markup and a leading space", () => {
    expect(inline("  **太字** と [[ページ|別名]] と %%メモ%%")).toBe("太字 と 別名 と");
    expect(inline("")).toBe("");
  });
});
