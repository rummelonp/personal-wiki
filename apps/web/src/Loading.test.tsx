import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ListSkeleton, PageSkeleton, setLoadingDelay } from "./Loading";

let root: Root | null = null;
let container: HTMLElement | null = null;
let restoreDelay: (() => void) | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  restoreDelay?.();
  restoreDelay = null;
});

function mount(element: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

const painted = () => container?.querySelector(".skeleton-painted .skeleton") !== null;
const busy = () => container?.querySelector("[aria-busy='true']") !== null;
const status = () => container?.querySelector("[role='status']")?.textContent;

describe("読み込み中の帯", () => {
  it("遅れの間は帯を描かず、取得中であることは最初から、「読み込み中…」は frame を空けて伝える", () => {
    vi.useFakeTimers();
    mount(<PageSkeleton />);
    expect(busy()).toBe(true);
    expect(painted()).toBe(false);

    act(() => vi.advanceTimersByTime(249));
    expect(painted()).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(painted()).toBe(true);
  });

  it("「ページを読み込み中…」の status は空で取り付け、frame を空けて文字を入れる。aria-busy の外に置く", () => {
    vi.useFakeTimers();
    mount(<PageSkeleton />);
    // 取り付けと同じ描画の更新では文字を入れない（中身を持ったまま挿入すると読まれない）
    expect(container?.querySelector("[role='status']")).not.toBeNull();
    expect(status()).toBe("");

    act(() => vi.advanceTimersByTime(40));
    expect(status()).toBe("ページを読み込み中…");
    expect(container?.querySelector("[aria-busy='true'] [role='status']")).toBeNull();
  });

  it("一覧の帯は一覧を、行き先の分からない帯は対象を言わずに読み込み中と伝える", () => {
    vi.useFakeTimers();
    mount(<ListSkeleton />);
    act(() => vi.advanceTimersByTime(40));
    expect(status()).toBe("一覧を読み込み中…");
    act(() => root?.render(<ListSkeleton status="読み込み中…" />));
    expect(status()).toBe("読み込み中…");
  });

  it("文字を入れる前に取り除けば、文字を入れない", () => {
    vi.useFakeTimers();
    mount(<PageSkeleton />);
    act(() => root?.render(<p>届いた</p>));
    act(() => vi.advanceTimersByTime(100));
    expect(container?.querySelector("[role='status']")).toBeNull();
  });

  it("遅れを 0 にすると、最初の描画から帯を描く", () => {
    restoreDelay = setLoadingDelay(0);
    mount(<ListSkeleton />);
    expect(painted()).toBe(true);
  });

  it("遅れの前に取り除けば、帯を描かない", () => {
    vi.useFakeTimers();
    mount(<ListSkeleton />);
    act(() => vi.advanceTimersByTime(100));
    act(() => root?.render(<p>届いた</p>));
    act(() => vi.advanceTimersByTime(1000));
    expect(painted()).toBe(false);
  });

  it("帯を描いた後に別の帯へ差し替わっても、遅れを数え直さない", () => {
    vi.useFakeTimers();
    mount(<ListSkeleton />);
    act(() => vi.advanceTimersByTime(250));
    expect(painted()).toBe(true);
    act(() => root?.render(<PageSkeleton />));
    expect(painted()).toBe(true);
  });

  it("待ちが終わった後の次の待ちは、遅れを数え直す", () => {
    vi.useFakeTimers();
    mount(<ListSkeleton />);
    act(() => vi.advanceTimersByTime(250));
    act(() => root?.render(<p>届いた</p>));
    act(() => vi.advanceTimersByTime(10));
    act(() => root?.render(<PageSkeleton />));
    expect(painted()).toBe(false);
  });

  it("title が分かっていれば、帯でなく文字で出す", () => {
    restoreDelay = setLoadingDelay(0);
    mount(<PageSkeleton title="行き先の題" />);
    expect(container?.querySelector(".note-title")?.textContent).toBe("行き先の題");
    expect(container?.querySelector(".note-title .skeleton")).toBeNull();
  });

  it("匿名の画面には公開の行が無いので、その帯も出さない", () => {
    restoreDelay = setLoadingDelay(0);
    mount(<PageSkeleton owner={false} />);
    expect(container?.querySelector(".skeleton-meta")).toBeNull();
    expect(container?.querySelector(".skeleton-body")).not.toBeNull();
  });
});
