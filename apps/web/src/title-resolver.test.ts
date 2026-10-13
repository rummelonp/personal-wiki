import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOLVE_MAX_TITLES, type ResolvedPage } from "./pages-api";
import {
  createTitleResolver,
  type FetchTitles,
  TITLE_RESOLVE_DEBOUNCE_MS,
  TITLE_RESOLVE_FAILURE_COOLDOWN_MS,
  TITLE_RESOLVE_MAX_WAIT_MS,
} from "./title-resolver";

const page = (title: string): ResolvedPage => ({ id: `id-${title}`, title, visibility: "draft" });

/** `existing` の title（完全一致）だけが解決する Worker の代わり。 */
function server(existing: string[]) {
  return vi.fn<FetchTitles>(async (titles) => ({
    ok: true,
    value: titles.map((t) => (existing.includes(t) ? page(t) : null)),
  }));
}

function setup(fetchTitles: FetchTitles) {
  const onChange = vi.fn();
  const resolver = createTitleResolver({ fetchTitles, onChange });
  return { resolver, onChange };
}

const flush = () => vi.advanceTimersByTimeAsync(TITLE_RESOLVE_DEBOUNCE_MS);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("存在の印", () => {
  it("確認するまでは印を付けず、存在しないと分かった title だけ印を付けて組み直させる", async () => {
    const fetchTitles = server(["有る"]);
    const { resolver, onChange } = setup(fetchTitles);

    expect(resolver.isResolved("有る")).toBe(true);
    expect(resolver.isResolved("無い")).toBe(true);
    expect(fetchTitles).not.toHaveBeenCalled();

    await flush();
    expect(fetchTitles).toHaveBeenCalledTimes(1);
    expect(fetchTitles.mock.calls[0]?.[0]).toEqual(["有る", "無い"]);
    expect(resolver.isResolved("有る")).toBe(true);
    expect(resolver.isResolved("無い")).toBe(false);
    // 有ると分かっても見た目は変わらないので、組み直しは 1 回
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("連続した問い合わせは debounce して 1 回の要求にまとめる", async () => {
    const fetchTitles = server([]);
    const { resolver } = setup(fetchTitles);
    resolver.isResolved("a");
    await vi.advanceTimersByTimeAsync(TITLE_RESOLVE_DEBOUNCE_MS - 1);
    resolver.isResolved("b");
    await vi.advanceTimersByTimeAsync(TITLE_RESOLVE_DEBOUNCE_MS - 1);
    expect(fetchTitles).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchTitles).toHaveBeenCalledTimes(1);
    expect(fetchTitles.mock.calls[0]?.[0]).toEqual(["a", "b"]);
  });

  it("入力が続いても、最初の追加から上限の時間で問い合わせる", async () => {
    const fetchTitles = server([]);
    const { resolver } = setup(fetchTitles);
    const step = TITLE_RESOLVE_DEBOUNCE_MS - 50;
    for (let elapsed = 0, i = 0; elapsed <= TITLE_RESOLVE_MAX_WAIT_MS; elapsed += step, i++) {
      resolver.isResolved(`t${i}`);
      await vi.advanceTimersByTimeAsync(step);
    }
    expect(fetchTitles).toHaveBeenCalled();
  });

  it("title_key と同じ規則で同じになる表記は 1 件にまとめ、結果を共有する", async () => {
    const fetchTitles = server([]);
    const { resolver } = setup(fetchTitles);
    resolver.isResolved("Note");
    resolver.isResolved("ＮＯＴＥ ");
    resolver.isResolved("note");
    await flush();
    expect(fetchTitles.mock.calls[0]?.[0]).toEqual(["Note"]);
    expect(resolver.isResolved("ｎｏｔｅ")).toBe(false);
  });

  it("確認した title は何度見ても問い合わせ直さず、確認中のものも重ねて問い合わせない", async () => {
    let release: (() => void) | undefined;
    const fetchTitles = vi.fn<FetchTitles>(
      (titles) =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, value: titles.map(() => null) });
        }),
    );
    const { resolver } = setup(fetchTitles);
    resolver.isResolved("a");
    await flush();
    resolver.isResolved("a");
    await flush();
    expect(fetchTitles).toHaveBeenCalledTimes(1);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    resolver.isResolved("a");
    await flush();
    expect(fetchTitles).toHaveBeenCalledTimes(1);
  });

  it("Worker の上限の件数ごとに分けて問い合わせる", async () => {
    const fetchTitles = server([]);
    const { resolver } = setup(fetchTitles);
    for (let i = 0; i < RESOLVE_MAX_TITLES * 2 + 5; i++) resolver.isResolved(`t${i}`);
    await flush();
    expect(fetchTitles.mock.calls.map(([titles]) => titles.length)).toEqual([
      RESOLVE_MAX_TITLES,
      RESOLVE_MAX_TITLES,
      5,
    ]);
  });

  it("encode 後に URL へ収まらない長さの title は問い合わせない", async () => {
    const fetchTitles = server([]);
    const { resolver } = setup(fetchTitles);
    expect(resolver.isResolved("あ".repeat(1_000))).toBe(true);
    await flush();
    expect(fetchTitles).not.toHaveBeenCalled();
  });
});

