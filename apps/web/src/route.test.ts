import { describe, expect, it } from "vitest";
import { homeHref, pageHref, parseRoute } from "./route";

const ID = "AAAAAAAAAAAAAAAAAAAAAA";

describe("parseRoute", () => {
  it("/ はクエリ q を検索語として読む", () => {
    expect(parseRoute("/", "")).toEqual({ name: "home", query: "" });
    expect(parseRoute("/", "?q=%E6%A4%9C%E7%B4%A2")).toEqual({ name: "home", query: "検索" });
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
    expect(pageHref(ID)).toBe(`/p/${ID}`);
  });
});
