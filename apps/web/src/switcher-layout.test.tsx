import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setLoadingDelay } from "./Loading";
import { listPageTitles } from "./pages-api";
import { QuickSwitcher } from "./QuickSwitcher";
import "./theme.css";
import "./styles.css";

vi.mock("./pages-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pages-api")>();
  return { ...actual, listPageTitles: vi.fn() };
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;
let restoreDelay: (() => void) | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  restoreDelay?.();
  restoreDelay = null;
  vi.clearAllMocks();
});

const nextFrames = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });

describe("quick switcher の案内の位置", () => {
  it("取得中に開いた描画の案内を status へ移しても、案内の縦の位置が変わらない", async () => {
    restoreDelay = setLoadingDelay(0);
    vi.mocked(listPageTitles).mockReturnValue(new Promise(() => {}));
    container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    act(() =>
      mounted.render(
        <QuickSwitcher open onOpenChange={() => {}} owner={false} initialQuery="メモ" />,
      ),
    );
    const guidance = (selector: string) =>
      [...(container?.querySelectorAll<HTMLElement>(`${selector} p`) ?? [])].find((p) =>
        p.textContent?.includes("文字以上"),
      );
    const before = guidance("[aria-hidden='true']");
    expect(before).toBeDefined();
    const top = before?.getBoundingClientRect().top;

    await nextFrames();
    const after = guidance("[role='status']");
    expect(after).toBeDefined();
    expect(after?.getBoundingClientRect().top).toBe(top);
  });
});
