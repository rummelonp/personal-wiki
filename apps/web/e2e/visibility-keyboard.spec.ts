import type { JSHandle, Page } from "@playwright/test";
import type { OwnerApi } from "./support/api";
import { expect, test, uniqueTitle } from "./support/fixtures";

/*
 * 公開範囲のメニューを、デスクトップのキーボードで閉じたときの焦点の移動先。
 * メニューを閉じる Tab の keydown では、既定の動作より先に項目が消える。
 * 移動先がブラウザの扱いに任されるので、実際のキーの経路で、印から同じキーを押したのと同じ所かを確かめる。
 */

const pill = (page: Page) => page.locator(".visibility-pill");
const menu = (page: Page) => page.getByRole("menu", { name: "公開範囲" });
const menuItem = (page: Page, label: "下書き" | "公開") =>
  page.getByRole("menuitemradio", { name: label, exact: true });

const activeElement = (page: Page) => page.evaluateHandle(() => document.activeElement);
const isActive = (page: Page, element: JSHandle) =>
  page.evaluate((target) => document.activeElement === target, element);

test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, "デスクトップのキーボードの操作を測る");
});

async function openPage(page: Page, api: OwnerApi, title: string) {
  const created = await api.createPage({ title, body: "焦点の検査に使う本文" });
  await page.goto(`/p/${created.id}`);
  await expect(pill(page)).toBeVisible();
}

/** 印に焦点を置いてキーを押した後の焦点。メニューを閉じた後の移動先の基準にする */
async function destinationFromPill(page: Page, key: string) {
  await pill(page).focus();
  await page.keyboard.press(key);
  const destination = await activeElement(page);
  await expect(pill(page)).not.toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  return destination;
}

for (const key of ["Tab", "Shift+Tab"]) {
  test(`メニューの項目で ${key} を押すと、メニューが閉じて印から ${key} を押したのと同じ所へ焦点が移る @keyboard`, async ({
    page,
    api,
  }, testInfo) => {
    await openPage(page, api, uniqueTitle(testInfo, `公開範囲の焦点 ${key}`));
    const destination = await destinationFromPill(page, key);

    await pill(page).focus();
    await page.keyboard.press("ArrowDown");
    await expect(menu(page)).toBeVisible();
    await expect(menuItem(page, "下書き")).toBeFocused();
    await page.keyboard.press(key);

    await expect(menu(page)).toHaveCount(0);
    expect(await isActive(page, destination)).toBe(true);
    await expect(pill(page)).toHaveAttribute("data-visibility", "draft");
  });
}

test("2 つ目の項目に移ってからの Tab も、印の次へ移る @keyboard", async ({
  page,
  api,
}, testInfo) => {
  await openPage(page, api, uniqueTitle(testInfo, "公開範囲の焦点 2 つ目"));
  const destination = await destinationFromPill(page, "Tab");

  await pill(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(menuItem(page, "公開")).toBeFocused();
  await page.keyboard.press("Tab");

  await expect(menu(page)).toHaveCount(0);
  expect(await isActive(page, destination)).toBe(true);
});
