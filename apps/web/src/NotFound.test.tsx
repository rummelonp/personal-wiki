import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page as screen } from "vitest/browser";
import { MissingPage } from "./NotFound";
import { listBacklinksByTitle } from "./pages-api";

vi.mock("./pages-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pages-api")>();
  return { ...actual, listBacklinksByTitle: vi.fn() };
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.mocked(listBacklinksByTitle).mockResolvedValue({
    ok: true,
    value: { pages: [], nextCursor: null },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

async function renderMissing(owner: boolean) {
  const onSettled = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<MissingPage title="まだ無い" owner={owner} onSettled={onSettled} />);
  });
  await vi.waitFor(() => expect(onSettled).toHaveBeenCalled());
  return container;
}

describe("MissingPage", () => {
  it("本文の領域は、見出しの title を名前に持つ article として読める", async () => {
    await renderMissing(true);
    expect(screen.getByRole("article", { name: "まだ無い", exact: true }).element()).not.toBeNull();
  });

  it("匿名には、リンク元が 0 件のとき「このページへのリンク」の節ごと出さない", async () => {
    const view = await renderMissing(false);
    expect(view.querySelector(".rail-section-links")).toBeNull();
    expect(view.textContent).not.toContain("このページへのリンク");
    expect(view.textContent).toContain("まだ作られていないか、公開されていないページです。");
  });

  it("owner には、リンク元が 0 件でも節と「ありません」を出す", async () => {
    const view = await renderMissing(true);
    const section = view.querySelector(".rail-section-links");
    expect(section?.textContent).toContain("このページへのリンク");
    expect(section?.textContent).toContain("ありません。");
  });

  it("匿名にも、リンク元があれば節を出す", async () => {
    vi.mocked(listBacklinksByTitle).mockResolvedValue({
      ok: true,
      value: {
        pages: [
          {
            id: "BBBBBBBBBBBBBBBBBBBBBB",
            title: "張っているページ",
            visibility: "public",
            updatedAt: 0,
          },
        ],
        nextCursor: null,
      },
    });
    const view = await renderMissing(false);
    await vi.waitFor(() =>
      expect(view.querySelector(".rail-section-links")?.textContent).toContain("張っているページ"),
    );
  });
});
