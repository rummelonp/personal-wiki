import { describe, expect, it } from "vitest";
import {
  canonicalPagePath,
  parsePagePath,
  RESERVED_TITLE_SEGMENTS,
  titlePath,
  WORKER_PATH_SEGMENTS,
} from "./page-path";

const ID = "AAAAAAAAAAAAAAAAAAAAAA";

describe("titlePath", () => {
  it("title を 1 つの path segment にエンコードする", () => {
    expect(titlePath("Hello World")).toBe("/Hello%20World");
    expect(titlePath("a/b?c#d")).toBe("/a%2Fb%3Fc%23d");
    expect(titlePath("日本語")).toBe(`/${encodeURIComponent("日本語")}`);
    expect(titlePath("api-docs")).toBe("/api-docs");
    expect(titlePath("...")).toBe("/...");
    expect(titlePath("Index2")).toBe("/Index2");
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
      "oauth",
      "OAuth/token",
      "p",
      "P",
      "p/x",
      "api/pages",
    ]) {
      expect(titlePath(title)).toBeNull();
    }
  });

  it("Static Assets が先に応答する index.html と index は null", () => {
    for (const title of ["index", "Index", "index.html", "INDEX.HTML", "index/x"]) {
      expect(titlePath(title)).toBeNull();
    }
  });

  it("URL の解決で消える `.` と `..` の segment を含む title は null", () => {
    for (const title of [".", "..", "../api", "./mcp", "a/../api", "a/.", "．．／api"]) {
      expect(titlePath(title)).toBeNull();
    }
  });

  it("先頭の segment が空の title は null", () => {
    for (const title of ["/api", "/", "／mcp", "//x", "", "  "]) {
      expect(titlePath(title)).toBeNull();
    }
  });

  it("全角の `／` も区切りとして予約語を判定する", () => {
    expect(titlePath("api／pages")).toBeNull();
    expect(titlePath("ａｐｉ／x")).toBeNull();
    expect(titlePath("apix／api")).toBe(`/${encodeURIComponent("apix／api")}`);
  });

  it("Worker が応答する segment はすべて予約語に入っている", () => {
    for (const segment of WORKER_PATH_SEGMENTS) {
      expect(RESERVED_TITLE_SEGMENTS).toContain(segment);
    }
  });
});

describe("parsePagePath", () => {
  it("/p/<id> は id の形のときだけページにする", () => {
    expect(parsePagePath(`/p/${ID}`)).toEqual({ kind: "id", id: ID });
    expect(parsePagePath(`/p/${ID}/`)).toEqual({ kind: "id", id: ID });
    expect(parsePagePath("/p/short")).toBeNull();
    expect(parsePagePath(`/p/${ID}/x`)).toBeNull();
    expect(parsePagePath(`/P/${ID}`)).toBeNull();
    expect(parsePagePath("/p/")).toBeNull();
  });

  it("/<title> は 1 回だけ decode した title にする", () => {
    expect(parsePagePath("/Hello%20World")).toEqual({ kind: "title", title: "Hello World" });
    expect(parsePagePath(`/${encodeURIComponent("日本語")}`)).toEqual({
      kind: "title",
      title: "日本語",
    });
    expect(parsePagePath("/a%2Fb%3Fc%23d")).toEqual({ kind: "title", title: "a/b?c#d" });
    expect(parsePagePath("/100%2525")).toEqual({ kind: "title", title: "100%25" });
  });

  it("エンコードされていない途中の `/` は title の `/` として読む", () => {
    expect(parsePagePath("/a/b")).toEqual({ kind: "title", title: "a/b" });
  });

  it("末尾の `/` は 1 つまで外し、`%2F` は title に残す", () => {
    expect(parsePagePath("/Note/")).toEqual({ kind: "title", title: "Note" });
    expect(parsePagePath("/Note%2F")).toEqual({ kind: "title", title: "Note/" });
    expect(parsePagePath("/Note//")).toEqual({ kind: "title", title: "Note/" });
  });

  it("titlePath が使わない title と、decode できないパスは null", () => {
    for (const path of [
      "/",
      "//",
      "/api",
      "/API",
      "/mcp/x",
      "/assets",
      "/index",
      "/index.html",
      "/p",
      "/P/x",
      "/%E0%A4%A",
      "/..",
      "/a/../api",
      "/%20",
      "no-slash",
    ]) {
      expect(parsePagePath(path)).toBeNull();
    }
  });

  it("titlePath で作ったパスは同じ title に戻る", () => {
    for (const title of ["Hello World", "a/b", "日本語", "100%", "Note/", "a?b#c", "x+y&z"]) {
      const path = titlePath(title);
      expect(path).not.toBeNull();
      expect(parsePagePath(path as string)).toEqual({ kind: "title", title });
    }
  });
});

describe("canonicalPagePath", () => {
  it("public は /<title>、draft と予約語の title は /p/<id>", () => {
    expect(canonicalPagePath({ id: ID, title: "Note", visibility: "public" })).toBe("/Note");
    expect(canonicalPagePath({ id: ID, title: "Note", visibility: "draft" })).toBe(`/p/${ID}`);
    expect(canonicalPagePath({ id: ID, title: "api", visibility: "public" })).toBe(`/p/${ID}`);
  });
});
