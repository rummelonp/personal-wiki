import { foldTitle } from "@personal-wiki/domain/title";
// quick switcher から入口の chunk に入るので、CodeMirror を引き込む editor の入口を通さない
import {
  createMemoryPageIndex,
  type PageCandidate,
  type PageIndex,
} from "@personal-wiki/editor/page-index";
import type { ApiResult, PageList, PageSummary } from "./pages-api";

export interface TitleIndex extends PageIndex {
  /**
   * 一覧を取り直す。reject しない。途中で失敗したら取れた分までを候補にし、1 回目で失敗したら
   * 前の候補を残す。
   */
  refresh(): Promise<void>;
  /**
   * 候補が空のまま取れていない（取得が済んでいないか、失敗している）ときに、取り直しを始めて終わりを待つ。
   * 取得中ならその終わりを待ち、重ねて取らない。待つ間に別の取得が始まれば、それも待つ。失敗の直後は取り直さず、すぐ解決する。
   * 候補があるか、取得に成功していれば何もしない。reject しない。
   */
  retry(): Promise<void>;
  /** 1 回目の refresh が済んだか。一度 true になったら戻らない。 */
  settled(): boolean;
  /**
   * 最新の refresh が失敗し、かつ候補が 1 件も無いか。成功した refresh で false に戻る。
   * true の間の「候補なし」は、無いと分かったのではなく確かめられていない。
   * 前に取れた候補や、途中まで取れた候補があれば、失敗しても false のまま。
   */
  failed(): boolean;
  /** 取り直しの最中か。失敗の後の取り直しの間は、失敗の案内でなく読み込み中を見せるために使う。 */
  loading(): boolean;
}

export type ListTitles = (cursor: string | null) => Promise<ApiResult<PageList<PageSummary>>>;

/**
 * 候補に読む一覧の回数の上限。ページを開くたびに取り直すので、`listPageTitles` の 500 件ずつで
 * 最近の 2,000 件までに抑え、それより古いページを候補から落とすことを受け入れる。
 */
export const TITLE_INDEX_MAX_REQUESTS = 4;

/**
 * 匿名の閲覧者の候補に読む一覧の回数の上限。匿名は quick switcher を開くたびに取り直し、
 * 1 回のリクエストで D1 を 500 行あまり読む（最近の更新の 1 回は 100 行ほど）。誰でも開ける入口で
 * 読み取りの無料枠を減らしにくくするため、最近の公開 500 件より古いページを候補から落とす。
 */
export const ANONYMOUS_TITLE_INDEX_MAX_REQUESTS = 1;

/**
 * `retry` が、前の失敗から取り直すまでに空ける間隔。補完は打鍵のたびに呼ぶので、API が落ちている間に
 * 打つ速さでリクエストを送り直さない。
 */
export const TITLE_INDEX_RETRY_COOLDOWN_MS = 5_000;

/**
 * `[[` の title の候補。エディタは作ったときに渡された PageIndex を使い続けるので、
 * 取り直した一覧はこのオブジェクトの中で差し替える。
 */
export function createTitleIndex(
  list: ListTitles,
  {
    maxRequests = TITLE_INDEX_MAX_REQUESTS,
    retryCooldownMs = TITLE_INDEX_RETRY_COOLDOWN_MS,
    now = Date.now,
  }: { maxRequests?: number; retryCooldownMs?: number; now?: () => number } = {},
): TitleIndex {
  const build = (pages: readonly PageCandidate[]) =>
    createMemoryPageIndex(pages, { normalize: foldTitle });
  let current = build([]);
  // 遅れて終わった古い取り直しで、新しい候補を上書きしない
  let generation = 0;
  let settled = false;
  let lastFailed = false;
  let lastFailedAt = Number.NEGATIVE_INFINITY;
  let count = 0;
  // 最後に始めた refresh。終わるまでは取得中
  let running: Promise<void> | null = null;

  async function load(mine: number): Promise<void> {
    let failed = false;
    try {
      const pages: PageCandidate[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < maxRequests; i++) {
        let res: ApiResult<PageList<PageSummary>>;
        try {
          res = await list(cursor);
        } catch {
          failed = true;
          return;
        }
        if (mine !== generation) return;
        if (!res.ok) {
          failed = true;
          return;
        }
        pages.push(...res.value.pages.map(({ id, title }) => ({ id, title })));
        current = build(pages);
        count = pages.length;
        cursor = res.value.nextCursor;
        if (cursor === null) return;
      }
    } finally {
      // 後から始まった refresh に追い越されたものは済ませない。その refresh が最後に済ませる
      if (mine === generation) {
        settled = true;
        lastFailed = failed;
        if (failed) lastFailedAt = now();
      }
    }
  }

  const index: TitleIndex = {
    search: (query) => current.search(query),
    settled: () => settled,
    failed: () => lastFailed && count === 0,
    loading: () => running !== null,
    refresh() {
      const promise = load(++generation);
      running = promise;
      // load の中で解除すると、同期に終わったとき（list が同期に投げる）に代入より先に走ってしまう
      void promise.then(() => {
        if (running === promise) running = null;
      });
      return promise;
    },
    async retry() {
      if (settled && !index.failed()) return;
      if (running === null) {
        if (now() - lastFailedAt < retryCooldownMs) return;
        void index.refresh();
      }
      // 待っている間にホストが refresh を重ねることがある。最後の取得まで待たないと、
      // 古い取得の終わりで探し直した結果が、まだ空のまま返る
      while (running !== null) await running;
    },
  };
  return index;
}
