import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DONE_VISIBLE_MS, LinkRewriteStatus } from "./LinkRewriteStatus";
import { LinkRewriteRunner } from "./link-rewrites";
import type { LinkRewriteStepResult, StepResult } from "./link-rewrites-api";

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const stepOk = (value: Partial<LinkRewriteStepResult>): StepResult => ({
  ok: true,
  value: { processed: null, conflict: false, failed: [], remaining: 0, ...value },
});

const processed = (id: string) => ({
  sourcePageId: id,
  title: `題 ${id}`,
  visibility: "draft" as const,
  version: 2,
  rewritten: 1,
});

/** results を順に返す。尽きたら通信の失敗を返し続ける */
function setup(results: StepResult[]) {
  const queue = [...results];
  const step = vi.fn(
    async (): Promise<StepResult> => queue.shift() ?? { ok: false, kind: "error" },
  );
  const runner = new LinkRewriteRunner({ step, sleep: async () => {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<LinkRewriteStatus runner={runner} />));
  const settled = () =>
    vi.waitFor(() => {
      if (runner.getState().status === "running") throw new Error("まだ走っている");
    });
  return { runner, step, settled };
}

const text = () => container?.textContent ?? "";
/** 通知の中は silent で、live region は status の 1 つだけ */
const announcement = () => {
  const regions = [...document.querySelectorAll("[role='status'], [role='alert']")];
  expect(regions).toHaveLength(1);
  return regions[0]?.textContent;
};

describe("リンクの書き換えの通知", () => {
  it("読み上げは常にある status の文だけが担い、始まりと終わりで文が変わる", async () => {
    // 進み具合の更新は 1 ページごとに来る。通知自体が live region だと、そのたびに見出しと本文を読み直す
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const step = vi.fn(async (): Promise<StepResult> => {
      await gate;
      return stepOk({ processed: processed("a"), remaining: 0 });
    });
    const runner = new LinkRewriteRunner({ step, sleep: async () => {} });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<LinkRewriteStatus runner={runner} />));
    // 埋めたあとに読み上げられるよう、初めは空で置いてある
    expect(announcement()).toBe("");

    act(() => runner.start(2));
    expect(text()).toContain("0/2");
    await vi.waitFor(() => expect(announcement()).toBe("他のページのリンクを書き換えています"));
    expect(container.querySelector(".notice-main")?.getAttribute("role")).toBeNull();

    await act(async () => release());
    await vi.waitFor(() => expect(runner.getState().status).toBe("done"));
    await vi.waitFor(() => expect(announcement()).toBe("他のページのリンクを書き換えました"));
    expect(container.querySelector(".notice-main")?.getAttribute("role")).toBeNull();
  });

  it("止まったときも、同じ status の文が止まったことを伝える", async () => {
    const { runner, settled } = setup([]);
    act(() => runner.start(1));
    await act(async () => {
      await settled();
    });
    await vi.waitFor(() => expect(announcement()).toBe("他のページのリンクの書き換えを止めました"));
  });

  it("失敗の無い完了の報告は、閉じなくても一定時間で下がる", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { runner, settled } = setup([stepOk({ processed: processed("a"), remaining: 0 })]);
    act(() => runner.start(1));
    await act(async () => {
      await settled();
    });
    expect(text()).toContain("他のページのリンクを書き換えました");

    act(() => {
      vi.advanceTimersByTime(DONE_VISIBLE_MS + 1);
    });
    expect(runner.getState().status).toBe("idle");
    expect(text()).not.toContain("他のページのリンクを書き換えました");
  });

  it("書き換えたページの一覧を開いている間は下げない", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { runner, settled } = setup([stepOk({ processed: processed("a"), remaining: 0 })]);
    act(() => runner.start(1));
    await act(async () => {
      await settled();
    });
    const details = container?.querySelector("details");
    if (!details) throw new Error("一覧が無い");
    await act(async () => {
      // toggle は open の変更の後に別のタスクで届く
      const toggled = new Promise((resolve) =>
        details.addEventListener("toggle", resolve, { once: true }),
      );
      details.open = true;
      await toggled;
    });
    act(() => {
      vi.advanceTimersByTime(DONE_VISIBLE_MS * 3);
    });
    expect(runner.getState().status).toBe("done");
  });

  describe("読んでいる間は下げない", () => {
    async function doneReport() {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { runner, settled } = setup([stepOk({ processed: processed("a"), remaining: 0 })]);
      act(() => runner.start(1));
      await act(async () => {
        await settled();
      });
      return runner;
    }
    const notice = () => {
      const el = container?.querySelector(".notice");
      if (!el) throw new Error("通知が無い");
      return el;
    };
    const pass = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

    it("通知の中に focus がある間は下げず、外れたら数え直す", async () => {
      const runner = await doneReport();
      const inside = notice().querySelector<HTMLElement>("summary, button");
      if (!inside) throw new Error("focus できる要素が無い");
      act(() => inside.focus());
      pass(DONE_VISIBLE_MS * 3);
      expect(runner.getState().status).toBe("done");
      act(() => inside.blur());
      pass(DONE_VISIBLE_MS - 1);
      expect(runner.getState().status).toBe("done");
      pass(2);
      expect(runner.getState().status).toBe("idle");
    });

    it("pointer が乗っている間は下げず、離れたら数え直す", async () => {
      const runner = await doneReport();
      act(() => {
        notice().dispatchEvent(
          new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }),
        );
      });
      pass(DONE_VISIBLE_MS * 3);
      expect(runner.getState().status).toBe("done");
      act(() => {
        notice().dispatchEvent(
          new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
        );
      });
      pass(DONE_VISIBLE_MS + 1);
      expect(runner.getState().status).toBe("idle");
    });

    it("タブが見えていない間は下げず、戻ったら数え直す", async () => {
      const runner = await doneReport();
      let state: DocumentVisibilityState = "hidden";
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      try {
        act(() => void document.dispatchEvent(new Event("visibilitychange")));
        pass(DONE_VISIBLE_MS * 3);
        expect(runner.getState().status).toBe("done");
        state = "visible";
        act(() => void document.dispatchEvent(new Event("visibilitychange")));
        pass(DONE_VISIBLE_MS + 1);
        expect(runner.getState().status).toBe("idle");
      } finally {
        Reflect.deleteProperty(document, "visibilityState");
      }
    });
  });

  it("書き換えられなかったリンクがある報告は、閉じるまで残す", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { runner, settled } = setup([stepOk({ failed: ["x"], remaining: 0 })]);
    act(() => runner.start(1));
    await act(async () => {
      await settled();
    });
    act(() => {
      vi.advanceTimersByTime(DONE_VISIBLE_MS * 3);
    });
    expect(runner.getState().status).toBe("done");
    expect(text()).toContain("書き換えられなかったリンクがあります");
  });
});

describe("通信の失敗で止まった書き換え", () => {
  it("通信が戻った（online）ら、再試行を押さなくても続きから進める", async () => {
    const { runner, step, settled } = setup([]);
    act(() => runner.start(1));
    await act(async () => {
      await settled();
    });
    expect(runner.getState()).toMatchObject({ status: "stopped", stopReason: "error" });
    expect(text()).toContain("再試行");
    const calls = step.mock.calls.length;

    // 戻ったあとの step は成功して、残りが無くなる
    step.mockResolvedValueOnce(stepOk({ processed: processed("a"), remaining: 0 }));
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await settled();
    });
    expect(step.mock.calls.length).toBe(calls + 1);
    expect(runner.getState().status).toBe("done");
  });

  it("ログインが切れて止まったときは、online で呼び直さない", async () => {
    const { runner, step, settled } = setup([{ ok: false, kind: "unauthorized" }]);
    act(() => runner.start(1));
    await act(async () => {
      await settled();
    });
    expect(runner.getState()).toMatchObject({ status: "stopped", stopReason: "auth" });
    const calls = step.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(step.mock.calls.length).toBe(calls);
  });
});
