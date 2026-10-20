import { describe, expect, it, vi } from "vitest";
import {
  createTitleIndex,
  type ListTitles,
  TITLE_INDEX_MAX_REQUESTS,
  TITLE_INDEX_RETRY_COOLDOWN_MS,
} from "./link-sources";
import type { ApiResult, PageList, PageSummary } from "./pages-api";

const summary = (id: string, title: string): PageSummary => ({
  id,
  title,
  visibility: "draft",
  updatedAt: 0,
});

const listOk = (pages: PageSummary[], nextCursor: string | null = null) =>
  ({ ok: true, value: { pages, nextCursor } }) as ApiResult<PageList<PageSummary>>;

describe("createTitleIndex", () => {
  it("一覧の title を、title_key と同じ規則で引ける候補にする", async () => {
    const index = createTitleIndex(async () =>
      listOk([summary("1", "Ｎｏｔｅ"), summary("2", "日記")]),
    );
    expect(index.search("note")).toEqual([]);
    await index.refresh();
    expect(index.search("note")).toEqual([{ id: "1", title: "Ｎｏｔｅ" }]);
  });

  it("1 回目の取得が済むまで settled は false で、成功でも失敗でも済んだら true になる", async () => {
    let release: () => void = () => {};
    const ok = createTitleIndex(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return listOk([summary("1", "Note")]);
    });
    const refreshing = ok.refresh();
    expect(ok.settled()).toBe(false);
    release();
    await refreshing;
    expect(ok.settled()).toBe(true);

    const thrown = createTitleIndex(async () => {
      throw new Error("network");
    });
    expect(thrown.settled()).toBe(false);
    await thrown.refresh();
    expect(thrown.settled()).toBe(true);

    const rejected = createTitleIndex(
      async () => ({ ok: false, reason: "error", message: "失敗" }) as ApiResult<never>,
    );
    await rejected.refresh();
    expect(rejected.settled()).toBe(true);
  });

  it("候補が 1 件も無いまま最新の refresh が失敗したら failed になり、成功すると戻る", async () => {
    let fail = true;
    const index = createTitleIndex(async () => {
      if (fail) throw new Error("network");
      return listOk([summary("1", "Note")]);
    });
    expect(index.failed()).toBe(false);
    await index.refresh();
    expect(index.settled()).toBe(true);
    expect(index.failed()).toBe(true);

    const rejected = createTitleIndex(
      async () => ({ ok: false, reason: "error", message: "失敗" }) as ApiResult<never>,
    );
    await rejected.refresh();
    expect(rejected.failed()).toBe(true);

    fail = false;
    await index.refresh();
    expect(index.failed()).toBe(false);
    expect(index.settled()).toBe(true);
  });

  it("ページが 1 件も無い wiki の取得は、成功なので failed にならない", async () => {
    const index = createTitleIndex(async () => listOk([]));
    await index.refresh();
    expect(index.failed()).toBe(false);
  });

  it("前に取れた候補や途中まで取れた候補があれば、後の refresh が失敗しても failed にしない", async () => {
    let mode: "ok" | "fail" | "partial" = "ok";
    const index = createTitleIndex(async (cursor) => {
      if (mode === "fail" || (mode === "partial" && cursor !== null)) throw new Error("network");
      return listOk([summary("1", "Note")], mode === "partial" ? "next" : null);
    });
    await index.refresh();
    mode = "fail";
    await index.refresh();
    expect(index.failed()).toBe(false);
    expect(index.search("Note")).toHaveLength(1);

    const fresh = createTitleIndex(async (cursor) => {
      if (cursor !== null) throw new Error("network");
      return listOk([summary("1", "Note")], "next");
    });
    await fresh.refresh();
    expect(fresh.failed()).toBe(false);
  });

  it("後から始まった refresh に追い越された refresh の失敗は、failed にしない", async () => {
    const outcomes: ((r: ApiResult<PageList<PageSummary>>) => void)[] = [];
    const index = createTitleIndex(
      () =>
        new Promise((resolve) => {
          outcomes.push(resolve);
        }),
    );
    const first = index.refresh();
    const second = index.refresh();
    outcomes[0]?.({ ok: false, reason: "error", message: "失敗" } as ApiResult<never>);
    await first;
    expect(index.failed()).toBe(false);
    outcomes[1]?.(listOk([summary("1", "Note")]));
    await second;
    expect(index.failed()).toBe(false);
  });

  it("後から始まった refresh に追い越された refresh は、settled にしない", async () => {
    const releases: (() => void)[] = [];
    const index = createTitleIndex(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return listOk([summary("1", "Note")]);
    });
    const first = index.refresh();
    const second = index.refresh();
    releases[0]?.();
    await first;
    expect(index.settled()).toBe(false);
    releases[1]?.();
    await second;
    expect(index.settled()).toBe(true);
  });

  it("cursor を辿り、上限の回数で止める", async () => {
    const list = vi.fn<ListTitles>(async (cursor) =>
      listOk([summary(cursor ?? "0", `p${cursor ?? "0"}`)], `${Number(cursor ?? 0) + 1}`),
    );
    const index = createTitleIndex(list);
    await index.refresh();
    expect(list).toHaveBeenCalledTimes(TITLE_INDEX_MAX_REQUESTS);
    expect(list.mock.calls.map(([cursor]) => cursor)).toEqual([null, "1", "2", "3"]);
    // 途中のページの分も積み上げて持つ
    expect(index.search("p0")).toContainEqual({ id: "0", title: "p0" });
    expect(index.search("p3")).toContainEqual({ id: "3", title: "p3" });
  });

  it("maxRequests で回数の上限を変えられ、続きがあってもそこで止める", async () => {
    const list = vi.fn<ListTitles>(async () => listOk([summary("0", "p0")], "next"));
    const index = createTitleIndex(list, { maxRequests: 1 });
    await index.refresh();
    expect(list).toHaveBeenCalledTimes(1);
    expect(index.search("p0")).toEqual([{ id: "0", title: "p0" }]);
  });

  it("1 回目で失敗したら前の候補を残し、reject しない", async () => {
    let fail = false;
    const index = createTitleIndex(async () => {
      if (fail) throw new Error("network");
      return listOk([summary("1", "Note")]);
    });
    await index.refresh();
    fail = true;
    await expect(index.refresh()).resolves.toBeUndefined();
    expect(index.search("Note")).toHaveLength(1);
  });

  it("途中で失敗したら、取れた分までを候補にする", async () => {
    const responses: (() => Promise<ApiResult<PageList<PageSummary>>>)[] = [
      async () => listOk([summary("1", "一枚目")], "c1"),
      async () => listOk([summary("2", "二枚目")], "c2"),
      async () => ({ ok: false, reason: "error", message: "サーバーに接続できない" }),
    ];
    const list = vi.fn<ListTitles>(() => (responses.shift() as () => Promise<never>)());
    const index = createTitleIndex(list);
    await expect(index.refresh()).resolves.toBeUndefined();
    expect(list).toHaveBeenCalledTimes(3);
    expect(index.search("一枚目")).toContainEqual({ id: "1", title: "一枚目" });
    expect(index.search("二枚目")).toContainEqual({ id: "2", title: "二枚目" });
  });

  it("遅れて終わった古い取り直しで上書きしない", async () => {
    let release: (() => void) | undefined;
    const responses = [
      () =>
        new Promise<ApiResult<PageList<PageSummary>>>((resolve) => {
          release = () => resolve(listOk([summary("old", "古い")]));
        }),
      async () => listOk([summary("new", "新しい")]),
    ];
    const index = createTitleIndex(() => (responses.shift() ?? responses[0])?.() as never);
    const first = index.refresh();
    await index.refresh();
    release?.();
    await first;
    expect(index.search("新しい")).toHaveLength(1);
    expect(index.search("古い")).toEqual([]);
  });
});

