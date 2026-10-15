import { titlePath } from "@personal-wiki/domain";
import { describe, expect, it } from "vitest";
import { readableUrl } from "./PublishBar";

const origin = "https://wiki.example";
const path = (title: string) => {
  const found = titlePath(title);
  if (found === null) throw new Error(`title の URL にならない: ${title}`);
  return found;
};
const shown = (title: string) => readableUrl(`${origin}${path(title)}`);

describe("readableUrl", () => {
  it("日本語の title は文字で見せる", () => {
    expect(shown("設計メモ")).toBe(`${origin}/設計メモ`);
  });

  it("title の空白は URL で `_` になっている", () => {
    expect(shown("週次 ふりかえり")).toBe(`${origin}/週次_ふりかえり`);
    expect(shown("全角　空白")).toBe(`${origin}/全角_空白`);
  });

  it("URL に残った空白は戻さず、貼った先で URL が切れない", () => {
    // `_` にすると title_key が変わる title は、空白を encode したまま URL に残る
    expect(shown("a ¨")).toBe(`${origin}/a%20¨`);
    expect(readableUrl(`${origin}/%E5%85%A8%E3%80%80`)).toBe(`${origin}/全%E3%80%80`);
  });

  it("% を含む title は、貼った先で同じページを指す", () => {
    for (const title of ["100%", "a%2Fb", "50%オフ"]) {
      const url = shown(title);
      expect(decodeURIComponent(new URL(url).pathname.slice(1))).toBe(title);
    }
  });

  it("区切りの記号は encode したまま残す", () => {
    expect(shown("a/b?c")).toBe(`${origin}${path("a/b?c")}`);
  });
});
