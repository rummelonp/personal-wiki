import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { highlightMatches, splitMatches } from "./highlight";

const marked = (text: string, needles: string[]) =>
  splitMatches(text, needles)
    .filter((segment) => segment.marked)
    .map((segment) => segment.text);

describe("splitMatches", () => {
  it("当たった箇所とそれ以外に分け、つなぐと元の文字列に戻る", () => {
    const segments = splitMatches("Hono で作る wiki と hono", ["hono"]);
    expect(segments).toEqual([
      { text: "Hono", marked: true },
      { text: " で作る wiki と ", marked: false },
      { text: "hono", marked: true },
    ]);
    expect(segments.map((s) => s.text).join("")).toBe("Hono で作る wiki と hono");
  });

  it("大文字小文字を区別せず、元の表記のまま返す", () => {
    expect(marked("README と ReadMe", ["readme"])).toEqual(["README", "ReadMe"]);
  });

  it("検索 API と同じ NFKC で畳んで比べ、全角と半角の違いを越えて当てる", () => {
    expect(marked("ＡＢＣ とﾒﾓ", ["abc"])).toEqual(["ＡＢＣ"]);
    expect(marked("ＡＢＣ とﾒﾓ", ["メモ"])).toEqual(["ﾒﾓ"]);
    // 語の側が全角でも、本文の半角に当たる
    expect(marked("abc", ["ＡＢＣ"])).toEqual(["abc"]);
  });

  it("畳むと長さが変わる文字は、文字の範囲ごと塗る", () => {
    expect(marked("㌀ の件", ["パート"])).toEqual(["㌀"]);
    expect(marked("㌀ の件", ["ア"])).toEqual(["㌀"]);
  });

  it("合成される濁点つきの文字を、基底の文字と分けない", () => {
    // 「か」+ 結合濁点は NFKC で「が」になる
    expect(marked("がき", ["が"])).toEqual(["が"]);
  });

  it("半角カナの濁点、半濁点を前の文字と分けず、全角の語にも半角の語にも当てる", () => {
    expect(marked("ｶﾞｲﾄﾞ と ﾊﾟｰﾄ", ["ガイド"])).toEqual(["ｶﾞｲﾄﾞ"]);
    expect(marked("ｶﾞｲﾄﾞ と ﾊﾟｰﾄ", ["パート"])).toEqual(["ﾊﾟｰﾄ"]);
    expect(marked("ｶﾞｲﾄﾞ と ﾊﾟｰﾄ", ["ｶﾞｲﾄﾞ", "ﾊﾟｰﾄ"])).toEqual(["ｶﾞｲﾄﾞ", "ﾊﾟｰﾄ"]);
    expect(marked("ﾊﾟｰﾄ", ["ﾊﾟ"])).toEqual(["ﾊﾟ"]);
  });

  it("分解された Hangul の字母を 1 文字として当てる", () => {
    const decomposed = "\u1100\u1161"; // 가
    expect(marked(`a${decomposed}b`, ["가"])).toEqual([decomposed]);
    expect(marked("가", [decomposed])).toEqual(["가"]);
  });

  it("title の比較と同じ case fold で、語末の Σ や ß を当てる", () => {
    expect(marked("ΑΣ と Straße", ["ασ", "strasse"])).toEqual(["ΑΣ", "Straße"]);
  });

  it("空白を含む語は、空白を含めた並びとして当てる", () => {
    expect(marked("foo bar と foo と bar", ["foo bar"])).toEqual(["foo bar"]);
    expect(marked("foo  bar", ["foo bar"])).toEqual([]);
  });

  it("複数の語はそれぞれ塗り、重なる範囲は 1 つにまとめる", () => {
    expect(marked("abcdef gh", ["abc", "cde", "gh"])).toEqual(["abcde", "gh"]);
    // 長い語を含む短い語があっても、長い語の範囲を割らない
    expect(marked("メモ帳", ["メモ", "メモ帳"])).toEqual(["メモ帳"]);
  });

  it("正規表現の記号は文字として当てる", () => {
    expect(marked("a.c と abc と (x)", [".", "(x)"])).toEqual([".", "(x)"]);
  });

  it("サロゲートペアの文字を壊さない", () => {
    expect(marked("𠮷野家", ["野"])).toEqual(["野"]);
    expect(marked("𠮷野家", ["𠮷"])).toEqual(["𠮷"]);
  });

  it("語が空か、当たりが無いときは分けない", () => {
    expect(splitMatches("本文", [])).toEqual([{ text: "本文", marked: false }]);
    expect(splitMatches("本文", ["", "  "])).toEqual([{ text: "本文", marked: false }]);
    expect(splitMatches("本文", ["無い"])).toEqual([{ text: "本文", marked: false }]);
    expect(splitMatches("", ["a"])).toEqual([{ text: "", marked: false }]);
  });
});

describe("splitMatches の underscoreAsSpace", () => {
  const markedAsTitle = (text: string, needles: string[]) =>
    splitMatches(text, needles, { underscoreAsSpace: true })
      .filter((segment) => segment.marked)
      .map((segment) => segment.text);

  it("`_` と空白を同じ文字として当て、元の表記のまま塗る", () => {
    expect(markedAsTitle("My Note", ["my_note"])).toEqual(["My Note"]);
    expect(markedAsTitle("my_note", ["my note"])).toEqual(["my_note"]);
    expect(markedAsTitle("snake_case", ["e_c"])).toEqual(["e_c"]);
  });

  it("語の端の `_` は、trim せず空白として当てる", () => {
    expect(markedAsTitle("a b", ["a_"])).toEqual(["a "]);
    expect(markedAsTitle("ab", ["a_"])).toEqual([]);
  });

  it("指定が無ければ `_` と空白を区別する", () => {
    expect(marked("My Note", ["my_note"])).toEqual([]);
    expect(marked("snake_case", ["snake case"])).toEqual([]);
  });
});

describe("highlightMatches", () => {
  it("当たった箇所を mark の要素にし、HTML として解釈させない", () => {
    const html = renderToStaticMarkup(
      <p>{highlightMatches('<img src=x onerror="alert(1)"> と <b>', ["<b>", "img"])}</p>,
    );
    expect(html).toBe(
      "<p>&lt;<mark>img</mark> src=x onerror=&quot;alert(1)&quot;&gt; と <mark>&lt;b&gt;</mark></p>",
    );
  });

  it("当たりが無ければ文字列をそのまま返す", () => {
    expect(highlightMatches("本文", ["無い"])).toBe("本文");
  });
});
