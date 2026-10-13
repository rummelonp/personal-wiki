import { describe, expect, it } from "vitest";
import { homeHref, pageHref, pageHrefFor, parseRoute, tagHref } from "./route";

const ID = "AAAAAAAAAAAAAAAAAAAAAA";

describe("parseRoute", () => {
  it("/ はクエリ q を検索語として読む", () => {
    expect(parseRoute("/", "")).toEqual({ name: "home", query: "", tag: "" });
    expect(parseRoute("/", "?q=%E6%A4%9C%E7%B4%A2")).toEqual({
      name: "home",
      query: "検索",
      tag: "",
    });
    expect(parseRoute("/", "?tag=%E6%97%A5%E8%A8%98")).toMatchObject({ query: "", tag: "日記" });
  });

  it("/p/<id> は id の形のときだけページにする", () => {
    expect(parseRoute(`/p/${ID}`, "")).toEqual({ name: "page", id: ID });
    expect(parseRoute(`/p/${ID}/`, "")).toEqual({ name: "page", id: ID });
    expect(parseRoute("/p/short", "")).toEqual({ name: "unknown" });
    expect(parseRoute(`/p/${ID}/x`, "")).toEqual({ name: "unknown" });
  });

  it("それ以外の最上位のパスは、decode した title のページにする", () => {
    expect(parseRoute(`/${encodeURIComponent("タイトル")}`, "")).toEqual({
      name: "title",
      title: "タイトル",
    });
    expect(parseRoute("/search", "?q=x")).toEqual({ name: "title", title: "search" });
    expect(parseRoute("/a%2Fb%3Fc", "")).toEqual({ name: "title", title: "a/b?c" });
    expect(parseRoute("/a/b", "")).toEqual({ name: "title", title: "a/b" });
  });

  it("/<title>/ は /p/<id>/ と同じく末尾の / を外す", () => {
    expect(parseRoute("/Note/", "")).toEqual({ name: "title", title: "Note" });
    expect(parseRoute("/Note%2F", "")).toEqual({ name: "title", title: "Note/" });
  });

  it("予約語、Static Assets の名前、decode できないパスは unknown にする", () => {
    for (const path of ["/api", "/API", "/mcp/x", "/_auth", "/p", "/P/x", "/index", "/%E0%A4%A"]) {
      expect(parseRoute(path, ""), path).toEqual({ name: "unknown" });
    }
  });
});

describe("href", () => {
  it("検索語が空なら / にし、あればクエリに入れる", () => {
    expect(homeHref("  ")).toBe("/");
    expect(homeHref(" a b ")).toBe("/?q=a%20b");
    expect(tagHref("日記 a")).toBe("/?tag=%E6%97%A5%E8%A8%98%20a");
    expect(pageHref(ID)).toBe(`/p/${ID}`);
  });

  it("public のページは /<title>、draft と予約語の title は /p/<id> にする", () => {
    expect(pageHrefFor({ id: ID, title: "a/b c", visibility: "public" })).toBe("/a%2Fb%20c");
    expect(pageHrefFor({ id: ID, title: "a/b c", visibility: "draft" })).toBe(`/p/${ID}`);
    expect(pageHrefFor({ id: ID, title: "API", visibility: "public" })).toBe(`/p/${ID}`);
  });

  it("pageHrefFor の URL は parseRoute で同じ title に戻る", () => {
    for (const title of ["日本語", "a/b", "100%", "x?y#z", "Note/"]) {
      const href = pageHrefFor({ id: ID, title, visibility: "public" });
      expect(parseRoute(href, "")).toEqual({ name: "title", title });
    }
  });
});
