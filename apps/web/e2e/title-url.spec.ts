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

/**
 * 一覧を開いてから、SPA の中で path へ移る。ブラウザが同じ文書の中で進むときと同じく popstate で移り、
 * 一覧の行やリンクの onClick（移る前に title の表記を覚える）を通らない。
 * public のページを直接開くと HTML に入っていたページで出て取得しないので、取得中の画面はこの経路で出す。
 */
async function openInApp(page: Page, path: string): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".entries .entry").first()).toBeVisible();
  await page.evaluate((next) => {
    history.pushState(null, "", next);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

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

  test("覚えていない title の URL へ移った取得中のスケルトンは `_` でつないだ URL を空白にした title で出し、取得後は本当の title になる", async ({
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

    const skeletonTitle = (target: Page) => target.locator(".note[aria-busy='true'] .note-title");
    await openInApp(page, underscored(spaced));
    await expect(skeletonTitle(page)).toHaveText(spaced);

    // `_` を含む title も、覚えていなければ取得中は空白で出て、取得後に本当の title になる
    const reopened = await page.context().newPage();
    await reopened.route(
      (url) => url.pathname === "/api/pages/by-title",
      async (route) => {
        await gate;
        await route.continue().catch(() => {});
      },
    );
    await openInApp(reopened, `/${encodeURIComponent(snake)}`);
    await expect(skeletonTitle(reopened)).toHaveText(snake.replaceAll("_", " "));

    release();
    await expect(skeletonTitle(page)).toHaveCount(0);
    await expect(skeletonTitle(reopened)).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: spaced, exact: true })).toBeVisible();
    await expect(
      reopened.getByRole("heading", { level: 1, name: snake, exact: true }),
    ).toBeVisible();
  });
});
