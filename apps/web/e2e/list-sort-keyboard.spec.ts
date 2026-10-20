import type { JSHandle, Page } from "@playwright/test";
import type { OwnerApi } from "./support/api";
import { expect, test, uniqueTitle } from "./support/fixtures";

/*
 * 並び順のメニューを、デスクトップで閉じたときの焦点の移動先。
 * メニューを閉じる Tab の keydown では、既定の動作より先に項目が消える。
 * 移動先がブラウザの扱いに任されるので、実際のキーの経路で、ボタンから同じキーを押したのと同じ所かを確かめる。
 * ボタンを押して閉じるときは、押しても焦点が移らない Safari で焦点がボタンに戻るかを確かめる。
 */

const sortButton = (page: Page) => page.getByRole("button", { name: /^並び順：/ });
const menu = (page: Page) => page.getByRole("menu", { name: "並び順" });
const menuItem = (page: Page, label: string) =>
  page.getByRole("menuitemradio", { name: label, exact: true });

// デスクトップの Safari の既定の Tab はボタンとリンクに止まらず、キーボードで操作する人は Option+Tab で移る。
// 一覧のボタンの前後はボタンとリンクだけなので、素の Tab では止まる所が無く、比べる基準が作れない
const navigationKey = (browserName: string, key: string) =>
  browserName === "webkit" ? `Alt+${key}` : key;

const activeElement = (page: Page) => page.evaluateHandle(() => document.activeElement);
const isActive = (page: Page, element: JSHandle) =>
  page.evaluate((target) => document.activeElement === target, element);

test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, "デスクトップのキーボードの操作を測る");
});

async function openList(page: Page, api: OwnerApi, title: string) {
  await api.createPage({ title, body: "焦点の検査に使う本文" });
  await page.goto("/");
  await expect(page.locator(".entries .entry-title").first()).toBeVisible();
  await expect(page.locator(".home")).not.toHaveAttribute("aria-busy", "true");
  await expect(sortButton(page)).toBeVisible();
}

/** ボタンに焦点を置いてキーを押した後の焦点。メニューを閉じた後の移動先の基準にする */
async function destinationFromButton(page: Page, key: string) {
  await sortButton(page).focus();
  await page.keyboard.press(key);
  const destination = await activeElement(page);
  await expect(sortButton(page)).not.toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  return destination;
}

for (const key of ["Tab", "Shift+Tab"]) {
  test(`メニューの項目で ${key} を押すと、メニューが閉じてボタンから ${key} を押したのと同じ所へ焦点が移る @keyboard`, async ({
    page,
    api,
    browserName,
  }, testInfo) => {
    const pressed = navigationKey(browserName, key);
    await openList(page, api, uniqueTitle(testInfo, `並び順の焦点 ${key}`));
    const destination = await destinationFromButton(page, pressed);

    await sortButton(page).focus();
    await page.keyboard.press("ArrowDown");
    await expect(menu(page)).toBeVisible();
    await expect(menuItem(page, "更新日時")).toBeFocused();
    await page.keyboard.press(pressed);

    await expect(menu(page)).toHaveCount(0);
    expect(await isActive(page, destination)).toBe(true);
    await expect(sortButton(page)).toHaveAccessibleName("並び順：更新日時");
  });
}

test("2 つ目の項目に移ってからの Tab も、ボタンの次へ移る @keyboard", async ({
  page,
  api,
  browserName,
}, testInfo) => {
  const pressed = navigationKey(browserName, "Tab");
  await openList(page, api, uniqueTitle(testInfo, "並び順の焦点 2 つ目"));
  const destination = await destinationFromButton(page, pressed);

  await sortButton(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(menuItem(page, "作成日時")).toBeFocused();
  await page.keyboard.press(pressed);

  await expect(menu(page)).toHaveCount(0);
  expect(await isActive(page, destination)).toBe(true);
});

test("開いたメニューを並び順のボタンを押して閉じると、焦点がボタンに戻る @keyboard", async ({
  page,
  api,
}, testInfo) => {
  await openList(page, api, uniqueTitle(testInfo, "並び順の焦点 ボタンで閉じる"));

  await sortButton(page).click();
  await expect(menu(page)).toBeVisible();
  await expect(menuItem(page, "更新日時")).toBeFocused();
  await sortButton(page).click();

  await expect(menu(page)).toHaveCount(0);
  await expect(sortButton(page)).toBeFocused();
  await expect(sortButton(page)).toHaveAccessibleName("並び順：更新日時");
});
