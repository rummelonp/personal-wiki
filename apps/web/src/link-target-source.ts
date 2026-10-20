import { foldTitle } from "@personal-wiki/domain/title";
import type { LinkTargetSource } from "@personal-wiki/editor";
import { extractLinkTargets, type LinkTargets } from "@personal-wiki/markdown";
import type { ApiResult, Page } from "./pages-api";

export type FindPageByTitle = (title: string, signal: AbortSignal) => Promise<ApiResult<Page>>;

/**
 * `[[Title#` と `[[Title#^` の候補。リンク先の本文を取りに行き、見出しと block id を取り出す。
 * 取れなかったとき（ページが無い、通信の失敗、中断）は候補なしにして、エディタの入力は止めない。
 * 取れた分は作った LinkTargetSource が生きている間（ページを開いている間）キャッシュしておく。
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
