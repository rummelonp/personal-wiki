import { describe, expect, it } from "vitest";
import { pageUrls } from "./urls";

// titlePath の規則のテストは packages/domain の page-path.test.ts にある

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
