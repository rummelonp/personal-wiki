import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";

/*
 * 一覧（タグで絞った一覧を含む）を途中までスクロールしてページを開き、戻ったとき、スクロール位置が
 * 戻ること。戻るで一覧を取り直す間に画面が縮むと、ブラウザの復元が位置を 0 に丸めてしまう。
 */

const SCROLL = 500;
const TOLERANCE = 40;

const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));

/** 画面内に見えている最初の行のタイトルを、座標のクリックで開く（クリックによるスクロールを避ける）。 */
async function openVisibleEntry(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const headerBottom =
      document.querySelector("header.header")?.getBoundingClientRect().bottom ?? 0;
    for (const link of document.querySelectorAll(".entries .entry-title")) {
      const rect = link.getBoundingClientRect();
      if (rect.top > headerBottom && rect.bottom < window.innerHeight) {
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    }
    return null;
  });
  expect(point, "画面内に見えている行がある").not.toBeNull();
  const { x, y } = point as { x: number; y: number };
  await page.mouse.click(x, y);
}

for (const [label, path] of [
  ["最近の更新", "/"],
  ["タグで絞った一覧", `/?tag=${encodeURIComponent("メモ")}`],
] as const) {
  test(`${label}をスクロールしてページを開き、戻ると位置が戻る`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    const scrollable = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(scrollable, "一覧がスクロールできる長さ").toBeGreaterThan(SCROLL);

    await page.evaluate((y) => window.scrollTo(0, y), SCROLL);
    await expect.poll(() => scrollY(page)).toBe(SCROLL);
    const listUrl = page.url();
    await openVisibleEntry(page);
    await expect(page.locator("h1.note-title, .title-input").first()).toBeVisible();
    expect(page.url()).not.toBe(listUrl);

    await page.goBack();
    await expect(page).toHaveURL(listUrl);
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await expect.poll(() => scrollY(page)).toBeGreaterThan(SCROLL - TOLERANCE);
    await expect.poll(() => scrollY(page)).toBeLessThan(SCROLL + TOLERANCE);
  });
}
