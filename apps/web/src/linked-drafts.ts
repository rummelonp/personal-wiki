import { extractDerived } from "@personal-wiki/markdown";
import {
  type ApiResult,
  type Fetch,
  type ResolvedPage,
  resolvePages,
  splitResolveBatches,
} from "./pages-api";

export interface LinkedDraft {
  id: string;
  title: string;
}

export interface FindLinkedDraftsOptions {
  /** 公開しようとしているページ。自分への link は、公開すれば draft でなくなるので数えない */
  selfId: string;
  fetchFn?: Fetch;
  resolve?: (titles: string[], fetchFn: Fetch) => Promise<ApiResult<(ResolvedPage | null)[]>>;
}

/**
 * 本文の wikilink と page embed のうち、解決先が draft のものを、本文に現れた順に返す。
 * 公開すると、これらは匿名には存在しないページへの link と同じ文字列に見える。
 *
 * 編集画面の印は表示中の link しか問い合わせていないので、ここでは本文の全部の link を問い合わせ直す。
 * 1 つでも失敗したら失敗を返す（一部だけの一覧を「これで全部」と見せない）。
 */
export async function findLinkedDrafts(
  body: string,
  options: FindLinkedDraftsOptions,
): Promise<ApiResult<LinkedDraft[]>> {
  const resolve = options.resolve ?? resolvePages;
  const fetchFn = options.fetchFn ?? fetch;
  const titles = extractDerived(body).links.map((link) => link.targetTitle);
  const results = await Promise.all(
    splitResolveBatches(titles).map(async (indices) => ({
      indices,
      result: await resolve(
        indices.map((i) => titles[i] as string),
        fetchFn,
      ),
    })),
  );
  const pages: (ResolvedPage | null)[] = titles.map(() => null);
  for (const { indices, result } of results) {
    if (!result.ok) return result;
    indices.forEach((titleIndex, i) => {
      pages[titleIndex] = result.value[i] ?? null;
    });
  }
  const seen = new Set<string>();
  const drafts: LinkedDraft[] = [];
  for (const page of pages) {
    if (page === null || page.visibility !== "draft" || page.id === options.selfId) continue;
    if (seen.has(page.id)) continue;
    seen.add(page.id);
    drafts.push({ id: page.id, title: page.title });
  }
  return { ok: true, value: drafts };
}
