import { describe, expect, it } from "vitest";
import { syntaxByLine } from "./line-syntax";

/** 各行の記法の文字を、区間ごとに切り出して返す。 */
function markedText(markdown: string): string[][] {
  const lines = markdown.split("\n");
  return syntaxByLine(markdown).map((line, index) =>
    line.marks.map((range) => (lines[index] as string).slice(range.from, range.to)),
  );
}

function codeLines(markdown: string): boolean[] {
  return syntaxByLine(markdown).map((line) => line.code);
}

describe("syntaxByLine", () => {
  it("diffLines と同じく \\n で区切った行の数だけ返す", () => {
    expect(syntaxByLine("")).toHaveLength(1);
    expect(syntaxByLine("a\n")).toHaveLength(2);
    expect(syntaxByLine("a\nb\nc")).toHaveLength(3);
  });

  it("見出し・リスト・task・引用の記号を記法にし、本文の語は残す", () => {
    expect(markedText("## 記録\n- [ ] 感想を書く\n> 書くことは考えること")).toEqual([
      ["##"],
      ["-", "[ ]"],
      [">"],
    ]);
  });

  it("強調・取り消し・ハイライト・inline code の記号を記法にする", () => {
    expect(markedText("**太字** ~~消す~~ ==印== `code`")).toEqual([
      ["**", "**", "~~", "~~", "==", "==", "`", "`"],
    ]);
  });

  it("WikiLink の括弧と区切り、embed の ! を記法にし、target と label は残す", () => {
    expect(markedText("[[週次レビュー|週次]] と ![[図]]")).toEqual([
      ["[[", "|", "]]", "![[", "]]"],
    ]);
  });

  it("リンクの括弧と URL を記法にし、表示する文字は残す", () => {
    expect(markedText('[読書メモ](https://example.com "題")')).toEqual([
      ["[", "](https://example.com", '"題")'],
    ]);
  });

  it("表は区切り行の全体とセルの間の | を記法にする", () => {
    expect(markedText("| 書名 | 評価 |\n| --- | --- |\n| 思考の整理学 | ★ |")).toEqual([
      ["|", "|", "|"],
      ["| --- | --- |"],
      ["|", "|", "|"],
    ]);
  });

  it("fence の行は記号と言語名を記法にし、fence の内側も含めて code の行とする", () => {
    const markdown = "前\n```ts\nconst a = 1;\n  # 見出しではない\n```\n後";
    expect(codeLines(markdown)).toEqual([false, true, true, true, true, false]);
    // fence の内側の `#` は見出しの記号ではない（行ごとに parse すると見出しと読んでしまう）
    expect(markedText(markdown)).toEqual([[], ["```ts"], [], [], ["```"], []]);
  });

  it("閉じていない fence は本文の終わりまで code の行とする", () => {
    expect(codeLines("```\na\nb")).toEqual([true, true, true]);
  });

  it("字下げの code block も code の行とする", () => {
    expect(codeLines("段落\n\n    code\n\n後")).toEqual([false, false, true, false, false]);
  });

  it("frontmatter は code の行とし、区切りの --- を記法にする", () => {
    const markdown = "---\ntags: [a]\n---\n本文";
    expect(codeLines(markdown)).toEqual([true, true, true, false]);
    expect(markedText(markdown)).toEqual([["---"], [], ["---"], []]);
  });

  it("frontmatter の区切りは parser と同じく前後の空白と CRLF を許し、--- の位置を記法にする", () => {
    const markdown = "---\r\ntags: [a]\r\n  ---  \r\n本文";
    expect(codeLines(markdown)).toEqual([true, true, true, false]);
    expect(markedText(markdown)).toEqual([["---"], [], ["---"], []]);
    expect(syntaxByLine(markdown)[2]?.marks).toEqual([{ from: 2, to: 5 }]);
  });

  it("コメントは複数行にまたがっても丸ごと記法にする", () => {
    expect(markedText("前 %%メモ%% 後\n%%\n隠す\n%%\n<!-- h -->")).toEqual([
      ["%%メモ%%"],
      ["%%"],
      ["隠す"],
      ["%%"],
      ["<!-- h -->"],
    ]);
  });

  it("水平線・block id・escape の \\ を記法にし、#tag は本文の語として残す", () => {
    expect(markedText("段落 ^abc\n\n---\n\n\\*星\\* #reading")).toEqual([
      ["^abc"],
      [],
      ["---"],
      [],
      ["\\", "\\"],
    ]);
  });

  it("隣り合う記法は 1 つの区間にまとめる", () => {
    expect(syntaxByLine("***強***")[0]?.marks).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
    ]);
  });
});