describe("createTitleIndex の取り直し", () => {
  const failed = () => ({ ok: false, reason: "error", message: "失敗" }) as ApiResult<never>;

  it("取得中の間だけ loading が true で、遅れて終わった古い取り直しでは戻らない", async () => {
    const releases: (() => void)[] = [];
    const index = createTitleIndex(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve(listOk([summary("1", "Note")])));
        }),
    );
    expect(index.loading()).toBe(false);
    const first = index.refresh();
    const second = index.refresh();
    expect(index.loading()).toBe(true);
    releases[0]?.();
    await first;
    // 後から始めた取り直しがまだ続いている
    expect(index.loading()).toBe(true);
    releases[1]?.();
    await second;
    expect(index.loading()).toBe(false);
  });

  it("list が同期に投げても、loading は取得の後に false へ戻る", async () => {
    const index = createTitleIndex(() => {
      throw new Error("sync");
    });
    await index.refresh();
    expect(index.loading()).toBe(false);
    expect(index.failed()).toBe(true);
  });

  it("失敗の後の retry は、間隔が過ぎていれば取り直し、取れたら failed が戻る（補完の最初の取得の失敗）", async () => {
    let clock = 0;
    let fail = true;
    const list = vi.fn(async () => (fail ? failed() : listOk([summary("1", "Note")])));
    const index = createTitleIndex(list, { now: () => clock });
    await index.refresh();
    expect(index.failed()).toBe(true);

    fail = false;
    clock += TITLE_INDEX_RETRY_COOLDOWN_MS;
    await index.retry();
    expect(list).toHaveBeenCalledTimes(2);
    expect(index.failed()).toBe(false);
    expect(index.search("note")).toEqual([{ id: "1", title: "Note" }]);
  });

  it("失敗の直後は取り直さず、打鍵のたびに呼んでもリクエストを連打しない", async () => {
    let clock = 0;
    const list = vi.fn(async () => failed());
    const index = createTitleIndex(list, { now: () => clock });
    await index.refresh();
    for (let i = 0; i < 5; i++) await index.retry();
    expect(list).toHaveBeenCalledTimes(1);

    clock += TITLE_INDEX_RETRY_COOLDOWN_MS;
    await index.retry();
    expect(list).toHaveBeenCalledTimes(2);
    // その取り直しも失敗したので、また間隔を空ける
    await index.retry();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("取得中の retry は、重ねて取らず、その終わりを待つ", async () => {
    let release: () => void = () => {};
    const list = vi.fn(
      () =>
        new Promise<ApiResult<PageList<PageSummary>>>((resolve) => {
          release = () => resolve(listOk([summary("1", "Note")]));
        }),
    );
    const index = createTitleIndex(list);
    void index.refresh();
    let done = false;
    const waiting = Promise.all([index.retry(), index.retry()]).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await waiting;
    expect(list).toHaveBeenCalledTimes(1);
    expect(index.search("note")).toHaveLength(1);
  });

  it("待っている間に別の refresh が重なっても、retry は最後の取得の終わりまで待つ", async () => {
    const releases: ((value: ApiResult<PageList<PageSummary>>) => void)[] = [];
    const list = vi.fn(
      () =>
        new Promise<ApiResult<PageList<PageSummary>>>((resolve) => {
          releases.push(resolve);
        }),
    );
    const index = createTitleIndex(list);
    void index.refresh();
    let done = false;
    const waiting = index.retry().then(() => {
      done = true;
    });
    void index.refresh();
    releases[0]?.(listOk([]));
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);

    releases[1]?.(listOk([summary("1", "Note")]));
    await waiting;
    expect(index.loading()).toBe(false);
    expect(index.search("note")).toHaveLength(1);
  });

  it("まだ取得を始めていないインデックスの retry は、取得を始める", async () => {
    const list = vi.fn(async () => listOk([summary("1", "Note")]));
    const index = createTitleIndex(list);
    await index.retry();
    expect(list).toHaveBeenCalledTimes(1);
    expect(index.settled()).toBe(true);
  });

  it("取得に成功していれば、候補が空でも retry は何もしない", async () => {
    const list = vi.fn(async () => listOk([]));
    const index = createTitleIndex(list);
    await index.refresh();
    await index.retry();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("前に取れた候補があれば、後の取得が失敗しても retry は取り直さない", async () => {
    let clock = 0;
    let fail = false;
    const list = vi.fn(async () => (fail ? failed() : listOk([summary("1", "Note")])));
    const index = createTitleIndex(list, { now: () => clock });
    await index.refresh();
    fail = true;
    await index.refresh();
    clock += TITLE_INDEX_RETRY_COOLDOWN_MS;
    await index.retry();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
