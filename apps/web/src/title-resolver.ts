import { foldTitle } from "@personal-wiki/domain/title";
import {
  type ApiResult,
  canResolveTitle,
  type ResolvedPage,
  splitResolveBatches,
} from "./pages-api";

export type FetchTitles = (
  titles: string[],
  signal: AbortSignal,
) => Promise<ApiResult<(ResolvedPage | null)[]>>;

export type TitleLookup =
  | { kind: "found"; page: ResolvedPage }
  | { kind: "missing" }
  | { kind: "error" };

export interface TitleResolverOptions {
  fetchTitles: FetchTitles;
  /**
   * 印が変わる、または取り直してほしい link がある。装飾を組み直させる。
   * `isResolved` の中からは呼ばない（decoration の構築中に dispatch させない）。
   */
  onChange: () => void;
  debounceMs?: number;
  maxWaitMs?: number;
  failureCooldownMs?: number;
  now?: () => number;
}

export interface TitleResolver {
  /**
   * `WikiLinkResolver` の実装。存在しないと確認できた title だけ false を返し、未確認、確認中、
   * 失敗は true（印を付けない）。確認していない title を見つけたら、裏でまとめて問い合わせる。
   */
  isResolved(target: string): boolean;
  /**
   * 取得済みの解決先。未確認、確認中、存在しないなら null。問い合わせは始めない（`isResolved` と
   * 同じ組み直しの中で呼ぶ前提）。解決先が変わったときも `onChange` を呼ぶ。
   */
  resolvedPage(target: string): ResolvedPage | null;
  /** クリックの遷移先を引く。取得済みで古くない結果があればそれを返し、無ければ 1 件だけ問い合わせる。 */
  lookup(target: string, signal?: AbortSignal): Promise<TitleLookup>;
  /**
   * 取得済みの結果をすべて古いとみなす。表示中の link は組み直しで取り直され、取り直すまでは
   * 古い印を出し続ける（印が一度消えてまた付くのを避ける）。画面の外の link は表示されたときに取り直す。
   */
  refresh(): void;
  /**
   * 進行中の問い合わせを中断し、待っている要求を捨てる。その後に使ってもよい（StrictMode は
   * effect を 1 度解除してから付け直す）。
   */
  dispose(): void;
}

/**
 * 連続した入力でも要求が出ていくよう、最後の追加から待つ時間と、最初の追加からの待ちの上限。
 * `[[` の中を 1 字ずつ打つと、そのたびに別の target を見つける。
 */
export const TITLE_RESOLVE_DEBOUNCE_MS = 250;
export const TITLE_RESOLVE_MAX_WAIT_MS = 1_000;
/** 失敗した target を次の組み直しで問い合わせ直すまでの間隔。編集のたびに 5xx を叩き直さない */
export const TITLE_RESOLVE_FAILURE_COOLDOWN_MS = 10_000;
/** 覚えておく target の数。超えたら古いものから忘れる（打ちかけの target が溜まる分） */
const MAX_ENTRIES = 1_000;

interface Entry {
  status: "unknown" | "found" | "missing";
  page: ResolvedPage | null;
  /** 結果を得たときの世代。resolver の世代より小さければ古い。-1 は未取得 */
  generation: number;
  inFlight: boolean;
  /** この時刻までは問い合わせ直さない。Infinity は問い合わせない */
  retryAt: number;
}

/**
 * wikilink の存在の印のための resolver。
 *
 * decoration の構築は同期なので、`isResolved` は未確認の target を true で返し、裏で
 * `GET /api/pages/resolve` へ問い合わせて、印が変わるときだけ `onChange` で組み直させる。
 * 結果は target の `foldTitle`（Worker の title_key と同じ規則）をキーにメモリに持つ。
 * target の切り出し（`#` や `^` の扱い）は editor が行い、ここでは受け取った文字列をそのまま使う。
 *
 * 失敗（404、5xx、通信の失敗、応答の形の違い）では結果を書き換えない。「存在しない」の印を
 * 付けるのは、存在しないという応答を受けたときだけにする。
 */
