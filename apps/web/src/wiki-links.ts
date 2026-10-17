import { canonicalPagePath } from "@personal-wiki/domain/page-path";
import {
  createPageEmbedCache,
  type PageEmbedCache,
  type PageEmbedResolver,
  type WikiLinkClick,
  type WikiLinkResolver,
} from "@personal-wiki/editor";
import { hashOfLink } from "./page-fragment";
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
  /**
   * wikilink の `<a href>` にする URL。解決先を取得済みのときだけ返し、未確認と存在しない link は null
   * （href の無い装飾）。匿名には draft も存在しない link と同じく null になる。
   * 見出しや block を指す link には、その場所を fragment で付ける。target が空の link
   * （同じ page の見出しと block）は fragment だけの URL になる。
   */
  hrefFor(link: Pick<WikiLinkClick, "target" | "heading" | "blockId">): string | null;
  /**
   * 解決先を取得済みで、それが自分以外の draft か。問い合わせは始めない（`resolveWikiLink` が始める）。
   * 匿名には draft が存在しない link として返るので、常に false になる。
   */
  isDraft(target: string): boolean;
  /** 印や embed の内容が変わったときに呼ぶ listener を登録する。戻り値で解除する。 */
  subscribe(listener: () => void): () => void;
}

export interface WikiLinks extends WikiLinkSources {
  /**
   * 展開した embed の埋め込み先の id。`target` は `![[target]]` に書かれたままの title。
   * 取得前と、無いページ、読めないページは null。入れ子の embed の添付の URL は埋め込み先の id で引く。
   * 匿名には draft の embed が展開されない（API が not_found を返す）ので、draft の id はここに入らない。
   */
  embedPageId(target: string): string | null;
  /** クリックの遷移先を title から引く。 */
  lookup(target: string, signal?: AbortSignal): Promise<TitleLookup>;
  /** 画面への復帰など、ほかの page が変わりうるときに呼ぶ。存在の印も embed の本文も取り直す。 */
  refresh(): void;
  /** 自分の title の変更など、title の解決だけが変わりうるときに呼ぶ。embed の本文は取り直さない。 */
  refreshTitles(): void;
  /** 進行中の取得を止める。その後に使ってもよい。 */
  dispose(): void;
}

export interface WikiLinksOptions {
  /**
   * 埋め込み元の page の id。自分自身の embed は展開しない。新規作成の画面では作れた時点で
   * 変わるので、使うたびに読む（作る前は空文字列）。
   */
  pageId: () => string;
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

  const embedIds = new Map<string, string>();

  // 破棄後の再利用（StrictMode）のために、使うときに作る。自分の id が変わったら作り直す
  // （作る前に引いた自分の title の embed を、作った後も自分と見分けられるように）
  let embeds: PageEmbedCache | null = null;
  let embedsFor = "";
  const embedCache = (): PageEmbedCache => {
    const self = options.pageId();
    if (embeds !== null && embedsFor !== self) {
      embeds.dispose();
      embeds = null;
    }
    embedsFor = self;
    embeds ??= createPageEmbedCache({
      selfPageId: self,
      onChange: notify,
      load: async (title, signal) => {
        const res = await find(title, withSignal(signal));
        if (res.ok) {
          embedIds.set(title, res.value.id);
          return { id: res.value.id, title: res.value.title, text: res.value.body };
        }
        // 無いか読めないなら null。それ以外（通信、5xx、ログイン切れ）は reject して再試行させる
        if (res.reason === "not_found") {
          embedIds.delete(title);
          return null;
        }
        throw new Error(res.reason);
      },
    });
    return embeds;
  };

  return {
    resolveWikiLink: (target) => titles.isResolved(target),
    resolvePageEmbed: (target) => embedCache().resolve(target),
    embedPageId: (target) => embedIds.get(target) ?? null,
    hrefFor(link) {
      const hash = hashOfLink(link);
      if (link.target === "") return hash === "" ? null : hash;
      const page = titles.resolvedPage(link.target);
      return page === null ? null : `${canonicalPagePath(page)}${hash}`;
    },
    // 自分への link は除く。解決結果の公開範囲は公開した後の取り直しまで古いままで、その間に印が出る
    isDraft(target) {
      const page = titles.resolvedPage(target);
      return page?.visibility === "draft" && page.id !== options.pageId();
    },
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
    refreshTitles: () => titles.refresh(),
    dispose() {
      titles.dispose();
      embeds?.dispose();
      embeds = null;
      embedIds.clear();
    },
  };
}
