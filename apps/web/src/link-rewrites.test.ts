import { describe, expect, it, vi } from "vitest";
import {
  ERROR_WAITS_MS,
  LinkRewriteRunner,
  type LinkRewriteState,
  MAX_CONFLICTS,
} from "./link-rewrites";
import type { LinkRewriteStepResult, StepResult } from "./link-rewrites-api";

const ok = (value: Partial<LinkRewriteStepResult>): StepResult => ({
  ok: true,
  value: { processed: null, conflict: false, failed: [], remaining: 0, ...value },
});

const processed = (id: string, visibility: "public" | "draft" = "draft") => ({
  sourcePageId: id,
  title: `題 ${id}`,
  visibility,
  version: 2,
  rewritten: 1,
});

function setup(results: StepResult[]) {
  const step = vi.fn(async () => {
    const next = results.shift();
    if (next === undefined) throw new Error("想定より多く呼んだ");
    return next;
  });
  const sleep = vi.fn(async (_ms: number) => {});
  const runner = new LinkRewriteRunner({ step, sleep });
  const states: LinkRewriteState[] = [];
  runner.subscribe(() => states.push(runner.getState()));
  const settled = () =>
    vi.waitFor(() => {
      if (runner.getState().status === "running") throw new Error("まだ走っている");
    });
  return { runner, step, sleep, states, settled };
}

describe("LinkRewriteRunner", () => {
  it("残りが 0 になるまで 1 ページずつ呼び、書き換えたページを公開・下書きつきで残す", async () => {
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
      ok({ failed: ["x"], remaining: 1 }),
      ok({ processed: processed("a"), remaining: 0 }),
    ]);
    runner.start(2);
    await settled();
    expect(runner.getState()).toMatchObject({ status: "done", done: 2, failed: ["x"] });
  });

  it("何も積まれていなければ 1 回呼ぶだけで何も見せない（起動時の再開）", async () => {
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

  it("開いているエディタの列の中で step を呼ぶ", async () => {
    const { runner, settled } = setup([ok({ processed: processed("a"), remaining: 0 })]);
    const order: string[] = [];
    runner.register({
      runLinkRewriteStep: async (step) => {
        order.push("enter");
        const result = await step();
        order.push(`exit ${result.processed?.sourcePageId}`);
        return result;
      },
    });
    runner.start(1);
    await settled();
    expect(order).toEqual(["enter", "exit a"]);
  });
});
