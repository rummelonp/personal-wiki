import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useNow } from "./use-now";

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
});
