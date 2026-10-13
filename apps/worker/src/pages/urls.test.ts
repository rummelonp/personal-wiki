import { describe, expect, it } from "vitest";
import { pageUrls, titlePath } from "./urls";

describe("titlePath", () => {
  it("title を 1 つの path segment にエンコードする", () => {
    expect(titlePath("Hello World")).toBe("/Hello%20World");
    expect(titlePath("a/b?c#d")).toBe("/a%2Fb%3Fc%23d");
    expect(titlePath("日本語")).toBe(`/${encodeURIComponent("日本語")}`);
    expect(titlePath("api-docs")).toBe("/api-docs");
    expect(titlePath("...")).toBe("/...");
  });

  it("予約語と重なる title は、大文字小文字と全角半角、`/` の後ろを問わず null", () => {
    for (const title of [
      "api",
      "API",
      "ＭＣＰ",
      "assets",
      "_auth",
      ".well-known",
      ".well-known/x",
      "p",
      "P",
      "p/x",
      "api/pages",
    ]) {
      expect(titlePath(title)).toBeNull();
    }
  });

  it("URL の解決で消える `.` と `..` の segment を含む title は null", () => {
    for (const title of [".", "..", "../api", "./mcp", "a/../api", "a/.", "．．／api"]) {
      expect(titlePath(title)).toBeNull();
    }
  });

  it("先頭の segment が空の title は null", () => {
    for (const title of ["/api", "/", "／mcp", "//x"]) {
      expect(titlePath(title)).toBeNull();
    }
  });

  it("全角の `／` も区切りとして予約語を判定する", () => {
    expect(titlePath("api／pages")).toBeNull();
    expect(titlePath("ａｐｉ／x")).toBeNull();
    expect(titlePath("apix／api")).toBe(`/${encodeURIComponent("apix／api")}`);
  });
});

describe("pageUrls", () => {
  const origin = "https://wiki.example.com";

  it("draft は /p/<id> だけ", () => {
    expect(pageUrls(origin, { id: "abc", title: "Note", visibility: "draft" })).toEqual({
      url: "https://wiki.example.com/p/abc",
      titleUrl: null,
    });
  });

  it("public は title の URL も持つ", () => {
    expect(pageUrls(origin, { id: "abc", title: "Note", visibility: "public" })).toEqual({
      url: "https://wiki.example.com/p/abc",
      titleUrl: "https://wiki.example.com/Note",
    });
  });
});
