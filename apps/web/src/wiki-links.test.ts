import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult, Page } from "./pages-api";
import { TITLE_RESOLVE_DEBOUNCE_MS } from "./title-resolver";
import { createWikiLinks, type WikiLinksOptions } from "./wiki-links";

const SELF = "SELF";

const pageOf = (id: string, title: string, body: string): Page => ({
  id,
  title,
  body,
  visibility: "draft",
  version: 1,
  createdAt: 0,
  updatedAt: 0,
});

function setup(
  pages: Page[],
  overrides: Partial<Pick<WikiLinksOptions, "findPageByTitle" | "resolvePages">> = {},
) {
  const find = vi.fn<NonNullable<WikiLinksOptions["findPageByTitle"]>>(
    async (title): Promise<ApiResult<Page>> => {
      const found = pages.find((p) => p.title === title);
      return found ? { ok: true, value: found } : { ok: false, reason: "not_found" };
    },
  );
  const resolve = vi.fn<NonNullable<WikiLinksOptions["resolvePages"]>>(async (titles) => ({
    ok: true,
    value: titles.map((title) => {
      const found = pages.find((p) => p.title === title);
      return found ? { id: found.id, title: found.title, visibility: found.visibility } : null;
    }),
  }));
  const links = createWikiLinks({
    pageId: SELF,
    findPageByTitle: find,
    resolvePages: resolve,
    ...overrides,
  });
  const listener = vi.fn();
  links.subscribe(listener);
  return { links, find, resolve, listener };
}

// node には reportError が無い（ブラウザでは window.reportError）
const reportError = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("reportError", reportError);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  reportError.mockClear();
});

describe("ページ embed", () => {
  it("取得中は loading を返し、本文が届いたら resolved にして組み直させる", async () => {
    const { links, listener } = setup([pageOf("B", "別", "別の本文")]);
    expect(links.resolvePageEmbed("別")).toEqual({ kind: "loading" });
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(links.resolvePageEmbed("別")).toEqual({
      kind: "resolved",
      title: "別",
      text: "別の本文",
    });
  });

  it("無いページは unresolved、自分自身は self にする", async () => {
    const { links } = setup([pageOf(SELF, "自分", "本文")]);
    links.resolvePageEmbed("無い");
    links.resolvePageEmbed("自分");
    await vi.advanceTimersByTimeAsync(0);
    expect(links.resolvePageEmbed("無い")).toEqual({ kind: "unresolved" });
    expect(links.resolvePageEmbed("自分")).toEqual({ kind: "self" });
  });

  it("通信の失敗は unresolved にせず、loading のまま再試行する", async () => {
    let failing = true;
    const { links } = setup([], {
      findPageByTitle: async (title) =>
        failing
          ? { ok: false, reason: "error", message: "500" }
          : { ok: true, value: pageOf("B", title, "本文") },
    });
    links.resolvePageEmbed("別");
    await vi.advanceTimersByTimeAsync(0);
    expect(links.resolvePageEmbed("別")).toEqual({ kind: "loading" });

    failing = false;
    links.refresh();
    await vi.advanceTimersByTimeAsync(0);
    links.resolvePageEmbed("別");
    await vi.advanceTimersByTimeAsync(0);
    expect(links.resolvePageEmbed("別")).toMatchObject({ kind: "resolved" });
  });

  it("refresh で取り直し、本文が変わっていたら組み直させる", async () => {
    const pages = [pageOf("B", "別", "古い")];
    const { links, listener } = setup(pages);
    links.resolvePageEmbed("別");
    await vi.advanceTimersByTimeAsync(0);
    listener.mockClear();

    pages[0] = pageOf("B", "別", "新しい");
    links.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
    links.resolvePageEmbed("別");
    await vi.advanceTimersByTimeAsync(0);
    expect(links.resolvePageEmbed("別")).toMatchObject({ text: "新しい" });
  });
});

describe("存在の印と遷移", () => {
  it("存在しないと分かった link を、組み直しの通知とともに未解決にする", async () => {
    const { links, listener } = setup([pageOf("B", "有る", "")]);
    expect(links.resolveWikiLink("有る")).toBe(true);
    expect(links.resolveWikiLink("無い")).toBe(true);
    await vi.advanceTimersByTimeAsync(TITLE_RESOLVE_DEBOUNCE_MS);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(links.resolveWikiLink("有る")).toBe(true);
    expect(links.resolveWikiLink("無い")).toBe(false);
  });

  it("解決の API が失敗しても、未解決の印を付けない", async () => {
    const { links, listener } = setup([], {
      resolvePages: async () => ({ ok: false, reason: "not_found" }),
    });
    links.resolveWikiLink("無い");
    await vi.advanceTimersByTimeAsync(TITLE_RESOLVE_DEBOUNCE_MS);
    expect(links.resolveWikiLink("無い")).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("クリックの遷移先を title から引く", async () => {
    const { links } = setup([pageOf("B", "有る", "")]);
    expect(await links.lookup("有る")).toMatchObject({ kind: "found", page: { id: "B" } });
    expect(await links.lookup("無い")).toEqual({ kind: "missing" });
  });
});

describe("subscribe と dispose", () => {
  it("解除した listener は呼ばない", async () => {
    const { links, listener } = setup([]);
    const other = vi.fn();
    const unsubscribe = links.subscribe(other);
    unsubscribe();
    links.resolveWikiLink("無い");
    await vi.advanceTimersByTimeAsync(TITLE_RESOLVE_DEBOUNCE_MS);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it("listener が throw しても、ほかの listener を止めない", async () => {
    const { links, listener } = setup([]);
    links.subscribe(() => {
      throw new Error("boom");
    });
    links.resolveWikiLink("無い");
    await vi.advanceTimersByTimeAsync(TITLE_RESOLVE_DEBOUNCE_MS);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("dispose の後も使える（StrictMode が effect を付け直す）", async () => {
    const { links, listener } = setup([pageOf("B", "別", "本文")]);
    links.resolvePageEmbed("別");
    links.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).not.toHaveBeenCalled();

    expect(links.resolvePageEmbed("別")).toEqual({ kind: "loading" });
    await vi.advanceTimersByTimeAsync(0);
    expect(links.resolvePageEmbed("別")).toMatchObject({ kind: "resolved" });
  });
});
