import { afterEach, describe, expect, it, vi } from "vitest";
import {
  homeHref,
  navigate,
  newPageHref,
  pageHref,
  pageHrefFor,
  parseRoute,
  tagHref,
} from "./route";

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

  it("/?new は新規作成の画面にする。ほかのパスの new は title として読む", () => {
    expect(parseRoute("/", newPageHref.slice(1))).toEqual({ name: "new" });
    expect(parseRoute("/", "?new=")).toEqual({ name: "new" });
    expect(parseRoute("/new", "")).toEqual({ name: "title", title: "new" });
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

describe("navigate のスクロール", () => {
  /** pushState と replaceState が location を更新するだけの、最小の window と history */
  function stubBrowser(start: string) {
    const location = new URL(start, "http://wiki.test");
    const move = (_state: unknown, _title: string, href: string) => {
      const next = new URL(href, location);
      location.pathname = next.pathname;
      location.search = next.search;
      location.hash = next.hash;
    };
    const scrollTo = vi.fn();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { location, scrollTo, dispatchEvent, scrollY: 0 });
    vi.stubGlobal("history", { state: null, pushState: vi.fn(move), replaceState: vi.fn(move) });
    return { scrollTo, dispatchEvent };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("パスが変わる遷移は、先頭へ戻して通知する", () => {
    const { scrollTo, dispatchEvent } = stubBrowser(`/p/${ID}`);
    navigate("/%E9%A1%8C");
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(history.pushState).toHaveBeenCalledOnce();
  });

  it("URL を更新してから先頭へ戻し、その後で通知する", () => {
    const { scrollTo, dispatchEvent } = stubBrowser("/A");
    navigate("/B");
    const push = vi.mocked(history.pushState).mock.invocationCallOrder[0] as number;
    const scroll = scrollTo.mock.invocationCallOrder[0] as number;
    const notify = dispatchEvent.mock.invocationCallOrder[0] as number;
    expect(push).toBeLessThan(scroll);
    expect(scroll).toBeLessThan(notify);
  });

  it("パスが同じでクエリだけ変わる遷移も、先頭へ戻す", () => {
    const { scrollTo } = stubBrowser("/?q=a");
    navigate("/?q=b");
    expect(scrollTo).toHaveBeenCalledOnce();
  });

  it("別のパスの hash 付きの遷移は、先頭へ戻す（hash の位置へは移った先が動かす）", () => {
    const { scrollTo } = stubBrowser("/A");
    navigate("/B#X");
    expect(scrollTo).toHaveBeenCalledOnce();
  });

  it("hash だけが変わる遷移では戻さない", () => {
    const { scrollTo, dispatchEvent } = stubBrowser("/A?x=1#a");
    navigate("/A?x=1#b");
    expect(scrollTo).not.toHaveBeenCalled();
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });

  it("同じ URL への遷移では戻さない", () => {
    const { scrollTo } = stubBrowser("/A");
    navigate("/A");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("置き換えでは、パスが変わっても戻さず、履歴を積まない", () => {
    const { scrollTo, dispatchEvent } = stubBrowser(`/p/${ID}`);
    navigate("/%E9%A1%8C", { replace: true });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });
});
