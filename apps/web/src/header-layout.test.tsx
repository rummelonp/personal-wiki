/// <reference types="@vitest/browser-playwright" />
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page as browserPage, cdp } from "vitest/browser";
import { NO_FEATURES } from "./api";
import { Header } from "./Header";
import "./theme.css";
import "./styles.css";

// サイト名の上限（40 文字）いっぱいの、区切りの少ない名前
const LONG_SITE_NAME = "Rummelonp's Personal Knowledge Wiki Home";
vi.mock("./site-name", () => ({ SITE_NAME: "Rummelonp's Personal Knowledge Wiki Home" }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
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
        session={{
          status: "ready",
          me: { kind: "owner", features: { ...NO_FEATURES, oauth: true } },
        }}
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
    // owner の操作は 4 つ。320px で検索語に残る幅は 100px 前後なので、字数はそこに収まる範囲に置く
    const find = mountHeader("どこにも無い");
    const text = find(".header-search-text");
    expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth);
    // ロゴは縮み切っても、下限の幅は残す
    const brand = find(".brand").getBoundingClientRect().width;
    expect(brand).toBeGreaterThanOrEqual(
      Number.parseFloat(getComputedStyle(find(".brand")).minWidth),
    );
  });
});

/** タッチ端末のエミュレーションで、CSS の `@media (pointer: coarse)` を有効にする */
async function emulateCoarsePointer() {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  expect(matchMedia("(pointer: coarse)").matches).toBe(true);
}

describe.each([320, 375])("タッチ端末の長いサイト名のヘッダー（%dpx）", (width) => {
  it.each(["", "検索語"])(
    "ロゴの当たり判定を 44px 以上にしつつ、名前を省略して画面の中に収める（検索語: %j）",
    async (query) => {
      await emulateCoarsePointer();
      await browserPage.viewport(width, 800);
      const find = mountHeader(query);
      const brand = find(".brand");
      const text = find(".brand-text");
      const viewportWidth = document.documentElement.clientWidth;
      const tapSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 2.75;

      expect(getComputedStyle(brand).display).toMatch(/flex/);
      expect(brand.getBoundingClientRect().height).toBeGreaterThanOrEqual(tapSize);
      expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewportWidth);
      expect(find(".header-actions").getBoundingClientRect().right).toBeLessThanOrEqual(
        viewportWidth,
      );
      expect(find(".header-search").getBoundingClientRect().left).toBeGreaterThanOrEqual(
        brand.getBoundingClientRect().right - 0.5,
      );
    },
  );
});

describe("省略したサイト名の全文", () => {
  it("省略している幅では title に全文を入れ、収まる幅では入れない", async () => {
    await browserPage.viewport(375, 800);
    const find = mountHeader("");
    const text = find(".brand-text");
    await vi.waitFor(() => expect(text.title).toBe(LONG_SITE_NAME));

    await browserPage.viewport(1280, 800);
    await vi.waitFor(() => expect(text.title).toBe(""));
    expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth);

    await browserPage.viewport(320, 800);
    await vi.waitFor(() => expect(text.title).toBe(LONG_SITE_NAME));
  });

  it("支援技術にはリンクの名前として全文を渡し、同じ文字を説明として重ねない", async () => {
    await browserPage.viewport(375, 800);
    const find = mountHeader("");
    await vi.waitFor(() => expect(find(".brand-text").title).toBe(LONG_SITE_NAME));

    // getByRole は DOM から名前を計算する近似なので、ブラウザが AX ツリーに出す名前と説明を直接読む
    type AXValue = { value?: unknown };
    type AXNode = { ignored: boolean; role?: AXValue; name?: AXValue; description?: AXValue };
    type FrameTree = { frame: { id: string; url: string }; childFrames?: FrameTree[] };
    // テストは Vitest の iframe の中で動き、CDP の session は外の page に付く。frameId を渡さないと外の
    // page のツリーしか返らない
    const findFrame = (tree: FrameTree): string | undefined =>
      tree.frame.url === location.href
        ? tree.frame.id
        : tree.childFrames?.map(findFrame).find((id) => id !== undefined);
    const { frameTree } = (await cdp().send("Page.getFrameTree")) as { frameTree: FrameTree };
    const frameId = findFrame(frameTree);
    if (!frameId) throw new Error("the test frame is not found");
    await cdp().send("Accessibility.enable");
    try {
      const { nodes } = (await cdp().send("Accessibility.getFullAXTree", { frameId })) as {
        nodes: AXNode[];
      };
      const links = nodes.filter((node) => node.role?.value === "link" && !node.ignored);
      // owner のヘッダーには、サイト名のほかに接続の一覧へのリンクがある
      expect(links.map((node) => node.name?.value)).toEqual([LONG_SITE_NAME, "許可した接続"]);
      expect(links[0]?.description?.value ?? "").toBe("");
    } finally {
      await cdp().send("Accessibility.disable");
    }
  });
});
