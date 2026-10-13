import { describe, expect, it } from "vitest";
import { homeHref, pageHref, parseRoute, tagHref } from "./route";

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

  it("/p/<id> だけをページとして読む", () => {
    expect(parseRoute(`/p/${ID}`, "")).toEqual({ name: "page", id: ID });
    expect(parseRoute(`/p/${ID}/`, "")).toEqual({ name: "page", id: ID });
    expect(parseRoute("/p/short", "")).toEqual({ name: "unknown" });
    expect(parseRoute(`/p/${ID}/x`, "")).toEqual({ name: "unknown" });
  });

  it("それ以外の最上位のパスは unknown にする", () => {
    for (const path of ["/search", "/new", "/タイトル"]) {
      expect(parseRoute(path, "")).toEqual({ name: "unknown" });
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
});
