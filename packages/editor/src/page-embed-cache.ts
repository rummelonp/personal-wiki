import type { PageEmbedContent, PageEmbedResolver } from "./embed";

/** 埋め込み先の page。`PageEmbedCacheOptions.load` が返す。 */
export interface PageEmbedPage {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

export interface PageEmbedCacheOptions {
  /**
   * title（`![[Title]]` の Title）の page を取得する。page が無い・読めない（API の 404）は null を
   * 返す。それ以外の失敗（ネットワーク、5xx）は reject する。reject は未解決にせず、再試行する。
   */
  readonly load: (title: string, signal: AbortSignal) => Promise<PageEmbedPage | null>;
  /** 埋め込み元の page の id。これに解決した embed は展開しない */
  readonly selfPageId: string;
  /**
   * 表示内容が変わった、または取り直してほしい embed がある。`invalidateDecorations` で組み直させる。
   * `resolve` の中からは呼ばない（decoration の構築中に dispatch させない）ので、そのまま
   * `invalidateDecorations` を呼んでよい。throw しても cache の状態は崩れない（`reportError` に渡す）。
   */
  readonly onChange: () => void;
}

export interface PageEmbedCache {
  readonly resolve: PageEmbedResolver;
  /**
   * 取得済みの内容をすべて古いとみなし、再試行の待ちも解く。表示中の embed は `onChange` による
   * 組み直しで取り直され、画面の外のものは次に表示されたときに取り直す。取り直す間は古い内容を出し
   * 続ける。
   */
  refresh(): void;
  /** 取得中のものを中断し、以後 `onChange` を呼ばない */
  dispose(): void;
}

const LOADING: PageEmbedContent = { kind: "loading" };
const UNRESOLVED: PageEmbedContent = { kind: "unresolved" };
const SELF: PageEmbedContent = { kind: "self" };

/** 失敗した取得を再試行するまでの間隔。失敗が続くたびに倍にし、上限で止める（ms） */
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;
/**
 * 再試行の時刻がこの幅に収まる entry は、まとめて再試行する（ms）。オフラインになると見えている
 * embed がほぼ同時に失敗するので、1 つずつ再試行すると decoration を embed の数だけ組み直す。
 */
const RETRY_COALESCE_MS = 1_000;

interface Entry {
  content: PageEmbedContent;
  /** 最後に取得を始めた時点の cache の世代。cache の世代より小さければ取り直す */
  generation: number;
  controller: AbortController | null;
  /** 続けて失敗した回数。成功（404 を含む）で 0 に戻す。refresh では戻さない */
  failures: number;
  /** 再試行を待っている間だけある（`Date.now()` の時刻）。その間は `resolve` から取得を始めない */
  retryAt: number | null;
}

function sameContent(a: PageEmbedContent, b: PageEmbedContent): boolean {
  if (a.kind === "resolved" && b.kind === "resolved") {
    return a.title === b.title && a.text === b.text;
  }
  return a.kind === b.kind;
}

/**
 * `PageEmbedResolver` の実装。decoration の構築は同期なので、未取得の target には `loading` を返して
 * 裏で取得し、届いたら `onChange` で組み直させる。
 *
 * 1 つの target の取得は同時に 1 本までにする。`refresh` は取得中のものを中断しない。中断すると、
 * 更新の間隔が API の往復より短いときに取得が一度も終わらない。代わりに世代を進め、
 * 取得中の応答はそのまま使ったうえで、それが古い世代なら終わった後で取り直させる。応答は出した順に
 * 届くので、古い応答が新しい内容を上書きすることはない。
 *
 * 取り直して内容が変わらなければ前のオブジェクトを返し続け、`onChange` も呼ばない
 * （widget が DOM を作り直さない）。
 *
 * 取得の失敗（404 以外）は未解決にしない。未解決は「無いか読めない」だけを意味する
 * ので、一時的な失敗を混ぜると reload するまで無い page に見える。
 * 失敗したら前の内容（一度も取得できていなければ取得中）を残し、間隔を空けて再試行する。
 * `refresh`（本文の更新が届いた）はサーバー側が動いている目安になる（API の応答の保証ではない）
 * ので、再試行の待ちを解いてすぐ取り直す。
 * 失敗の回数は残すので、また失敗すれば続きの間隔から待つ。
 */
export function createPageEmbedCache(options: PageEmbedCacheOptions): PageEmbedCache {
  const entries = new Map<string, Entry>();
  let generation = 0;
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  // onChange の例外で呼び出し元（取得の後続、timer、refresh）を止めず、unhandled rejection にもしない
  const notify = (): void => {
    if (disposed) return;
    try {
      options.onChange();
    } catch (error) {
      reportError(error);
    }
  };

  const scheduleRetry = (): void => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    let next = Number.POSITIVE_INFINITY;
    for (const entry of entries.values()) {
      if (entry.retryAt !== null && entry.retryAt < next) next = entry.retryAt;
    }
    if (next === Number.POSITIVE_INFINITY) return;
    retryTimer = setTimeout(
      () => {
        retryTimer = null;
        const until = Date.now() + RETRY_COALESCE_MS;
        let released = false;
        for (const entry of entries.values()) {
          if (entry.retryAt !== null && entry.retryAt <= until) {
            entry.retryAt = null;
            entry.generation = -1;
            released = true;
          }
        }
        scheduleRetry();
        if (released) notify();
      },
      Math.max(0, next - Date.now()),
    );
  };

  const succeed = (entry: Entry, next: PageEmbedContent): void => {
    entry.failures = 0;
    const changed = !sameContent(entry.content, next);
    if (changed) entry.content = next;
    // 取得中に refresh された場合も、見えている embed に組み直しで取り直させる
    if (changed || entry.generation < generation) notify();
  };

  const fail = (entry: Entry): void => {
    entry.failures += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (entry.failures - 1), RETRY_MAX_MS);
    entry.retryAt = Date.now() + delay;
    scheduleRetry();
  };

  const load = async (title: string, entry: Entry): Promise<void> => {
    const controller = new AbortController();
    entry.controller = controller;
    entry.generation = generation;
    let page: PageEmbedPage | null;
    try {
      // load が同期で throw しても、reject と同じく失敗として扱う
      page = await options.load(title, controller.signal);
    } catch {
      entry.controller = null;
      if (!disposed) fail(entry);
      return;
    }
    entry.controller = null;
    if (disposed) return;
    if (page === null) succeed(entry, UNRESOLVED);
    else if (page.id === options.selfPageId) succeed(entry, SELF);
    else succeed(entry, { kind: "resolved", title: page.title, text: page.text });
  };

  return {
    resolve: (title) => {
      if (disposed) return LOADING;
      let entry = entries.get(title);
      if (entry === undefined) {
        entry = { content: LOADING, generation: -1, controller: null, failures: 0, retryAt: null };
        entries.set(title, entry);
      }
      if (entry.generation < generation && entry.controller === null && entry.retryAt === null) {
        // load の本体は最初の await まで同期で走るので、取得は resolve の中で始まる
        load(title, entry).catch(reportError);
      }
      return entry.content;
    },
    refresh: () => {
      if (disposed || entries.size === 0) return;
      generation += 1;
      for (const entry of entries.values()) entry.retryAt = null;
      scheduleRetry();
      notify();
    },
    dispose: () => {
      disposed = true;
      for (const entry of entries.values()) entry.controller?.abort();
      entries.clear();
      scheduleRetry();
    },
  };
}
