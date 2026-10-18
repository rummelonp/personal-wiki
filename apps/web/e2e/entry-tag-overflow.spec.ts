import type { Locator, Page } from "@playwright/test";
import type { OwnerApi } from "./support/api";
import { expect, expectNoHorizontalScroll, test, uniqueTitle } from "./support/fixtures";

/*
 * 長いタグのチップが、一覧の行と右の欄（タグの絞り込み）を押し広げない。
 * 行が広がると、行の右端の日時が画面の外へ押し出される。
 * 狭い画面では右の欄が本文の下に回り、同じチップの規則がその欄にも効く。
 */

// 折り返し位置が無い長い名前（英数字）と、日本語の長い名前の 2 つ
const ASCII_TAG = "averyveryverylongtagnamewithoutanybreakopportunity_abcdefghijklmnopqrstuvwxyz";
const JA_TAG = "長いタグの名前を折り返さずに並べると画面の幅を超えてしまう場合のタグ";

async function createRowWithLongTags(page: Page, api: OwnerApi, title: string) {
  await api.createPage({
    title,
    body: `本文の抜粋です。\n\n#${JA_TAG} #${ASCII_TAG} #短い`,
    visibility: "public",
  });
  await page.goto("/");
  const row = page.locator(".entries .entry").filter({ hasText: title });
  await expect(row).toBeVisible();
  return row;
}

async function expectInsideViewport(page: Page, target: Locator, label: string) {
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  const box = await target.boundingBox();
  expect(box, `${label} の箱が無い`).not.toBeNull();
  expect(box?.x, `${label} の左端が画面の外`).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0), `${label} の右端が画面の外`).toBeLessThanOrEqual(
    viewportWidth + 0.5,
  );
}

async function expectRowFitsChips(page: Page, row: Locator) {
  await expectNoHorizontalScroll(page);
  await expectInsideViewport(page, row, "行");
  await expectInsideViewport(page, row.locator(".entry-time"), "行の日時");
  const rowBox = await row.boundingBox();
  for (const chip of await row.locator(".chip-link").all()) {
    const box = await chip.boundingBox();
    expect(
      (box?.x ?? 0) + (box?.width ?? 0),
      `チップ「${await chip.textContent()}」が行からはみ出す`,
    ).toBeLessThanOrEqual((rowBox?.x ?? 0) + (rowBox?.width ?? 0) + 0.5);
  }
}

async function expectRailFitsChips(page: Page) {
  const rail = page.locator(".rail");
  await expect(rail.locator(".chip-link").first()).toBeVisible();
  const railBox = await rail.boundingBox();
  await expectInsideViewport(page, rail, "右の欄");
  for (const chip of await rail.locator(".chip-link").all()) {
    const box = await chip.boundingBox();
    expect(
      (box?.x ?? 0) + (box?.width ?? 0),
      `チップ「${await chip.textContent()}」が欄からはみ出す`,
    ).toBeLessThanOrEqual((railBox?.x ?? 0) + (railBox?.width ?? 0) + 0.5);
  }
}

/** 名前は省略記号で切れても、件数は残る。長い名前のチップが省略されている（実際に溢れている）ことも確かめる。 */
async function expectLongChipIsTruncated(row: Locator) {
  const label = row.locator(".chip-label", { hasText: ASCII_TAG });
  const truncated = await label.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(truncated, "長いタグが省略されていない（幅が足りていて、検証にならない）").toBe(true);
}

test("長いタグの行でも、日時と行が画面の中に収まる", async ({ page, api }, testInfo) => {
  const row = await createRowWithLongTags(page, api, uniqueTitle(testInfo, "長いタグの行"));
  await expectRowFitsChips(page, row);
  await expectRailFitsChips(page);
  // 画面の幅が足りる PC では省略しない。省略を見るのは狭い幅のテスト
  if ((page.viewportSize()?.width ?? 0) <= 500) await expectLongChipIsTruncated(row);
});

test.describe("幅の狭い画面 @widths", () => {
  for (const width of [320, 375]) {
    test(`${width}px`, async ({ page, api }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      const row = await createRowWithLongTags(page, api, uniqueTitle(testInfo, "長いタグの行"));
      await expectRowFitsChips(page, row);
      await expectRailFitsChips(page);
      await expectLongChipIsTruncated(row);
    });
  }
});

test.describe("匿名", () => {
  test.use({ role: "anonymous" });

  test("長いタグの行でも、日時と行が画面の中に収まる", async ({ page, api }, testInfo) => {
    const row = await createRowWithLongTags(page, api, uniqueTitle(testInfo, "長いタグの行"));
    await expectRowFitsChips(page, row);
    await expectRailFitsChips(page);
  });
});
