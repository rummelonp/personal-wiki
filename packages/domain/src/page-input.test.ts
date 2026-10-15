import { describe, expect, it } from "vitest";
import { textHasNul, titleHasControlChar } from "./page-input";

describe("textHasNul", () => {
  it("detects NUL anywhere in the text", () => {
    expect(textHasNul("\u0000")).toBe(true);
    expect(textHasNul("a\u0000b")).toBe(true);
    expect(textHasNul("end\u0000")).toBe(true);
  });

  it("accepts tab, line breaks, and other control characters", () => {
    expect(textHasNul("a\tb\r\nc\nd")).toBe(false);
    expect(textHasNul("\u0001\u001f\u007f")).toBe(false);
  });

  it("accepts an empty string and plain text", () => {
    expect(textHasNul("")).toBe(false);
    expect(textHasNul("会議メモ")).toBe(false);
  });
});

describe("titleHasControlChar", () => {
  it("detects every C0 control character, including NUL and tab", () => {
    for (let code = 0; code <= 0x1f; code++) {
      expect(titleHasControlChar(`a${String.fromCharCode(code)}b`)).toBe(true);
    }
  });

  it("accepts a title without control characters", () => {
    expect(titleHasControlChar("会議メモ 2026-09-12 (定例)")).toBe(false);
    expect(titleHasControlChar("")).toBe(false);
  });

  it("does not reject DEL or characters above C0", () => {
    expect(titleHasControlChar("a\u007fb")).toBe(false);
    expect(titleHasControlChar("a\u0080b")).toBe(false);
  });
});
