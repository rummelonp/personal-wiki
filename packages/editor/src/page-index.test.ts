import { describe, expect, it } from "vitest";
import { createMemoryPageIndex, type PageIndex } from "./page-index";

/** title_key の正規化を模した test 用の fold。実際の規則は `@personal-wiki/domain/title` 側で検証する。 */
const fold = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

const pages = (...titles: string[]) => titles.map((title, i) => ({ id: `p${i}`, title }));
const titles = (index: PageIndex, query: string) => index.search(query).map((c) => c.title);

describe("createMemoryPageIndex", () => {
  it("ranks exact, then prefix, then substring, then fuzzy matches", () => {
    const index = createMemoryPageIndex(
      pages("c-o-d-e", "xcodex", "code review", "CodeMirror", "code", "unrelated"),
      { normalize: fold },
    );
    expect(titles(index, "code")).toEqual([
      "code",
      "CodeMirror",
      "code review",
      "xcodex",
      "c-o-d-e",
    ]);
  });

  it("matches Japanese titles by prefix and in order", () => {
    const index = createMemoryPageIndex(pages("京都", "東京タワー", "東京", "日本語入力"), {
      normalize: fold,
    });
    expect(titles(index, "東京")).toEqual(["東京", "東京タワー"]);
    expect(titles(index, "日入")).toEqual(["日本語入力"]);
  });

  it("normalizes width and case before comparing", () => {
    const index = createMemoryPageIndex(pages("ＣｏｄｅＭｉｒｒｏｒ"), { normalize: fold });
    expect(titles(index, "codemirror")).toEqual(["ＣｏｄｅＭｉｒｒｏｒ"]);
  });

  it("returns the first pages in their original order for an empty query", () => {
    const index = createMemoryPageIndex(pages("a", "b", "c"), { limit: 2, normalize: fold });
    expect(titles(index, "")).toEqual(["a", "b"]);
  });

  it("caps the number of candidates", () => {
    const many = pages(...Array.from({ length: 50 }, (_, i) => `page ${i}`));
    expect(createMemoryPageIndex(many, { normalize: fold }).search("page")).toHaveLength(20);
    expect(createMemoryPageIndex(many, { limit: 5, normalize: fold }).search("page")).toHaveLength(
      5,
    );
  });

  it("returns nothing when no title contains the query characters in order", () => {
    expect(
      titles(createMemoryPageIndex(pages("東京", "code"), { normalize: fold }), "京東"),
    ).toEqual([]);
  });

  describe("similar-title fallback", () => {
    it("surfaces a page differing only by wave dash vs tilde, which fuzzy match misses", () => {
      const index = createMemoryPageIndex(pages("Vol.1〜2", "unrelated"), { normalize: fold });
      // page title は波ダッシュ（U+301C）。query 側の全角チルダ、半角チルダは fold（NFKC）を
      // 通しても波ダッシュへは統合されないため、通常の fuzzy match（部分列走査）は候補を返さない。
      expect(titles(index, "Vol.1～2")).toEqual(["Vol.1〜2"]);
      expect(titles(index, "Vol.1~2")).toEqual(["Vol.1〜2"]);
    });

    it("ranks an exact match above a wave-dash near match for the same query", () => {
      const index = createMemoryPageIndex(pages("Vol.1〜2", "Vol.1~2"), { normalize: fold });
      expect(titles(index, "Vol.1~2")).toEqual(["Vol.1~2", "Vol.1〜2"]);
    });

    it("surfaces a page one edit away when nothing else matches", () => {
      const index = createMemoryPageIndex(pages("wikipadia", "unrelated"), { normalize: fold });
      expect(titles(index, "wikipedia")).toEqual(["wikipadia"]);
    });

    it("does not surface similar pages that already match normally", () => {
      // "wikipedia" は substring 一致で見つかるので、similar 側には出ない（重複しない）。
      const index = createMemoryPageIndex(pages("my wikipedia notes"), { normalize: fold });
      expect(titles(index, "wikipedia")).toEqual(["my wikipedia notes"]);
    });

    it("caps the number of similar-only candidates", () => {
      const many = pages(...Array.from({ length: 10 }, (_, i) => `xxxxxxxxx${i}`));
      const index = createMemoryPageIndex(many, { normalize: fold });
      // どれも "yyyyyyyyy0" から 1 文字違いではなく通常一致も無いので similar 側に落ちる候補が多いが、
      // 上限 3 件までしか返さない。
      expect(index.search("xxxxxxxxxQ").length).toBeLessThanOrEqual(3);
    });

    it("ignores very short queries to avoid noisy matches", () => {
      const index = createMemoryPageIndex(pages("a"), { normalize: fold });
      expect(titles(index, "b")).toEqual([]);
    });
  });
});
