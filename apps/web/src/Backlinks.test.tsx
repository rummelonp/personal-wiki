import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Backlinks } from "./Backlinks";
import { setLoadingDelay } from "./Loading";
import { type ApiResult, listBacklinks, listBacklinksByTitle } from "./pages-api";

vi.mock("./pages-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pages-api")>();
  return { ...actual, listBacklinks: vi.fn(), listBacklinksByTitle: vi.fn() };
});

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });

let root: Root | null = null;
let container: HTMLElement | null = null;
let restoreDelay: (() => void) | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  restoreDelay = setLoadingDelay(0);
  vi.mocked(listBacklinks).mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  restoreDelay?.();
  vi.clearAllMocks();
});

async function mount(hideEmpty: boolean) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(<Backlinks target={{ pageId: "AAAAAAAAAAAAAAAAAAAAAA" }} hideEmpty={hideEmpty} />),
  );
}

describe("Backlinks の取得中", () => {
  it("2 行の帯を出し、取得中であることと「読み込み中…」を支援技術に伝える", async () => {
    await mount(false);
    const pending = container?.querySelector(".skeleton-links");
    expect(pending?.getAttribute("aria-busy")).toBe("true");
    expect(pending?.querySelectorAll(".skeleton").length).toBe(2);
    expect(pending?.querySelector("[role='status']")?.textContent).toBe("読み込み中…");
    expect(container?.querySelector(".muted")).toBeNull();
  });

  it("hideEmpty の間は、取得中に節ごと出さない", async () => {
    await mount(true);
    expect(container?.querySelector(".rail-section")).toBeNull();
  });

  it("届いたら帯を外してリンクを出す", async () => {
    vi.mocked(listBacklinks).mockResolvedValue(
      ok({
        pages: [{ id: "BBBBBBBBBBBBBBBBBBBBBB", title: "元", visibility: "public", updatedAt: 0 }],
        nextCursor: null,
      }),
    );
    await mount(false);
    await vi.waitFor(() =>
      expect(container?.querySelector(".rail-list a")?.textContent).toBe("元"),
    );
    expect(container?.querySelector(".skeleton-links")).toBeNull();
  });
});

describe("Backlinks の title での取得", () => {
  async function mountTitle(onSettled: () => void) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(<Backlinks target={{ title: "Ruby" }} onSettled={onSettled} />),
    );
  }

  it("title で引き、届いた後に onSettled を 1 回呼び、0 件なら「ありません」と出す", async () => {
    vi.mocked(listBacklinksByTitle).mockResolvedValue(ok({ pages: [], nextCursor: null }));
    const onSettled = vi.fn();
    await mountTitle(onSettled);
    await vi.waitFor(() =>
      expect(container?.querySelector(".muted")?.textContent).toBe("ありません。"),
    );
    expect(listBacklinksByTitle).toHaveBeenCalledWith("Ruby", null);
    expect(listBacklinks).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("取得中は onSettled を呼ばない", async () => {
    vi.mocked(listBacklinksByTitle).mockReturnValue(new Promise(() => {}));
    const onSettled = vi.fn();
    await mountTitle(onSettled);
    expect(container?.querySelector(".skeleton-links")).not.toBeNull();
    expect(onSettled).not.toHaveBeenCalled();
  });
});
