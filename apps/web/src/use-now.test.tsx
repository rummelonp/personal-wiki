import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribe, useNow } from "./use-now";

function Clock() {
  return <output>{useNow()}</output>;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 17, 12, 0, 30));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

const mount = (count: 1 | 3) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <>
        <Clock />
        {count === 3 && (
          <>
            <Clock />
            <Clock />
          </>
        )}
      </>,
    ),
  );
};

const shown = () => [...(container?.querySelectorAll("output") ?? [])].map((o) => o.textContent);

describe("useNow", () => {
  it("分の頭に丸めた時刻を返し、次の分になると更新する", () => {
    mount(1);
    const first = new Date(2026, 9, 17, 12, 0, 0).getTime();
    expect(shown()).toEqual([String(first)]);
    act(() => vi.advanceTimersByTime(29 * 1000));
    expect(shown()).toEqual([String(first)]);
    act(() => vi.advanceTimersByTime(2 * 1000));
    expect(shown()).toEqual([String(first + 60_000)]);
  });

  it("購読者が増えても timer は 1 つで、全員が同じ時刻に更新される", () => {
    mount(3);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(31 * 1000));
    expect(new Set(shown()).size).toBe(1);
  });

  it("画面に戻ったときに、止まっていた分を取り戻す", () => {
    mount(1);
    const before = shown();
    // timer を進めずに時計だけを進める（背景のタブで timer が間引かれた状態）
    vi.setSystemTime(new Date(2026, 9, 17, 12, 10, 0));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(shown()).not.toEqual(before);
  });

  it("購読者がいなくなると timer を止める", () => {
    mount(3);
    act(() => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("画面が隠れる向きの変化では取り戻さない", () => {
    mount(1);
    const before = shown();
    vi.setSystemTime(new Date(2026, 9, 17, 12, 10, 0));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    visibility.mockRestore();
    expect(shown()).toEqual(before);
  });

  it("window が focus を取り戻したときに、止まっていた分を取り戻す", () => {
    mount(1);
    const before = shown();
    vi.setSystemTime(new Date(2026, 9, 17, 12, 10, 0));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(shown()).not.toEqual(before);
    expect(shown()).toEqual([String(new Date(2026, 9, 17, 12, 10, 0).getTime())]);
  });

  it("全員が購読をやめた後に購読し直しても、timer は 1 つで、分の境目で更新する", () => {
    mount(3);
    act(() => root?.unmount());
    container?.remove();
    expect(vi.getTimerCount()).toBe(0);

    act(() => vi.advanceTimersByTime(20 * 1000));
    mount(1);
    expect(vi.getTimerCount()).toBe(1);
    const first = shown();
    act(() => vi.advanceTimersByTime(10 * 1000));
    expect(shown()).toEqual(first);
    act(() => vi.advanceTimersByTime(60 * 1000));
    expect(shown()).not.toEqual(first);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("購読をやめた後は、画面の復帰と focus を受け取らない", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    listener.mockClear();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).not.toHaveBeenCalled();
  });

  describe("通知の途中で購読が変わる", () => {
    const toNextMinute = () => vi.advanceTimersByTime(31 * 1000);

    it("全員が購読をやめて同期に購読し直しても、timer は 1 つのまま", () => {
      let unsubscribe = () => {};
      // 通知の途中で足した購読者も同じ通知で呼ばれるので、1 回だけ入れ替える
      let swapped = false;
      const resubscribe = vi.fn(() => {
        if (swapped) return;
        swapped = true;
        unsubscribe();
        unsubscribe = subscribe(() => {});
      });
      unsubscribe = subscribe(resubscribe);
      expect(vi.getTimerCount()).toBe(1);

      toNextMinute();
      expect(resubscribe).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      toNextMinute();
      toNextMinute();
      expect(vi.getTimerCount()).toBe(1);
      unsubscribe();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("全員が購読をやめたら、次の timer を登録しない", () => {
      const unsubscribe = subscribe(() => unsubscribe());
      expect(vi.getTimerCount()).toBe(1);

      toNextMinute();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