export function createTitleResolver(options: TitleResolverOptions): TitleResolver {
  const debounceMs = options.debounceMs ?? TITLE_RESOLVE_DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? TITLE_RESOLVE_MAX_WAIT_MS;
  const cooldownMs = options.failureCooldownMs ?? TITLE_RESOLVE_FAILURE_COOLDOWN_MS;
  const now = options.now ?? Date.now;

  const entries = new Map<string, Entry>();
  // 問い合わせ待ちの target。key は foldTitle、値は送る文字列
  const pending = new Map<string, string>();
  const controllers = new Set<AbortController>();
  let generation = 0;
  // dispose の前に始めた問い合わせの結果を捨てるための印
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstQueuedAt = 0;

  const notify = (): void => {
    try {
      options.onChange();
    } catch (error) {
      reportError(error);
    }
  };

  const entryOf = (key: string): Entry => {
    let entry = entries.get(key);
    if (entry === undefined) {
      if (entries.size >= MAX_ENTRIES) {
        for (const [oldKey, old] of entries) {
          if (!old.inFlight) {
            entries.delete(oldKey);
            break;
          }
        }
      }
      entry = { status: "unknown", page: null, generation: -1, inFlight: false, retryAt: 0 };
      entries.set(key, entry);
    }
    return entry;
  };

  /** 結果を書く。印（存在しないと確認できたか）か、リンクの URL を決める解決先が変わったかを返す。 */
  const store = (entry: Entry, page: ResolvedPage | null, at: number): boolean => {
    const before = entry.page;
    const wasMissing = entry.status === "missing";
    entry.status = page === null ? "missing" : "found";
    entry.page = page;
    entry.generation = at;
    entry.retryAt = 0;
    return (
      wasMissing !== (entry.status === "missing") ||
      before?.id !== page?.id ||
      before?.title !== page?.title ||
      before?.visibility !== page?.visibility
    );
  };

  const queue = (key: string, target: string): void => {
    pending.set(key, target);
    const at = now();
    if (timer === null) firstQueuedAt = at;
    else clearTimeout(timer);
    timer = setTimeout(flush, Math.min(debounceMs, Math.max(0, firstQueuedAt + maxWaitMs - at)));
  };

  async function flush(): Promise<void> {
    timer = null;
    const targets = [...pending];
    pending.clear();
    const mine = epoch;
    const startedAt = generation;
    const titles = targets.map(([, target]) => target);
    for (const [key] of targets) entryOf(key).inFlight = true;
    await Promise.all(
      splitResolveBatches(titles).map(async (indices) => {
        const controller = new AbortController();
        controllers.add(controller);
        let result: ApiResult<(ResolvedPage | null)[]>;
        try {
          result = await options.fetchTitles(
            indices.map((i) => titles[i] as string),
            controller.signal,
          );
        } catch {
          result = { ok: false, reason: "error", message: "" };
        }
        controllers.delete(controller);
        if (mine !== epoch) return;
        let changed = false;
        let stale = false;
        const ok = result.ok && result.value.length === indices.length;
        indices.forEach((titleIndex, i) => {
          const entry = entryOf((targets[titleIndex] as [string, string])[0]);
          entry.inFlight = false;
          if (result.ok && ok) {
            if (store(entry, result.value[i] ?? null, startedAt)) changed = true;
            if (entry.generation < generation) stale = true;
          } else {
            entry.retryAt = now() + cooldownMs;
          }
        });
        // 返信を待つ間に refresh されていたら、組み直しでもう一度取らせる
        if (changed || stale) notify();
      }),
    );
  }

  return {
    isResolved(target) {
      const key = foldTitle(target);
      if (key === "") return true;
      const entry = entryOf(key);
      if (
        entry.generation < generation &&
        !entry.inFlight &&
        !pending.has(key) &&
        now() >= entry.retryAt
      ) {
        if (canResolveTitle(target)) queue(key, target);
        else entry.retryAt = Number.POSITIVE_INFINITY;
      }
      return entry.status !== "missing";
    },

    resolvedPage(target) {
      const entry = entries.get(foldTitle(target));
      return entry?.status === "found" ? entry.page : null;
    },

    async lookup(target, signal) {
      // 存在し得ない title は問い合わせない（一覧の取得と同じ扱い）
      if (!canResolveTitle(target)) return { kind: "missing" };
      const key = foldTitle(target);
      const entry = entryOf(key);
      if (entry.status === "found" && entry.page !== null && entry.generation >= generation) {
        return { kind: "found", page: entry.page };
      }
      const mine = epoch;
      const startedAt = generation;
      let result: ApiResult<(ResolvedPage | null)[]>;
      try {
        result = await options.fetchTitles([target], signal ?? new AbortController().signal);
      } catch {
        return { kind: "error" };
      }
      if (!result.ok || result.value.length !== 1) return { kind: "error" };
      const page = result.value[0] ?? null;
      if (mine === epoch && store(entry, page, startedAt)) notify();
      return page === null ? { kind: "missing" } : { kind: "found", page };
    },

    refresh() {
      generation += 1;
      for (const entry of entries.values()) {
        if (entry.retryAt !== Number.POSITIVE_INFINITY) entry.retryAt = 0;
      }
      if (entries.size > 0) notify();
    },

    dispose() {
      epoch += 1;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
      for (const controller of controllers) controller.abort();
      controllers.clear();
      for (const entry of entries.values()) entry.inFlight = false;
    },
  };
}