describe("失敗", () => {
  const failures: [string, FetchTitles][] = [
    ["404", async () => ({ ok: false, reason: "not_found" })],
    ["5xx", async () => ({ ok: false, reason: "error", message: "500" })],
    [
      "通信の失敗",
      async () => {
        throw new TypeError("offline");
      },
    ],
    ["件数の違う応答", async () => ({ ok: true, value: [] })],
  ];

  it.each(failures)("%s では存在しない印を付けず、組み直させない", async (_, fetchTitles) => {
    const { resolver, onChange } = setup(vi.fn(fetchTitles));
    resolver.isResolved("a");
    await flush();
    expect(resolver.isResolved("a")).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("失敗した title は待ち時間の間は問い合わせ直さず、過ぎたら次の組み直しで取り直す", async () => {
    let failing = true;
    const fetchTitles = vi.fn<FetchTitles>(async (titles) =>
      failing
        ? { ok: false, reason: "error", message: "500" }
        : { ok: true, value: titles.map(() => null) },
    );
    const { resolver, onChange } = setup(fetchTitles);
    resolver.isResolved("a");
    await flush();
    expect(fetchTitles).toHaveBeenCalledTimes(1);

    // 入力のたびの組み直しでは叩き直さない
    resolver.isResolved("a");
    await flush();
    expect(fetchTitles).toHaveBeenCalledTimes(1);

    failing = false;
    await vi.advanceTimersByTimeAsync(TITLE_RESOLVE_FAILURE_COOLDOWN_MS);
    resolver.isResolved("a");
    await flush();
    expect(fetchTitles).toHaveBeenCalledTimes(2);
    expect(resolver.isResolved("a")).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("refresh は失敗の待ち時間を解く", async () => {
    const fetchTitles = vi.fn<FetchTitles>(async () => ({ ok: false, reason: "not_found" }));
    const { resolver } = setup(fetchTitles);
    resolver.isResolved("a");
    await flush();
    resolver.refresh();
    resolver.isResolved("a");
    await flush();
    expect(fetchTitles).toHaveBeenCalledTimes(2);
  });

  it("取り直しに失敗しても、前の印を残す", async () => {
    let failing = false;
    const fetchTitles = vi.fn<FetchTitles>(async (titles) =>
      failing ? { ok: false, reason: "not_found" } : { ok: true, value: titles.map(() => null) },
    );
    const { resolver } = setup(fetchTitles);
    resolver.isResolved("a");
    await flush();
    expect(resolver.isResolved("a")).toBe(false);

    failing = true;
    resolver.refresh();
    resolver.isResolved("a");
    await flush();
    expect(resolver.isResolved("a")).toBe(false);
  });
});

describe("refresh", () => {
  it("取り直すまでは前の印を出し続け、変わったときだけ組み直させる", async () => {
    const existing: string[] = [];
    const fetchTitles = server(existing);
    const { resolver, onChange } = setup(fetchTitles);
    resolver.isResolved("a");
    resolver.isResolved("b");
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);

    existing.push("a");
    resolver.refresh();
    // refresh の通知で組み直させ、そこで取り直しを始める
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(resolver.isResolved("a")).toBe(false);
    expect(resolver.isResolved("b")).toBe(false);
    await flush();
    expect(fetchTitles).toHaveBeenCalledTimes(2);
    expect(resolver.isResolved("a")).toBe(true);
    expect(resolver.isResolved("b")).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(3);

    // 変わらなければ組み直させない
    resolver.refresh();
    expect(onChange).toHaveBeenCalledTimes(4);
    resolver.isResolved("a");
    resolver.isResolved("b");
    await flush();
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it("確認中に refresh されたら、返ってきた後にもう一度取り直させる", async () => {
    const releases: (() => void)[] = [];
    const fetchTitles = vi.fn<FetchTitles>(
      (titles) =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: true, value: titles.map(() => null) }));
        }),
    );
    const { resolver, onChange } = setup(fetchTitles);
    resolver.isResolved("a");
    await flush();
    resolver.refresh();
    onChange.mockClear();
    releases[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledTimes(1);
    resolver.isResolved("a");
    await flush();
    expect(fetchTitles).toHaveBeenCalledTimes(2);
  });

  it("まだ何も見ていなければ組み直させない", () => {
    const { resolver, onChange } = setup(server([]));
    resolver.refresh();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("dispose", () => {
  it("進行中の問い合わせを中断し、結果を捨てて、組み直させない", async () => {
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const fetchTitles = vi.fn<FetchTitles>((titles, s) => {
      signal = s;
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, value: titles.map(() => null) });
      });
    });
    const { resolver, onChange } = setup(fetchTitles);
    resolver.isResolved("a");
    await flush();
    resolver.dispose();
    expect(signal?.aborted).toBe(true);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(resolver.isResolved("a")).toBe(true);
  });

  it("待っている要求を捨てる。破棄の後も使える", async () => {
    const fetchTitles = server([]);
    const { resolver } = setup(fetchTitles);
    resolver.isResolved("a");
    resolver.dispose();
    await flush();
    expect(fetchTitles).not.toHaveBeenCalled();

    resolver.isResolved("a");
    await flush();
    expect(fetchTitles).toHaveBeenCalledTimes(1);
    expect(resolver.isResolved("a")).toBe(false);
  });
});

describe("lookup", () => {
  it("取得済みの page は問い合わせずに返す", async () => {
    const fetchTitles = server(["有る"]);
    const { resolver } = setup(fetchTitles);
    resolver.isResolved("有る");
    await flush();
    expect(await resolver.lookup("有る")).toEqual({ kind: "found", page: page("有る") });
    expect(fetchTitles).toHaveBeenCalledTimes(1);
  });

  it("存在しないと取得済みでも問い合わせ直し、別のところで作られた page を見つける", async () => {
    const existing: string[] = [];
    const fetchTitles = server(existing);
    const { resolver, onChange } = setup(fetchTitles);
    resolver.isResolved("後で作る");
    await flush();
    expect(resolver.isResolved("後で作る")).toBe(false);

    existing.push("後で作る");
    expect(await resolver.lookup("後で作る")).toEqual({ kind: "found", page: page("後で作る") });
    // 印を外すので、組み直させる
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(resolver.isResolved("後で作る")).toBe(true);
  });

  it("存在しない title は missing、失敗は error で返す", async () => {
    const { resolver } = setup(server([]));
    expect(await resolver.lookup("無い")).toEqual({ kind: "missing" });

    const failing = setup(vi.fn<FetchTitles>(async () => ({ ok: false, reason: "not_found" })));
    expect(await failing.resolver.lookup("a")).toEqual({ kind: "error" });
    const offline = setup(
      vi.fn<FetchTitles>(async () => {
        throw new TypeError("offline");
      }),
    );
    expect(await offline.resolver.lookup("a")).toEqual({ kind: "error" });
  });

  it("失敗した問い合わせで存在しない印を付けない", async () => {
    const { resolver, onChange } = setup(
      vi.fn<FetchTitles>(async () => ({ ok: false, reason: "error", message: "500" })),
    );
    await resolver.lookup("a");
    expect(resolver.isResolved("a")).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});
