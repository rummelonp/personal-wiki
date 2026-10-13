import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPageEmbedCache,
  type PageEmbedCacheOptions,
  type PageEmbedPage,
} from "./page-embed-cache";

interface PendingLoad {
  readonly title: string;
  readonly signal: AbortSignal;
  resolve(page: PageEmbedPage | null): void;
  reject(error: unknown): void;
}

function setup(selfPageId = "self-id", overrides: Partial<PageEmbedCacheOptions> = {}) {
  const loads: PendingLoad[] = [];
  const onChange = vi.fn();
  const cache = createPageEmbedCache({
    selfPageId,
    onChange,
    load: (title, signal) =>
      new Promise((resolve, reject) => {
        loads.push({ title, signal, resolve, reject });
      }),
    ...overrides,
  });
  return { cache, loads, onChange };
}

/** load の promise の後続（then/finally）を流す */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 再試行の間隔の上限より長い時間 */
const RETRY_WINDOW_MS = 120_000;

const page = (text: string): PageEmbedPage => ({ id: "note-id", title: "Note", text });

describe("createPageEmbedCache", () => {
  it("returns loading at first, then the page once it arrives", async () => {
    const { cache, loads, onChange } = setup();

    expect(cache.resolve("Note")).toEqual({ kind: "loading" });
    expect(loads.map((load) => load.title)).toEqual(["Note"]);
    // 取得中にもう一度引いても、取得は増えない
    cache.resolve("Note");
    expect(loads).toHaveLength(1);

    loads[0]?.resolve(page("本文"));
    await settled();

    expect(onChange).toHaveBeenCalledTimes(1);
    const content = cache.resolve("Note");
    expect(content).toEqual({ kind: "resolved", title: "Note", text: "本文" });
    // 同じオブジェクトを返し続ける（widget が DOM を使い回す）
    expect(cache.resolve("Note")).toBe(content);
    expect(loads).toHaveLength(1);
  });

  it("does not call onChange from inside resolve", () => {
    const { cache, onChange } = setup();
    cache.resolve("Note");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows a missing or unreadable page as unresolved", async () => {
    const { cache, loads } = setup();
    cache.resolve("Secret");
    loads[0]?.resolve(null);
    await settled();
    expect(cache.resolve("Secret")).toEqual({ kind: "unresolved" });
  });

  it("does not expand the source page itself", async () => {
    const { cache, loads } = setup("note-id");
    cache.resolve("Note");
    loads[0]?.resolve(page("自分の本文"));
    await settled();
    expect(cache.resolve("Note")).toEqual({ kind: "self" });
  });

  it("keeps the old content while refetching after refresh", async () => {
    const { cache, loads, onChange } = setup();
    cache.resolve("Note");
    loads[0]?.resolve(page("古い本文"));
    await settled();
    const before = cache.resolve("Note");
    onChange.mockClear();

    cache.refresh();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(cache.resolve("Note")).toBe(before);
    expect(loads).toHaveLength(2);

    loads[1]?.resolve(page("新しい本文"));
    await settled();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(cache.resolve("Note")).toEqual({ kind: "resolved", title: "Note", text: "新しい本文" });
  });

  it("keeps the same object and stays quiet when a refetch returns the same page", async () => {
    const { cache, loads, onChange } = setup();
    cache.resolve("Note");
    loads[0]?.resolve(page("本文"));
    await settled();
    const before = cache.resolve("Note");

    cache.refresh();
    cache.resolve("Note");
    onChange.mockClear();
    loads[1]?.resolve(page("本文"));
    await settled();

    expect(onChange).not.toHaveBeenCalled();
    expect(cache.resolve("Note")).toBe(before);
  });

  it("keeps a load in flight across refresh, uses its answer, then refetches", async () => {
    const { cache, loads, onChange } = setup();
    cache.resolve("Note");
    cache.refresh();
    expect(loads[0]?.signal.aborted).toBe(false);
    // 取得中の間は重ねて出さない（応答が出した順に届くことを保つ）
    cache.resolve("Note");
    expect(loads).toHaveLength(1);

    onChange.mockClear();
    loads[0]?.resolve(page("途中の本文"));
    await settled();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(cache.resolve("Note")).toEqual({ kind: "resolved", title: "Note", text: "途中の本文" });
    expect(loads).toHaveLength(2);

    loads[1]?.resolve(page("新しい本文"));
    await settled();
    expect(cache.resolve("Note")).toEqual({ kind: "resolved", title: "Note", text: "新しい本文" });
    expect(loads).toHaveLength(2);
  });

  it("asks for a refetch when refresh came during a load that returned the same page", async () => {
    const { cache, loads, onChange } = setup();
    cache.resolve("Note");
    loads[0]?.resolve(page("本文"));
    await settled();
    cache.refresh();
    cache.resolve("Note");
    cache.refresh();
    onChange.mockClear();

    loads[1]?.resolve(page("本文"));
    await settled();
    // 内容は変わらないが、世代が古いので組み直させ、見えている embed に取り直させる
    expect(onChange).toHaveBeenCalledTimes(1);
    cache.resolve("Note");
    expect(loads).toHaveLength(3);
  });

  it("resolves even when refresh comes more often than a load takes", async () => {
    const { cache, loads } = setup();
    for (let i = 0; i < 4; i += 1) {
      cache.resolve("Note");
      cache.refresh();
      cache.resolve("Note");
      loads[i]?.resolve(page(`本文 ${i}`));
      await settled();
      expect(cache.resolve("Note")).toEqual({ kind: "resolved", title: "Note", text: `本文 ${i}` });
    }
  });

  it("does not call onChange on refresh before anything was resolved", () => {
    const { cache, onChange } = setup();
    cache.refresh();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps working when onChange throws", async () => {
    const reported = vi.spyOn(globalThis, "reportError").mockImplementation(() => {});
    try {
      const { cache, loads } = setup("self-id", {
        onChange: () => {
          throw new Error("onChange");
        },
      });
      cache.resolve("Note");
      loads[0]?.resolve(page("本文"));
      await settled();

      expect(reported).toHaveBeenCalledTimes(1);
      expect(cache.resolve("Note")).toEqual({ kind: "resolved", title: "Note", text: "本文" });
      // entry は取得中のまま詰まらず、refresh で取り直せる
      expect(() => cache.refresh()).not.toThrow();
      cache.resolve("Note");
      expect(loads).toHaveLength(2);
    } finally {
      reported.mockRestore();
    }
  });

  describe("when a load fails", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** 1 回目の取得を始めて失敗させる。以後の取得は `loads` に積まれる */
    async function failFirst(overrides: Partial<PageEmbedCacheOptions> = {}) {
      const context = setup("self-id", overrides);
      context.cache.resolve("Note");
      context.loads[0]?.reject(new Error("network"));
      await vi.advanceTimersByTimeAsync(0);
      context.onChange.mockClear();
      return context;
    }

    /** `ms` 待つと再試行を求め、その直前には求めないことを確かめる */
    async function expectRetryAfter(ms: number, onChange: ReturnType<typeof vi.fn>) {
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(onChange).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onChange).toHaveBeenCalledTimes(1);
      onChange.mockClear();
    }

    it("keeps loading instead of unresolved, and retries after a backoff", async () => {
      const { cache, loads, onChange } = await failFirst();

      // 未解決（無いか読めない）とは見分けられる状態のまま残す
      expect(cache.resolve("Note")).toEqual({ kind: "loading" });
      expect(loads).toHaveLength(1);

      await expectRetryAfter(2_000, onChange);
      cache.resolve("Note");
      expect(loads).toHaveLength(2);

      loads[1]?.resolve(page("本文"));
      await vi.advanceTimersByTimeAsync(0);
      expect(cache.resolve("Note")).toEqual({ kind: "resolved", title: "Note", text: "本文" });
    });

    it("waits longer after each failure in a row, up to 60 seconds", async () => {
      const { cache, loads, onChange } = await failFirst();

      for (const [i, delay] of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000].entries()) {
        await expectRetryAfter(delay, onChange);
        // 待っている間は組み直されても取得を始めないので、取得は再試行ごとに 1 本だけ増える
        cache.resolve("Note");
        expect(loads).toHaveLength(i + 2);
        loads[i + 1]?.reject(new Error("network"));
        await vi.advanceTimersByTimeAsync(0);
      }
      cache.dispose();
    });

    it("starts over from 2 seconds after a success", async () => {
      const { cache, loads, onChange } = await failFirst();
      await expectRetryAfter(2_000, onChange);
      cache.resolve("Note");
      loads[1]?.reject(new Error("network"));
      await vi.advanceTimersByTimeAsync(0);
      await expectRetryAfter(4_000, onChange);
      cache.resolve("Note");
      loads[2]?.resolve(page("本文"));
      await vi.advanceTimersByTimeAsync(0);
      onChange.mockClear();

      cache.refresh();
      onChange.mockClear();
      cache.resolve("Note");
      loads[3]?.reject(new Error("network"));
      await vi.advanceTimersByTimeAsync(0);
      await expectRetryAfter(2_000, onChange);
      cache.resolve("Note");
      expect(loads).toHaveLength(5);
      cache.dispose();
    });

    it("does not retry a missing or unreadable page", async () => {
      const { cache, loads, onChange } = setup();
      cache.resolve("Secret");
      loads[0]?.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
      onChange.mockClear();

      await vi.advanceTimersByTimeAsync(RETRY_WINDOW_MS);
      cache.resolve("Secret");
      expect(loads).toHaveLength(1);
      expect(onChange).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("retries at once on refresh while waiting, and keeps counting failures", async () => {
      const { cache, loads, onChange } = await failFirst();
      await expectRetryAfter(2_000, onChange);
      cache.resolve("Note");
      loads[1]?.reject(new Error("network"));
      await vi.advanceTimersByTimeAsync(1_000);

      // 本文の更新が届いた（サーバー側が動いている目安）ので、4 秒を待たずに取り直す
      cache.refresh();
      expect(onChange).toHaveBeenCalledTimes(1);
      onChange.mockClear();
      cache.resolve("Note");
      expect(loads).toHaveLength(3);

      // 失敗の回数は残るので、次は 8 秒待つ
      loads[2]?.reject(new Error("network"));
      await vi.advanceTimersByTimeAsync(0);
      await expectRetryAfter(8_000, onChange);
      cache.dispose();
    });

    it("waits for the backoff when a load fails after a refresh during it", async () => {
      const { cache, loads, onChange } = setup();
      cache.resolve("Note");
      loads[0]?.resolve(page("本文"));
      await vi.advanceTimersByTimeAsync(0);
      const before = cache.resolve("Note");
      cache.refresh();
      cache.resolve("Note");
      cache.refresh();
      onChange.mockClear();

      // 失敗は refresh より後に分かったことなので、すぐには取り直さない
      loads[1]?.reject(new Error("network"));
      await vi.advanceTimersByTimeAsync(0);
      expect(cache.resolve("Note")).toBe(before);
      expect(loads).toHaveLength(2);

      await expectRetryAfter(2_000, onChange);
      cache.resolve("Note");
      expect(loads).toHaveLength(3);
      cache.dispose();
    });

    it("retries embeds that failed close together with a single onChange", async () => {
      const { cache, loads, onChange } = setup();
      cache.resolve("A");
      cache.resolve("B");
      loads[0]?.reject(new Error("network"));
      await vi.advanceTimersByTimeAsync(500);
      loads[1]?.reject(new Error("network"));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_500);
      expect(onChange).toHaveBeenCalledTimes(1);
      cache.resolve("A");
      cache.resolve("B");
      expect(loads.map((load) => load.title)).toEqual(["A", "B", "A", "B"]);
      cache.dispose();
    });

    it("re-arms the shared timer for an embed left outside the coalescing window", async () => {
      const { cache, loads, onChange } = setup();
      cache.resolve("A");
      loads[0]?.reject(new Error("network"));
      await vi.advanceTimersByTimeAsync(1_500);
      cache.resolve("B");
      loads[1]?.reject(new Error("network"));
      await vi.advanceTimersByTimeAsync(0);

      // t=2000：A だけが取り直される（B の 3500 は 1 秒の窓の外）
      await vi.advanceTimersByTimeAsync(500);
      expect(onChange).toHaveBeenCalledTimes(1);
      cache.resolve("A");
      cache.resolve("B");
      expect(loads.map((load) => load.title)).toEqual(["A", "B", "A"]);
      expect(vi.getTimerCount()).toBe(1);

      // t=3500：張り直した timer で B が取り直される
      await vi.advanceTimersByTimeAsync(1_499);
      expect(onChange).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(onChange).toHaveBeenCalledTimes(2);
      cache.resolve("B");
      expect(loads.map((load) => load.title)).toEqual(["A", "B", "A", "B"]);
      cache.dispose();
    });

    it("treats a load that throws synchronously as a failure", async () => {
      let calls = 0;
      const onChange = vi.fn();
      const cache = createPageEmbedCache({
        selfPageId: "self-id",
        onChange,
        load: () => {
          calls += 1;
          throw new Error("sync");
        },
      });
      expect(cache.resolve("Note")).toEqual({ kind: "loading" });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(onChange).toHaveBeenCalledTimes(1);
      cache.resolve("Note");
      expect(calls).toBe(2);
      cache.dispose();
    });

    it("keeps the previous page when a refetch fails", async () => {
      const { cache, loads } = setup();
      cache.resolve("Note");
      loads[0]?.resolve(page("本文"));
      await vi.advanceTimersByTimeAsync(0);
      const before = cache.resolve("Note");

      cache.refresh();
      cache.resolve("Note");
      loads[1]?.reject(new Error("network"));
      await vi.advanceTimersByTimeAsync(0);

      expect(cache.resolve("Note")).toBe(before);
      cache.dispose();
    });

    it("cancels a pending retry on dispose", async () => {
      const { cache, onChange } = await failFirst();
      cache.dispose();

      await vi.advanceTimersByTimeAsync(RETRY_WINDOW_MS);
      expect(onChange).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("leaves no timer when a load aborted by dispose rejects", async () => {
      const { cache, loads, onChange } = setup();
      cache.resolve("Note");
      cache.dispose();
      expect(loads[0]?.signal.aborted).toBe(true);

      loads[0]?.reject(new DOMException("aborted", "AbortError"));
      await vi.advanceTimersByTimeAsync(RETRY_WINDOW_MS);
      expect(vi.getTimerCount()).toBe(0);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  it("aborts loads and stops notifying after dispose", async () => {
    const { cache, loads, onChange } = setup();
    cache.resolve("Note");
    cache.dispose();
    expect(loads[0]?.signal.aborted).toBe(true);

    loads[0]?.resolve(page("本文"));
    await settled();
    expect(onChange).not.toHaveBeenCalled();
    expect(cache.resolve("Note")).toEqual({ kind: "loading" });
    expect(loads).toHaveLength(1);
  });
});
