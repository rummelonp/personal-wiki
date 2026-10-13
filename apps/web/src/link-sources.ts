import { foldTitle } from "@personal-wiki/domain/title";
import {
  createMemoryPageIndex,
  type LinkTargetSource,
  type PageCandidate,
  type PageIndex,
} from "@personal-wiki/editor";
import { extractLinkTargets, type LinkTargets } from "@personal-wiki/markdown";
import type { ApiResult, Page, PageList, PageSummary } from "./pages-api";

export interface TitleIndex extends PageIndex {
  /**
   * 一覧を取り直す。reject しない。途中で失敗したら取れた分までを候補にし、1 回目で失敗したら
   * 前の候補を残す。
   */
  refresh(): Promise<void>;
}

export type ListTitles = (cursor: string | null) => Promise<ApiResult<PageList<PageSummary>>>;

/**
 * 候補に読む一覧の回数の上限。ページを開くたびに取り直すので、`listPageTitles` の 500 件ずつで
 * 最近の 2,000 件までに抑え、それより古いページを候補から落とすことを受け入れる。
 */
export const TITLE_INDEX_MAX_REQUESTS = 4;

/**
 * `[[` の title の候補。エディタは作ったときに渡された PageIndex を使い続けるので、
 * 取り直した一覧はこのオブジェクトの中で差し替える。
 */
export function createTitleIndex(list: ListTitles): TitleIndex {
  const build = (pages: readonly PageCandidate[]) =>
    createMemoryPageIndex(pages, { normalize: foldTitle });
  let current = build([]);
  // 遅れて終わった古い取り直しで、新しい候補を上書きしない
  let generation = 0;

  return {
    search: (query) => current.search(query),
    async refresh() {
      const mine = ++generation;
      const pages: PageCandidate[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < TITLE_INDEX_MAX_REQUESTS; i++) {
        let res: ApiResult<PageList<PageSummary>>;
        try {
          res = await list(cursor);
        } catch {
          return;
        }
        if (mine !== generation || !res.ok) return;
        pages.push(...res.value.pages.map(({ id, title }) => ({ id, title })));
        current = build(pages);
        cursor = res.value.nextCursor;
        if (cursor === null) return;
      }
    },
  };
}

export type FindPageByTitle = (title: string, signal: AbortSignal) => Promise<ApiResult<Page>>;

/**
 * `[[Title#` と `[[Title#^` の候補。リンク先の本文を取りに行き、見出しと block id を取り出す。
 * 取れなかったとき（ページが無い、通信の失敗、中断）は候補なしにして、エディタの入力は止めない。
 * 取れた分は作った LinkTargetSource が生きている間（ページを開いている間）覚えておく。
 */
export function createLinkTargetSource(find: FindPageByTitle): LinkTargetSource {
  const cache = new Map<string, LinkTargets>();
  return {
    async load(title, signal) {
      const key = foldTitle(title);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      try {
        const res = await find(title, signal);
        if (!res.ok) return null;
        const targets = extractLinkTargets(res.value.body);
        cache.set(key, targets);
        return targets;
      } catch {
        return null;
      }
    },
  };
}
