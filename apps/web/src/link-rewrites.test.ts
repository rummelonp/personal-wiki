import { describe, expect, it, vi } from "vitest";
import {
  advance,
  CONFLICT_WAIT_MS,
  continuationOf,
  ERROR_WAITS_MS,
  LinkRewriteRunner,
  type LinkRewriteState,
  MAX_CONFLICTS,
  outcomeOf,
} from "./link-rewrites";
import type { LinkRewriteStepResult, StepResult } from "./link-rewrites-api";

const ok = (value: Partial<LinkRewriteStepResult>): StepResult => ({
  ok: true,
  value: { processed: null, conflict: false, failed: [], remaining: 0, ...value },
});

const failure = (id: string) => ({ id, title: `前 ${id}` });

const processed = (id: string, visibility: "public" | "draft" = "draft") => ({
  sourcePageId: id,
  title: `題 ${id}`,
  visibility,
  version: 2,
  rewritten: 1,
});

function setup(results: StepResult[], titles: Record<string, string> = {}) {
  const step = vi.fn(async () => {
    const next = results.shift();
    if (next === undefined) throw new Error("想定より多く呼んだ");
    return next;
  });
  const sleep = vi.fn(async (_ms: number) => {});
  const pageTitle = vi.fn(async (id: string) => titles[id] ?? null);
  const runner = new LinkRewriteRunner({ step, pageTitle, sleep });
  const states: LinkRewriteState[] = [];
  runner.subscribe(() => states.push(runner.getState()));
  const settled = () =>
    vi.waitFor(() => {
      if (runner.getState().status === "running") throw new Error("まだ走っている");
    });
  return { runner, step, sleep, pageTitle, states, settled };
}

