import { describe, expect, it } from "vitest";
import {
  isValidSiteDescription,
  isValidSiteName,
  SITE_DESCRIPTION_MAX_CHARS,
  SITE_NAME_MAX_CHARS,
} from "./site-name";

describe("isValidSiteName", () => {
  it("空でない 1 行の名前を、40 文字（code point）まで通す", () => {
    expect(isValidSiteName("rummelonp wiki")).toBe(true);
    expect(isValidSiteName("あ".repeat(SITE_NAME_MAX_CHARS))).toBe(true);
    expect(isValidSiteName("あ".repeat(SITE_NAME_MAX_CHARS + 1))).toBe(false);
    expect(isValidSiteName("")).toBe(false);
  });

  it("サロゲートペアは 1 字と数える", () => {
    expect(isValidSiteName("😀".repeat(SITE_NAME_MAX_CHARS))).toBe(true);
    expect(isValidSiteName("😀".repeat(SITE_NAME_MAX_CHARS + 1))).toBe(false);
  });

  it("制御文字、行区切り、向きを変える書式文字を弾く", () => {
    for (const bad of ["a\nb", "a\tb", "a\u007fb", "a\u0085b", "a\u2028b", "a\u2029b"]) {
      expect(isValidSiteName(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const bad of ["a\u202eb", "a\u2066b", "a\u200eb", "a\u200bb", "a\ufeffb"]) {
      expect(isValidSiteName(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("絵文字の結合とペルシア語の分かち書きに要る U+200C と U+200D は通す", () => {
    expect(isValidSiteName("👨\u200d👩\u200d👧")).toBe(true);
    expect(isValidSiteName("می\u200cخواهم")).toBe(true);
  });

  it("U+200C と U+200D と空白だけで、見える文字が無い名前は弾く", () => {
    for (const bad of ["\u200c", "\u200d", "\u200c\u200d", "\u200d \u200c", " ", "\u3000\u200d"]) {
      expect(isValidSiteName(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const good of ["a\u200d", "\u200c.", "\u200d😀"]) {
      expect(isValidSiteName(good), JSON.stringify(good)).toBe(true);
    }
  });
});

describe("isValidSiteDescription", () => {
  it("サイト名と同じ文字の規則で、200 文字（code point）まで通す", () => {
    expect(isValidSiteDescription("一人用の Markdown wiki。")).toBe(true);
    expect(isValidSiteDescription("😀".repeat(SITE_DESCRIPTION_MAX_CHARS))).toBe(true);
    expect(isValidSiteDescription("😀".repeat(SITE_DESCRIPTION_MAX_CHARS + 1))).toBe(false);
    for (const bad of ["", " ", "\u200d", "a\nb", "a\u2028b", "a\u202eb"]) {
      expect(isValidSiteDescription(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
