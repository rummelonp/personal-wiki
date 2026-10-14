import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalScroll, test } from "./support/fixtures";
import { SEED } from "./support/seed";

/*
 * 画面ごとに幅を切り替え、どの幅でも横スクロールが出ないことを確かめる。
 * iPhone 幅の WebKit そのものでの確認は、匿名のジャーニー（anonymous.spec.ts）が受け持つ。
 */

const WIDTHS = [320, 375, 768, 1280, 1440];
async function sweepWidths(page: Page, widths = WIDTHS): Promise<void> {
  for (const width of widths) {
    await test.step(`${width}px`, async () => {
      await page.setViewportSize({ width, height: 800 });
      await expectNoHorizontalScroll(page);
    });
  }
}

test.describe("owner @widths", () => {
  test("トップの一覧", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await sweepWidths(page);
  });

  test("検索の結果", async ({ page }) => {
    await page.goto(`/?q=${encodeURIComponent("メモ")}`);
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await sweepWidths(page);
  });

  for (const title of [SEED.server, SEED.database, SEED.longTitle, SEED.manyTags, SEED.longPage]) {
    test(`ページの編集: ${title}`, async ({ page, seedIds }) => {
      await page.goto(`/p/${seedIds[title]}`);
      await expect(page.locator(".title-input")).toHaveText(title);
      await sweepWidths(page);
    });
  }

  test("新規作成の画面", async ({ page }) => {
    await page.goto("/?new");
    await expect(page.locator(".title-input .cm-content")).toBeVisible();
    await sweepWidths(page);
  });

  test("quick switcher を開いた画面", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "ページを検索" }).click();
    await page
      .getByRole("dialog", { name: "ページを検索" })
      .getByRole("combobox", { name: "ページを検索" })
      .fill("メモ");
    await expect(page.getByRole("option").first()).toBeVisible();
    await sweepWidths(page);
  });
});

test.describe("匿名 @widths", () => {
  test.use({ role: "anonymous" });

  for (const title of [SEED.welcome, SEED.longTitle, SEED.manyTags, SEED.longPage]) {
    test(`public のページ: ${title}`, async ({ page }) => {
      await page.goto(`/${encodeURIComponent(title)}`);
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await sweepWidths(page);
    });
  }

  test("存在しないページ", async ({ page }) => {
    await page.goto(`/${encodeURIComponent("本当に存在しないページ")}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "本当に存在しないページ" }),
    ).toBeVisible();
    await expect(page.locator(".rail-section-links")).toContainText("ありません。");
    await sweepWidths(page);
  });
});