describe("LinkRewriteRunner", () => {
  it("残りが 0 になるまで 1 ページずつ呼び、書き換えたページを公開範囲と一緒に残す", async () => {
    const { runner, step, states, settled } = setup([
      ok({ processed: processed("a", "public"), remaining: 1 }),
      ok({ processed: processed("b"), remaining: 0 }),
    ]);
    runner.start(2);
    expect(runner.getState()).toMatchObject({ status: "running", done: 0, total: 2 });
    await settled();
    expect(step).toHaveBeenCalledTimes(2);
    expect(states.map((s) => `${s.done}/${s.total}`)).toEqual(["0/2", "1/2", "2/2"]);
    expect(runner.getState()).toMatchObject({
      status: "done",
      rewritten: [
        { id: "a", title: "題 a", visibility: "public" },
        { id: "b", title: "題 b", visibility: "draft" },
      ],
    });
    runner.dismiss();
    expect(runner.getState().status).toBe("idle");
  });

  it("conflict なら待って呼び直す", async () => {
    const { runner, step, sleep, settled } = setup([
      ok({ conflict: true, remaining: 1 }),
      ok({ processed: processed("a"), remaining: 0 }),
    ]);
    runner.start(1);
    await settled();
    expect(step).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(runner.getState()).toMatchObject({ status: "done", done: 1, total: 1 });
  });

  it("conflict が続けば上限で止める", async () => {
    const { runner, step, settled } = setup(
      Array.from({ length: MAX_CONFLICTS + 1 }, () => ok({ conflict: true, remaining: 1 })),
    );
    runner.start(1);
    await settled();
    expect(step).toHaveBeenCalledTimes(MAX_CONFLICTS + 1);
    expect(runner.getState()).toMatchObject({ status: "stopped", stopReason: "error" });
  });

  it("通信の失敗は間を広げて呼び直し、回数を超えたら止める", async () => {
    const { runner, step, sleep, settled } = setup(
      Array.from(
        { length: ERROR_WAITS_MS.length + 1 },
        () => ({ ok: false, kind: "error" }) as const,
      ),
    );
    runner.start(1);
    await settled();
    expect(step).toHaveBeenCalledTimes(ERROR_WAITS_MS.length + 1);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(ERROR_WAITS_MS);
    expect(runner.getState()).toMatchObject({ status: "stopped", stopReason: "error" });
  });

  it("通信の失敗のあと成功すれば続ける", async () => {
    const { runner, settled } = setup([
      { ok: false, kind: "error" },
      ok({ processed: processed("a"), remaining: 0 }),
    ]);
    runner.start(1);
    await settled();
    expect(runner.getState()).toMatchObject({ status: "done", done: 1 });
  });

  it("取り込む応答を挟めば、通信の失敗と conflict の数を数え直す", async () => {
    const errors = () =>
      Array.from({ length: ERROR_WAITS_MS.length }, () => ({ ok: false, kind: "error" }) as const);
    const conflicts = () =>
      Array.from({ length: MAX_CONFLICTS }, () => ok({ conflict: true, remaining: 2 }));
    // 通信の失敗は conflict の数を戻さないので、前の回の conflict の後に通信の失敗を置き、次の回は通信の失敗から始める
    const { runner, settled } = setup([
      ...conflicts(),
      ...errors(),
      ok({ processed: processed("a"), remaining: 1 }),
      ...errors(),
      ...conflicts(),
      ok({ processed: processed("b"), remaining: 0 }),
    ]);
    runner.start(2);
    await settled();
    expect(runner.getState()).toMatchObject({ status: "done", done: 2 });
  });

  it("step の無い Worker（404）では黙って止める", async () => {
    const { runner, step, settled } = setup([{ ok: false, kind: "not_found" }]);
    runner.start(3);
    await settled();
    expect(step).toHaveBeenCalledTimes(1);
    expect(runner.getState().status).toBe("idle");
  });

  it("401 と 403 ではログインを促すために止める", async () => {
    for (const kind of ["unauthorized", "forbidden"] as const) {
      const { runner, settled } = setup([{ ok: false, kind }]);
      runner.start(1);
      await settled();
      expect(runner.getState()).toMatchObject({ status: "stopped", stopReason: "auth" });
    }
  });

  it("書き換えなかったリンク元を failed に集める", async () => {
    const { runner, settled } = setup([
      ok({ failed: [failure("x")], remaining: 1 }),
      ok({ processed: processed("a"), remaining: 0 }),
    ]);
    runner.start(2);
    await settled();
    expect(runner.getState()).toMatchObject({ status: "done", done: 2, failed: [failure("x")] });
  });

  it("何もキューに入っていなければ 1 回呼ぶだけで何も見せない（起動時の再開）", async () => {
    const { runner, step, states } = setup([ok({ remaining: 0 })]);
    runner.start();
    await vi.waitFor(() => expect(step).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(states.length).toBeGreaterThan(1));
    expect(states.every((s) => s.status === "idle")).toBe(true);
  });

  it("走っている間の start は、残りが 0 になってからもう一度確かめる", async () => {
    let release: () => void = () => {};
    const { runner, step, settled } = setup([ok({ processed: processed("b"), remaining: 0 })]);
    step.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok({ processed: processed("a"), remaining: 0 }));
        }),
    );
    runner.start(1);
    runner.start(1);
    release();
    await settled();
    expect(step).toHaveBeenCalledTimes(2);
    expect(runner.getState().rewritten.map((page) => page.id)).toEqual(["a", "b"]);
  });

  it("何も見せていない間（起動時の再開）の start も、ループを 2 本にしない", async () => {
    let release: () => void = () => {};
    const { runner, step, settled } = setup([ok({ processed: processed("b"), remaining: 0 })]);
    step.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok({ remaining: 0 }));
        }),
    );
    runner.start();
    runner.start(1);
    expect(step).toHaveBeenCalledTimes(1);
    expect(runner.getState()).toMatchObject({ status: "running", total: 1 });
    release();
    await settled();
    expect(step).toHaveBeenCalledTimes(2);
    expect(runner.getState()).toMatchObject({ status: "done", rewritten: [{ id: "b" }] });
  });

  it("走っている間に新しくキューに入っていない start（StrictMode の 2 回目の再開）では、step を余分に呼ばない", async () => {
    let release: () => void = () => {};
    const { runner, step, settled } = setup([]);
    step.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok({ processed: processed("a"), remaining: 0 }));
        }),
    );
    runner.start();
    runner.start();
    release();
    await settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("結果を知らせた listener がその場で start しても、取りこぼさずに新しいループを走らせる", async () => {
    const { runner, step, settled } = setup([
      ok({ processed: processed("a"), remaining: 0 }),
      ok({ processed: processed("b"), remaining: 0 }),
    ]);
    let restarted = false;
    runner.subscribe(() => {
      if (!restarted && runner.getState().status === "done") {
        restarted = true;
        runner.start(1);
      }
    });
    runner.start(1);
    await vi.waitFor(() => expect(step).toHaveBeenCalledTimes(2));
    await settled();
    expect(runner.getState()).toMatchObject({ status: "done", rewritten: [{ id: "b" }] });
  });

  it("止まったあとの再試行は、それまでの一覧を残して続ける", async () => {
    const { runner, step, settled } = setup([
      ok({ processed: processed("a"), failed: [failure("x")], remaining: 1 }),
      ...Array.from(
        { length: ERROR_WAITS_MS.length + 1 },
        () => ({ ok: false, kind: "error" }) as const,
      ),
      ok({ processed: processed("b"), remaining: 0 }),
    ]);
    runner.start(2);
    await vi.waitFor(() => expect(runner.getState().status).toBe("stopped"));
    runner.retry();
    expect(runner.getState()).toMatchObject({ status: "running", stopReason: null });
    await settled();
    expect(step).toHaveBeenCalledTimes(ERROR_WAITS_MS.length + 3);
    expect(runner.getState()).toMatchObject({
      status: "done",
      rewritten: [{ id: "a" }, { id: "b" }],
      failed: [failure("x")],
    });
  });

  it("同じリンク元が何度失敗として返っても、failed には 1 回だけ入れる", async () => {
    const { runner, settled } = setup([
      ok({ failed: [failure("x")], remaining: 1 }),
      ok({ failed: [failure("x"), failure("y")], remaining: 0 }),
    ]);
    runner.start(2);
    await settled();
    expect(runner.getState().failed).toEqual([failure("x"), failure("y")]);
  });

  it("試行の上限で title が無いまま失敗が返っても、前に分かった title を残す", async () => {
    const { runner, settled } = setup([
      ok({ failed: [failure("x")], remaining: 1 }),
      ok({ failed: [{ id: "x", title: null }], remaining: 0 }),
    ]);
    runner.start(2);
    await settled();
    expect(runner.getState().failed).toEqual([failure("x")]);
  });

  it("title の無い失敗はリンク元のページを読んで補い、title が分かった id は読み直さない", async () => {
    const { runner, pageTitle, settled } = setup(
      [
        ok({ failed: [{ id: "x", title: undefined }], remaining: 1 }),
        ok({
          failed: [
            { id: "x", title: undefined },
            { id: "y", title: undefined },
          ],
          remaining: 0,
        }),
      ],
      { x: "現在の題 x" },
    );
    runner.start(2);
    await settled();
    expect(runner.getState().failed).toEqual([
      { id: "x", title: "現在の題 x" },
      { id: "y", title: null },
    ]);
    expect(pageTitle.mock.calls.map(([id]) => id)).toEqual(["x", "y"]);
  });

  it("stop のあとは古いループの結果を書かない", async () => {
    let release: () => void = () => {};
    const { runner, step } = setup([]);
    step.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok({ processed: processed("a"), remaining: 1 }));
        }),
    );
    runner.start(2);
    runner.stop();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(step).toHaveBeenCalledTimes(1);
    expect(runner.getState().status).toBe("idle");
  });

  it("送り直しを待つ間に stop したら、待ち終えても step を送らない", async () => {
    let wake: () => void = () => {};
    const { runner, step, sleep } = setup([ok({ conflict: true, remaining: 1 })]);
    sleep.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
    );
    runner.start(1);
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
    runner.stop();
    wake();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(step).toHaveBeenCalledTimes(1);
    expect(runner.getState().status).toBe("idle");
  });

  it("suspend と resume は、失敗したページの一覧と止まった理由を残し、step を送らない", async () => {
    const { runner, step } = setup([
      ok({ processed: processed("a"), failed: [failure("x")], remaining: 1 }),
      { ok: false, kind: "unauthorized" },
    ]);
    runner.start(2);
    await vi.waitFor(() => expect(runner.getState().status).toBe("stopped"));
    runner.suspend();
    runner.resume();
    expect(runner.getState()).toMatchObject({
      status: "stopped",
      stopReason: "auth",
      failed: [failure("x")],
      rewritten: [{ id: "a" }],
    });
    expect(step).toHaveBeenCalledTimes(2);
  });

  it("suspend の間は start も再試行も step を送らず、resume でキューのジョブを送る", async () => {
    const { runner, step, settled } = setup([ok({ processed: processed("a"), remaining: 0 })]);
    runner.suspend();
    runner.start(1);
    runner.retry();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(step).not.toHaveBeenCalled();
    expect(runner.getState().status).toBe("idle");
    runner.resume();
    expect(runner.getState()).toMatchObject({ status: "running", done: 0, total: 1 });
    await settled();
    expect(step).toHaveBeenCalledTimes(1);
    expect(runner.getState()).toMatchObject({ status: "done", rewritten: [{ id: "a" }] });
  });

  it("通信中に suspend してもレスポンスは取り込み、次の step は resume まで送らない", async () => {
    let release: () => void = () => {};
    const { runner, step, settled } = setup([ok({ processed: processed("b"), remaining: 0 })]);
    step.mockImplementationOnce(async () => ok({ processed: processed("a"), remaining: 1 }));
    step.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve(
              ok({ processed: processed("late", "public"), failed: [failure("f")], remaining: 1 }),
            );
        }),
    );
    runner.start(3);
    await vi.waitFor(() => expect(step).toHaveBeenCalledTimes(2));
    runner.suspend();
    release();
    await vi.waitFor(() => expect(runner.getState().done).toBe(2));
    expect(step).toHaveBeenCalledTimes(2);
    expect(runner.getState()).toMatchObject({
      status: "running",
      done: 2,
      total: 3,
      failed: [failure("f")],
      rewritten: [{ id: "a" }, { id: "late", visibility: "public" }],
    });
    runner.resume();
    await settled();
    expect(step).toHaveBeenCalledTimes(3);
    expect(runner.getState()).toMatchObject({
      status: "done",
      done: 3,
      failed: [failure("f")],
      rewritten: [{ id: "a" }, { id: "late" }, { id: "b" }],
    });
  });

  it("通信中の step のレスポンスを待たずに resume しても、step を並べて送らない", async () => {
    let release: () => void = () => {};
    const { runner, step, settled } = setup([ok({ processed: processed("b"), remaining: 0 })]);
    step.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok({ processed: processed("a"), remaining: 1 }));
        }),
    );
    runner.start(2);
    runner.suspend();
    runner.resume();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(step).toHaveBeenCalledTimes(1);
    release();
    await settled();
    expect(step).toHaveBeenCalledTimes(2);
    expect(runner.getState()).toMatchObject({ status: "done", done: 2 });
  });

  it("suspend の間にレスポンスで残りが無くなれば、そのまま終わった結果を見せる", async () => {
    let release: () => void = () => {};
    const { runner, step } = setup([]);
    step.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok({ failed: [failure("f")], remaining: 0 }));
        }),
    );
    runner.start(1);
    runner.suspend();
    release();
    await vi.waitFor(() => expect(runner.getState().status).toBe("done"));
    expect(runner.getState().failed).toEqual([failure("f")]);
    runner.resume();
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("stop のあとに resume しても、止める前の結果は戻らない", async () => {
    const { runner, step } = setup([ok({ processed: processed("a"), remaining: 1 })]);
    runner.start(2);
    runner.suspend();
    runner.start(1);
    runner.stop();
    runner.resume();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runner.getState().status).toBe("idle");
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("書き換えたページを開いているエディタに知らせ、取り込みの完了は待たずに次を呼ぶ", async () => {
    const { runner, step, settled } = setup([
      ok({ processed: processed("a"), remaining: 1 }),
      ok({ processed: processed("b"), remaining: 0 }),
    ]);
    const told: string[] = [];
    const unregister = runner.register({
      // 保存の後ろに並んで終わらない取り込み
      linkRewritten: (p) => {
        told.push(p.sourcePageId);
        return new Promise<void>(() => {});
      },
    });
    runner.start(2);
    await settled();
    expect(step).toHaveBeenCalledTimes(2);
    expect(told).toEqual(["a", "b"]);
    unregister();
  });

  it("同じエディタを登録し直してから古い登録を外しても、新しい登録には知らせ続ける", async () => {
    const { runner, settled } = setup([ok({ processed: processed("a"), remaining: 0 })]);
    const told: string[] = [];
    const participant = {
      linkRewritten: async (p: { sourcePageId: string }) => void told.push(p.sourcePageId),
    };
    const first = runner.register(participant);
    runner.register(participant);
    first();
    runner.start(1);
    await settled();
    expect(told).toEqual(["a"]);
  });
});

