import type { Page, TestInfo } from "@playwright/test";
import { expect, test, uniqueTitle } from "./support/fixtures";
import { E2E_ORIGIN } from "./support/stack";

/*
 * title の URL は空白を `_` で表す。title_key は `_` と空白を同じ文字として扱うので、`_` を含む title も
 * そのまま `/<title>` で開け、空白を `%20` にした以前の URL も開いて新しい形に置き換わる。
 */

const underscored = (title: string) => `/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
const pathname = (page: Page) => new URL(page.url()).pathname;
const canonical = (page: Page) => page.locator('link[rel="canonical"]').getAttribute("href");

/** 空白を含まず `_` を含む title。 */
const snakeTitle = (testInfo: TestInfo) => uniqueTitle(testInfo, "下線_入り").replace(/\s+/g, "_");

test.describe("owner", () => {
  test("空白を含む title の公開ページは、空白を `_` にした URL になる", async ({
    page,
    api,
  }, testInfo) => {
    const title = uniqueTitle(testInfo, "空白 入り");
    const created = await api.createPage({ title, body: "本文", visibility: "public" });
    await page.goto(`/p/${created.id}`);
    await expect(page.locator(".title-input")).toHaveText(title);
    await expect.poll(() => pathname(page)).toBe(underscored(title));
    expect(pathname(page)).not.toContain("%20");
  });
});

test.describe("anonymous", () => {
  test.use({ role: "anonymous" });

  test("`_` を含む title は `/<title>` で開け、URL も見出しも変わらない", async ({
    page,
    api,
  }, testInfo) => {
    const title = snakeTitle(testInfo);
    await api.createPage({ title, body: "本文", visibility: "public" });
    const path = `/${encodeURIComponent(title)}`;
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
    expect(pathname(page)).toBe(path);
    expect(await canonical(page)).toBe(`${E2E_ORIGIN}${path}`);
  });

  test("空白を `%20` にした以前の URL も開け、`_` の URL に置き換わる", async ({
    page,
    api,
  }, testInfo) => {
    const title = uniqueTitle(testInfo, "以前の URL");
    await api.createPage({ title, body: "本文", visibility: "public" });
    const old = `/${encodeURIComponent(title)}`;
    expect(old).toContain("%20");
    await page.goto(old);
    await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
    await expect.poll(() => pathname(page)).toBe(underscored(title));
    expect(await canonical(page)).toBe(`${E2E_ORIGIN}${underscored(title)}`);
  });

  test("`_` にすると別のページを引く title は、空白のままの URL で正しいページが開く", async ({
    page,
    api,
  }, testInfo) => {
    // "x ¨" の title_key と "x_¨" の title_key は違い、2 つのページは並べて作れる
    const base = uniqueTitle(testInfo, "記号").replace(/\s+/g, "-");
    const spaced = `${base} ¨`;
    const snake = `${base}_¨`;
    await api.createPage({ title: spaced, body: "本文", visibility: "public" });
    await api.createPage({ title: snake, body: "本文", visibility: "public" });
    for (const title of [spaced, snake]) {
      const path = `/${encodeURIComponent(title)}`;
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
      expect(pathname(page)).toBe(path);
      expect(await canonical(page)).toBe(`${E2E_ORIGIN}${path}`);
    }
  });

  test("直接開いた取得中のスケルトンは `_` でつないだ URL を空白にした title で出し、取得後は本当の title になる", async ({
    page,
    api,
  }, testInfo) => {
    const spaced = uniqueTitle(testInfo, "取得中 空白");
    const snake = snakeTitle(testInfo);
    await api.createPage({ title: spaced, body: "本文", visibility: "public" });
    await api.createPage({ title: snake, body: "本文", visibility: "public" });

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname === "/api/pages/by-title",
      async (route) => {
        await gate;
        await route.continue().catch(() => {});
      },
    );

    await page.goto(underscored(spaced), { waitUntil: "commit" });
    await expect(page.locator(".note-title")).toHaveText(spaced);

    // `_` を含む title も、覚えていなければ取得中は空白で出て、取得後に本当の title になる
    const reopened = await page.context().newPage();
    await reopened.route(
      (url) => url.pathname === "/api/pages/by-title",
      async (route) => {
        await gate;
        await route.continue().catch(() => {});
      },
    );
    await reopened.goto(`/${encodeURIComponent(snake)}`, { waitUntil: "commit" });
    await expect(reopened.locator(".note-title")).toHaveText(snake.replaceAll("_", " "));

    release();
    await expect(page.getByRole("heading", { level: 1, name: spaced, exact: true })).toBeVisible();
    await expect(
      reopened.getByRole("heading", { level: 1, name: snake, exact: true }),
    ).toBeVisible();
  });
});
