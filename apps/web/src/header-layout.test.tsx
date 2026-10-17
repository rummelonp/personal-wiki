import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page as browserPage } from "vitest/browser";
import { NO_FEATURES } from "./api";
import { Header } from "./Header";
import "./theme.css";
import "./styles.css";

// サイト名の上限（40 文字）いっぱいの、区切りの少ない名前
vi.mock("./site-name", () => ({ SITE_NAME: "Rummelonp's Personal Knowledge Wiki Home" }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mountHeader(query: string) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <Header
        session={{ status: "ready", me: { kind: "owner", features: NO_FEATURES } }}
        loggingOut={false}
        onLogout={() => {}}
        query={query}
        onOpenSearch={() => {}}
      />,
    ),
  );
  const find = (selector: string) => {
    const found = container?.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`${selector} が無い`);
    return found;
  };
  return find;
}

describe.each([320, 375, 1280])("長いサイト名のヘッダー（%dpx）", (width) => {
  it.each(["", "検索語"])(
    "ブランドを省略し、検索と操作を画面の中に収める（検索語: %j）",
    async (query) => {
      await browserPage.viewport(width, 800);
      const find = mountHeader(query);
      const text = find(".brand-text");
      const viewportWidth = document.documentElement.clientWidth;

      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewportWidth);
      expect(find(".header-actions").getBoundingClientRect().right).toBeLessThanOrEqual(
        viewportWidth,
      );
      expect(find(".header-search").getBoundingClientRect().left).toBeGreaterThanOrEqual(
        find(".brand").getBoundingClientRect().right - 0.5,
      );
      if (width < 600) expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
    },
  );
});

describe.each([320, 375])("検索語を出すヘッダー（%dpx）", (width) => {
  it("ロゴが先に縮み、短めの検索語は省略せずに出す", async () => {
    await browserPage.viewport(width, 800);
    const find = mountHeader("どこにも無い語句");
    const text = find(".header-search-text");
    expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth);
    // ロゴは縮み切っても、下限の幅は残す
    const brand = find(".brand").getBoundingClientRect().width;
    expect(brand).toBeGreaterThanOrEqual(
      Number.parseFloat(getComputedStyle(find(".brand")).minWidth),
    );
  });
});