const state = (patch: Partial<LinkRewriteState> = {}): LinkRewriteState => ({
  status: "running",
  done: 0,
  total: 0,
  rewritten: [],
  failed: [],
  stopReason: null,
  ...patch,
});

const idle = state({ status: "idle" });

describe("outcomeOf", () => {
  const zero = { conflicts: 0, errors: 0 };

  it("conflict でない応答は取り込む", () => {
    const value = { processed: processed("a"), conflict: false, failed: [], remaining: 1 };
    expect(outcomeOf({ ok: true, value }, { conflicts: 3, errors: 2 }, state())).toEqual({
      kind: "proceed",
      value,
    });
  });

  it("404 は何も見せずに終える", () => {
    expect(outcomeOf({ ok: false, kind: "not_found" }, zero, state({ done: 1 }))).toEqual({
      kind: "finish",
      state: idle,
    });
  });

  it("401 と 403 は、それまでの結果を残して auth で止める", () => {
    const current = state({ done: 1, total: 2, failed: [failure("x")] });
    for (const kind of ["unauthorized", "forbidden"] as const) {
      expect(outcomeOf({ ok: false, kind }, zero, current)).toEqual({
        kind: "finish",
        state: { ...current, status: "stopped", stopReason: "auth" },
      });
    }
  });

  it("通信の失敗は回数に応じて待ち、conflict の数は戻さない", () => {
    let counts = { conflicts: 2, errors: 0 };
    for (const ms of ERROR_WAITS_MS) {
      const outcome = outcomeOf({ ok: false, kind: "error" }, counts, state());
      if (outcome.kind !== "wait") throw new Error("待たなかった");
      expect(outcome.ms).toBe(ms);
      counts = outcome.counts;
    }
    expect(counts).toEqual({ conflicts: 2, errors: ERROR_WAITS_MS.length });
    expect(outcomeOf({ ok: false, kind: "error" }, counts, state({ done: 1 }))).toEqual({
      kind: "finish",
      state: state({ done: 1, status: "stopped", stopReason: "error" }),
    });
  });

  it("conflict は通信の失敗の数を戻して待ち、上限を超えたら止める", () => {
    const conflict = ok({ conflict: true, remaining: 1 });
    expect(outcomeOf(conflict, { conflicts: 0, errors: 2 }, state())).toEqual({
      kind: "wait",
      ms: CONFLICT_WAIT_MS,
      counts: { conflicts: 1, errors: 0 },
    });
    expect(outcomeOf(conflict, { conflicts: MAX_CONFLICTS - 1, errors: 0 }, state())).toEqual({
      kind: "wait",
      ms: CONFLICT_WAIT_MS,
      counts: { conflicts: MAX_CONFLICTS, errors: 0 },
    });
    expect(outcomeOf(conflict, { conflicts: MAX_CONFLICTS, errors: 0 }, state())).toEqual({
      kind: "finish",
      state: state({ status: "stopped", stopReason: "error" }),
    });
  });
});

