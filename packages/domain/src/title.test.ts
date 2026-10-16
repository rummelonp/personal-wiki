import { describe, expect, it } from "vitest";
import { isErr, isOk } from "./result";
import {
  foldKeepingUnderscore,
  foldTitle,
  normalizeTitleKey,
  singleLineTitle,
  titleInputText,
  wikiLinkUnsafeChars,
} from "./title";

describe("titleInputText", () => {
  it("改行とタブを 1 つずつ空白にし、ほかの C0 と DEL を除き、trim しない", () => {
    expect(titleInputText(" a\r\nb\tc\u0000d\u0001e\u001ff\u007fg ")).toBe(" a b cdefg ");
  });

  it("C0 の外の文字と、改行のない入力はそのまま返す", () => {
    expect(titleInputText("会議\u0080メモ 😀")).toBe("会議\u0080メモ 😀");
  });
});

describe("wikiLinkUnsafeChars", () => {
  it("returns nothing for a title a WikiLink can target", () => {
    expect(wikiLinkUnsafeChars("会議メモ 2026-09-12 (定例)")).toEqual([]);
  });

  it("returns each unsafe character once, in order of appearance", () => {
    expect(wikiLinkUnsafeChars("C# ^と [a|b] と C#")).toEqual(["#", "^", "[", "|", "]"]);
  });

  it("returns a trailing backslash, which a labelled link would read as part of \\|", () => {
    expect(wikiLinkUnsafeChars("C\\")).toEqual(["\\"]);
    expect(wikiLinkUnsafeChars("C# \\")).toEqual(["#", "\\"]);
  });

  it("allows a backslash that is not at the end", () => {
    expect(wikiLinkUnsafeChars("a\\b")).toEqual([]);
  });
});

describe("singleLineTitle", () => {
  it("replaces each line break and tab with a space and trims", () => {
    expect(singleLineTitle(" a\r\nb\nc\td\u2028e ")).toBe("a b c d e");
    expect(singleLineTitle("a\t\tb")).toBe("a  b");
  });
});

describe("foldTitle", () => {
  it("returns an empty string instead of failing for blank input", () => {
    expect(foldTitle("   ")).toBe("");
  });

  it("treats `_` as a space after trimming and collapsing whitespace", () => {
    expect(foldTitle("a_b")).toBe(foldTitle("a b"));
    expect(foldTitle("A_B")).toBe("a b");
    expect(foldTitle("a__b")).toBe("a  b");
    expect(foldTitle("a__b")).not.toBe(foldTitle("a b"));
    expect(foldTitle("__init__")).toBe("  init  ");
    expect(foldTitle("__init__")).not.toBe(foldTitle("init"));
    // 全角の `＿` も NFKC で `_` になる
    expect(foldTitle("a＿b")).toBe("a b");
  });

  it("equals replacing `_` with a space in the key that keeps `_`", () => {
    for (const title of ["a_b", " a  _ b ", "__x__", "Ａ＿Ｂ", "a\t_b"]) {
      expect(foldTitle(title)).toBe(foldKeepingUnderscore(title).replaceAll("_", " "));
    }
  });

  it("applies the same folding as normalizeTitleKey", () => {
    const result = normalizeTitleKey("  ＣｏｄｅＭｉｒｒｏｒ   Ｒｅｖｉｅｗ ");
    expect(isOk(result) && result.value).toBe(foldTitle("  ＣｏｄｅＭｉｒｒｏｒ   Ｒｅｖｉｅｗ "));
  });
});

describe("normalizeTitleKey", () => {
  it("lowercases ASCII titles", () => {
    const result = normalizeTitleKey("AbC");
    expect(isOk(result) && result.value).toBe("abc");
  });

  it("trims leading and trailing whitespace", () => {
    const result = normalizeTitleKey("  Hello  ");
    expect(isOk(result) && result.value).toBe("hello");
  });

  it("collapses runs of internal whitespace into a single space", () => {
    const result = normalizeTitleKey("Hello   World");
    expect(isOk(result) && result.value).toBe("hello world");
  });

  it("folds fullwidth Latin letters to halfwidth via NFKC", () => {
    // "Ａ" (U+FF21 FULLWIDTH LATIN CAPITAL LETTER A) -> NFKC -> "A" -> case fold -> "a"
    const result = normalizeTitleKey("Ａ");
    expect(isOk(result) && result.value).toBe("a");
  });

  it("folds halfwidth katakana to fullwidth via NFKC", () => {
    // "ｱ" (U+FF71 HALFWIDTH KATAKANA LETTER A) -> NFKC -> "ア"
    const result = normalizeTitleKey("ｱ");
    expect(isOk(result) && result.value).toBe("ア");
  });

  it("treats titles differing only by fullwidth/halfwidth or case as identical keys", () => {
    const a = normalizeTitleKey("Ｔest");
    const b = normalizeTitleKey("test");
    expect(isOk(a) && isOk(b) && a.value === b.value).toBe(true);
  });

  it("rejects a title that is empty after trimming", () => {
    const result = normalizeTitleKey("   ");
    expect(isErr(result) && result.error.kind).toBe("empty_title");
  });

  it("folds the German sharp s to 'ss' (Unicode default case fold, not toLowerCase)", () => {
    const result = normalizeTitleKey("Straße");
    expect(isOk(result) && result.value).toBe("strasse");
  });

  it("folds the capital sharp s to 'ss'", () => {
    const result = normalizeTitleKey("ẞ");
    expect(isOk(result) && result.value).toBe("ss");
  });

  it("folds both Greek sigma forms (Σ and final ς) to the same key", () => {
    const upper = normalizeTitleKey("Σ");
    const final = normalizeTitleKey("ς");
    expect(isOk(upper) && upper.value).toBe("σ");
    expect(isOk(final) && final.value).toBe("σ");
  });

  it("folds a word-final capital sigma the same as its lowercase form", () => {
    for (const title of ["ΑΣ", "ας", "ασ", "Ας"]) {
      const key = normalizeTitleKey(title);
      expect(isOk(key) && key.value).toBe("ασ");
    }
    expect(foldTitle("ΣΑΣ ΚΑΣ")).toBe(foldTitle("σασ κασ"));
  });
});
