import {
  createPageEmbedCache,
  type PageEmbedCache,
  type PageEmbedResolver,
  type WikiLinkResolver,
} from "@personal-wiki/editor";
import {
  type ApiResult,
  type Fetch,
  findPageByTitle,
  type Page,
  type ResolvedPage,
  resolvePages,
} from "./pages-api";
import { createTitleResolver, type TitleLookup } from "./title-resolver";

/** BodyEditor が装飾のために読む部分。 */
export interface WikiLinkSources {
  resolveWikiLink: WikiLinkResolver;
  resolvePageEmbed: PageEmbedResolver;
  /** 印や embed の内容が変わったときに呼ぶ listener を登録する。戻り値で解除する。 */
  subscribe(listener: () => void): () => void;
}

export interface WikiLinks extends WikiLinkSources {
  /** クリックの遷移先を title から引く。 */
  lookup(target: string, signal?: AbortSignal): Promise<TitleLookup>;
  /** 保存や画面への復帰など、link 先の状態が変わりうるときに呼ぶ。 */
  refresh(): void;
  /** 進行中の取得を止める。その後に使ってもよい。 */
  dispose(): void;
}

export interface WikiLinksOptions {
  /** 埋め込み元の page。自分自身の embed は展開しない。 */
  pageId: string;
  resolvePages?: (titles: string[], fetchFn: Fetch) => Promise<ApiResult<(ResolvedPage | null)[]>>;
  findPageByTitle?: (title: string, fetchFn: Fetch) => Promise<ApiResult<Page>>;
}

const withSignal =
  (signal: AbortSignal): Fetch =>
  (input, init) =>
    fetch(input, { ...init, signal });

/**
 * 本文の wikilink に必要な非同期の部品（存在の印、ページ embed の本文、クリックの遷移先）を、
 * 1 つの page の編集の間だけまとめて持つ。
 * 匿名の閲覧画面も同じ部品を使う。draft は API が null（存在しない）で返すので、client に分岐はない。
 */
export function createWikiLinks(options: WikiLinksOptions): WikiLinks {
  const resolve = options.resolvePages ?? resolvePages;
  const find = options.findPageByTitle ?? findPageByTitle;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        reportError(error);
      }
    }
  };

  const titles = createTitleResolver({
    fetchTitles: (list, signal) => resolve(list, withSignal(signal)),
    onChange: notify,
  });

  // 破棄後の再利用（StrictMode）のために、使うときに作る
  let embeds: PageEmbedCache | null = null;
  const embedCache = (): PageEmbedCache => {
    embeds ??= createPageEmbedCache({
      selfPageId: options.pageId,
      onChange: notify,
      load: async (title, signal) => {
        const res = await find(title, withSignal(signal));
        if (res.ok) return { id: res.value.id, title: res.value.title, text: res.value.body };
        // 無い・読めないは null。それ以外（通信、5xx、ログイン切れ）は reject して再試行させる
        if (res.reason === "not_found") return null;
        throw new Error(res.reason);
      },
    });
    return embeds;
  };

  return {
    resolveWikiLink: (target) => titles.isResolved(target),
    resolvePageEmbed: (target) => embedCache().resolve(target),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    lookup: (target, signal) => titles.lookup(target, signal),
    refresh() {
      titles.refresh();
      embeds?.refresh();
    },
    dispose() {
      titles.dispose();
      embeds?.dispose();
      embeds = null;
    },
  };
}
