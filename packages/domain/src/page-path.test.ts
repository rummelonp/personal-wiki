import { describe, expect, it } from "vitest";
import {
  canonicalPagePath,
  literalTitlePath,
  parsePagePath,
  RESERVED_TITLE_SEGMENTS,
  titlePath,
  WORKER_PATH_SEGMENTS,
} from "./page-path";
import { foldTitle } from "./title";

const ID = "AAAAAAAAAAAAAAAAAAAAAA";

describe("titlePath", () => {
  it("title を 1 つの path segment にエンコードする", () => {
    expect(titlePath("Hello World")).toBe("/Hello_World");
    expect(titlePath("a/b?c#d")).toBe("/a%2Fb%3Fc%23d");
    expect(titlePath("日本語")).toBe(`/${encodeURIComponent("日本語")}`);
    expect(titlePath("api-docs")).toBe("/api-docs");
    expect(titlePath("...")).toBe("/...");
    expect(titlePath("Index2")).toBe("/Index2");
    // OAuth のエンドポイントは /_auth/oauth/* に置くので、oauth は title に使える
    expect(titlePath("OAuth")).toBe("/OAuth");
  });

  it("空白の並びを 1 つの `_` にし、`_` はそのまま書く", () => {
    expect(titlePath("a  b")).toBe("/a_b");
    expect(titlePath("a\u3000b\u00a0c")).toBe("/a_b_c");
    expect(titlePath("a _ b")).toBe("/a___b");
    expect(titlePath("__init__")).toBe("/__init__");
    expect(titlePath("a_b")).toBe("/a_b");
  });

  it("`_` にした形が title と同じ title_key になる", () => {
    for (const title of ["a  b", "a _ b", "a\tb", "a\u3000b", "x _y_ z", "a ¨", "ａ　ｂ"]) {
      const path = titlePath(title) as string;
      expect(foldTitle(decodeURIComponent(path.slice(1)))).toBe(foldTitle(title));
    }
  });

  it("NFKC で空白を含む形になる文字が空白の隣にあると、空白をそのまま書く", () => {
    // "a ¨" の title_key は "a \u0308"。"a_¨" は "a  \u0308" になり、同じページを引けない
    expect(titlePath("a ¨")).toBe(`/${encodeURIComponent("a ¨")}`);
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

  it("Static Assets が先に応答する index.html、index、robots.txt は null", () => {
    for (const title of ["index", "Index", "index.html", "INDEX.HTML", "index/x", "robots.txt"]) {
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

  it("予約語の判定は `_` を空白にしない", () => {
    expect(titlePath("_Auth")).toBeNull();
    expect(titlePath("_auth/x")).toBeNull();
    expect(titlePath("auth_")).toBe("/auth_");
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

  it("`_` を空白に戻さない", () => {
    expect(parsePagePath("/a_b")).toEqual({ kind: "title", title: "a_b" });
    expect(parsePagePath("/__init__")).toEqual({ kind: "title", title: "__init__" });
    expect(parsePagePath("/_auth")).toBeNull();
  });

  it("titlePath で作ったパスは同じ title_key の title に戻る", () => {
    for (const title of [
      "Hello World",
      "a/b",
      "日本語",
      "100%",
      "Note/",
      "a?b#c",
      "x+y&z",
      "a_b",
    ]) {
      const path = titlePath(title);
      expect(path).not.toBeNull();
      const parsed = parsePagePath(path as string);
      expect(parsed?.kind === "title" && foldTitle(parsed.title)).toBe(foldTitle(title));
    }
  });

  it("literalTitlePath で作ったパスは同じ title に戻る", () => {
    for (const title of ["Hello World", "a/b", "a_b", "a  b", "100%", "Note/"]) {
      const path = literalTitlePath(title);
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
    expect(canonicalPagePath({ id: ID, title: "My Note", visibility: "public" })).toBe("/My_Note");
  });
});
