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
    pageId: () => SELF,
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

describe("embedPageId", () => {
  it("取得前は null、取得すると埋め込み先の id を返す", async () => {
    const { links } = setup([pageOf("B", "別", "本文")]);
    expect(links.embedPageId("別")).toBeNull();
    links.resolvePageEmbed("別");
    await vi.advanceTimersByTimeAsync(0);
    expect(links.embedPageId("別")).toBe("B");
  });

  it("無いページと読めないページは null のまま（匿名の draft の id を持たない）", async () => {
    const { links } = setup([]);
    links.resolvePageEmbed("無い");
    await vi.advanceTimersByTimeAsync(0);
    expect(links.resolvePageEmbed("無い")).toEqual({ kind: "unresolved" });
    expect(links.embedPageId("無い")).toBeNull();
  });

  it("取り直して読めなくなったら、前の id を捨てる", async () => {
    const pages = [pageOf("B", "別", "本文")];
    const { links } = setup(pages);
    links.resolvePageEmbed("別");
    await vi.advanceTimersByTimeAsync(0);
    expect(links.embedPageId("別")).toBe("B");

    pages.length = 0;
    links.refresh();
    links.resolvePageEmbed("別");
    await vi.advanceTimersByTimeAsync(0);
    expect(links.embedPageId("別")).toBeNull();
  });

  it("dispose で捨てる", async () => {
    const { links } = setup([pageOf("B", "別", "本文")]);
    links.resolvePageEmbed("別");
    await vi.advanceTimersByTimeAsync(0);
    links.dispose();
    expect(links.embedPageId("別")).toBeNull();
  });
});

describe("refreshTitles", () => {
  it("title の確認だけを取り直し、embed の本文は取り直さない", async () => {
    const { links, find, resolve } = setup([pageOf("B", "別", "本文")]);
    links.resolvePageEmbed("別");
    links.resolveWikiLink("別");
    await vi.advanceTimersByTimeAsync(TITLE_RESOLVE_DEBOUNCE_MS);
    expect(find).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);

    links.refreshTitles();
    links.resolveWikiLink("別");
    await vi.advanceTimersByTimeAsync(TITLE_RESOLVE_DEBOUNCE_MS);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(find).toHaveBeenCalledTimes(1);

    links.refresh();
    links.resolvePageEmbed("別");
    await vi.advanceTimersByTimeAsync(TITLE_RESOLVE_DEBOUNCE_MS);
    expect(find).toHaveBeenCalledTimes(2);
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

describe("hrefFor", () => {
  const plain = { target: "有る", heading: null, blockId: null };

  async function resolved() {
    const { links } = setup([{ ...pageOf("B", "有る", ""), visibility: "public" }]);
    links.resolveWikiLink("有る");
    await vi.advanceTimersByTimeAsync(TITLE_RESOLVE_DEBOUNCE_MS);
    return links;
  }

  it("解決先を取得するまでは null", () => {
    const { links } = setup([]);
    expect(links.hrefFor(plain)).toBeNull();
  });

  it("見出しと block の場所を fragment で付ける", async () => {
    const links = await resolved();
    const path = `/${encodeURIComponent("有る")}`;
    expect(links.hrefFor(plain)).toBe(path);
    expect(links.hrefFor({ ...plain, heading: "見出し A" })).toBe(
      `${path}#${encodeURIComponent("見出し A")}`,
    );
    expect(links.hrefFor({ ...plain, heading: "^abc" })).toBe(`${path}#%5Eabc`);
    expect(links.hrefFor({ ...plain, blockId: "abc" })).toBe(`${path}#%5Eabc`);
    expect(links.hrefFor({ ...plain, heading: "B#C" })).toBe(`${path}#B%23C`);
  });

  it("target が空の link は、ページを問わず fragment だけの URL にする", () => {
    const { links, resolve } = setup([]);
    expect(links.hrefFor({ target: "", heading: "見出し", blockId: null })).toBe(
      `#${encodeURIComponent("見出し")}`,
    );
    expect(links.hrefFor({ target: "", heading: "^abc", blockId: null })).toBe("#%5Eabc");
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("isDraft", () => {
  it("取得済みの解決先が draft のときだけ true にし、自分では問い合わせない", async () => {
    const { links, resolve } = setup([
      pageOf("D", "下書き", ""),
      { ...pageOf("P", "公開", ""), visibility: "public" },
    ]);
    expect(links.isDraft("下書き")).toBe(false);
    await vi.advanceTimersByTimeAsync(TITLE_RESOLVE_DEBOUNCE_MS);
    expect(resolve).not.toHaveBeenCalled();

    for (const target of ["下書き", "公開", "無い"]) links.resolveWikiLink(target);
    await vi.advanceTimersByTimeAsync(TITLE_RESOLVE_DEBOUNCE_MS);
    expect(links.isDraft("下書き")).toBe(true);
    expect(links.isDraft("公開")).toBe(false);
    expect(links.isDraft("無い")).toBe(false);
  });

  it("自分への link は、解決先が draft でも false にする", async () => {
    const { links } = setup([pageOf(SELF, "自分", "")]);
    links.resolveWikiLink("自分");
    await vi.advanceTimersByTimeAsync(TITLE_RESOLVE_DEBOUNCE_MS);
    expect(links.hrefFor({ target: "自分", heading: null, blockId: null })).toBe(`/p/${SELF}`);
    expect(links.isDraft("自分")).toBe(false);
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
