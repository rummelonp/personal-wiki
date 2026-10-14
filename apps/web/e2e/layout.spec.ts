import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalScroll, test } from "./support/fixtures";
import { SEED } from "./support/seed";

/*
 * 画面ごとに幅を切り替え、どの幅でも横スクロールが出ないことを確かめる。
 * iPhone 幅の WebKit そのものでの確認は、匿名のジャーニー（anonymous.spec.ts）が受け持つ。
 */

const WIDTHS = [320, 375, 768, 1280, 1440];
// 320px の owner はヘッダーがはみ出す（下の test.fixme）。直るまで、他の幅で他の崩れを見張る
const OWNER_WIDTHS = WIDTHS.filter((width) => width !== 320);

async function sweepWidths(page: Page, widths = WIDTHS): Promise<void> {
  for (const width of widths) {
    await test.step(`${width}px`, async () => {
      await page.setViewportSize({ width, height: 800 });
      await expectNoHorizontalScroll(page);
    });
  }
}

test.describe("owner @widths", () => {
  /*
   * アプリの不具合: 幅 320px では、owner のヘッダー（ロゴ、検索、新規作成、ログアウト）が 1 行に
   * 収まらず、ログアウトのボタンが右へ 24px ほどはみ出して横スクロールが出る。匿名（ログインのリンク
   * だけ）でははみ出さない。狭い画面の CSS は検索と新規作成をアイコンにするが、ログアウトは文字のまま。
   */
  test.fixme("320px でヘッダーがはみ出さない", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/");
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("トップの一覧", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await sweepWidths(page, OWNER_WIDTHS);
  });

  test("検索の結果", async ({ page }) => {
    await page.goto(`/?q=${encodeURIComponent("メモ")}`);
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await sweepWidths(page, OWNER_WIDTHS);
  });

  for (const title of [SEED.server, SEED.database, SEED.longTitle, SEED.manyTags, SEED.longPage]) {
    test(`ページの編集: ${title}`, async ({ page, seedIds }) => {
      await page.goto(`/p/${seedIds[title]}`);
      await expect(page.locator(".title-input")).toHaveText(title);
      await sweepWidths(page, OWNER_WIDTHS);
    });
  }

  test("quick switcher を開いた画面", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "ページを検索" }).click();
    await page
      .getByRole("dialog", { name: "ページを検索" })
      .getByRole("combobox", { name: "ページを検索" })
      .fill("メモ");
    await expect(page.getByRole("option").first()).toBeVisible();
    await sweepWidths(page, OWNER_WIDTHS);
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
    await expect(page.getByRole("heading", { name: "ページが見つかりません" })).toBeVisible();
    await sweepWidths(page);
  });
});