describe("advance", () => {
  const value = (patch: Partial<LinkRewriteStepResult>): LinkRewriteStepResult => ({
    processed: null,
    conflict: false,
    failed: [],
    remaining: 0,
    ...patch,
  });

  it("何もキューに入っていないときの応答は処理に数えない", () => {
    expect(advance(state({ done: 2, total: 2 }), value({}), [])).toMatchObject({
      done: 2,
      total: 2,
    });
  });

  it("残りを見込んでいる間は、何も処理しなかった応答も 1 件に数える", () => {
    expect(advance(state({ done: 0, total: 1 }), value({}), [])).toMatchObject({
      done: 1,
      total: 1,
    });
  });

  it("書き換えたリンク元は前の記録を除いて末尾に足し、失敗は id ごとに 1 回だけ残す", () => {
    const before = state({
      done: 1,
      total: 3,
      rewritten: [
        { id: "a", title: "古い a", visibility: "draft" },
        { id: "b", title: "題 b", visibility: "draft" },
      ],
      failed: [failure("x")],
    });
    const next = advance(
      before,
      value({
        processed: processed("a", "public"),
        failed: [failure("x"), failure("y")],
        remaining: 1,
      }),
      [failure("x"), failure("y")],
    );
    expect(next).toMatchObject({
      done: 2,
      total: 3,
      rewritten: [
        { id: "b", title: "題 b", visibility: "draft" },
        { id: "a", title: "題 a", visibility: "public" },
      ],
      failed: [failure("x"), failure("y")],
    });
  });
});

describe("continuationOf", () => {
  const shown = state({
    status: "idle",
    rewritten: [{ id: "a", title: "題 a", visibility: "draft" }],
  });

  it("残りがあれば running にして続ける", () => {
    expect(continuationOf(shown, 1, true)).toEqual({
      kind: "running",
      state: { ...shown, status: "running" },
    });
  });

  it("残りが無くても、走っている間に start が来ていればそのまま確かめ直す", () => {
    expect(continuationOf(shown, 0, true)).toEqual({ kind: "rerun", state: shown });
  });

  it("終えるときは、見せる結果があれば done、無ければ何も見せない", () => {
    expect(continuationOf(shown, 0, false)).toEqual({
      kind: "finish",
      state: { ...shown, status: "done" },
    });
    const failedOnly = state({ failed: [failure("x")] });
    expect(continuationOf(failedOnly, 0, false)).toEqual({
      kind: "finish",
      state: { ...failedOnly, status: "done" },
    });
    expect(continuationOf(state({ done: 1, total: 1 }), 0, false)).toEqual({
      kind: "finish",
      state: idle,
    });
  });
});
