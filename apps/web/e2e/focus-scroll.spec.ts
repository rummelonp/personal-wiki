import type { Locator, Page } from "@playwright/test";
import type { ApiPage, OwnerApi } from "./support/api";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";

/*
 * 通知のボタンを押した後に script が title の欄や本文へ focus を移すとき、移し先が画面の外にあれば
 * ヘッダーの下に見える位置へ出す。見えているときはスクロールを動かさない。
 * ここは、画面の下に固定した通知を、本文の下の方までスクロールして押すデスクトップの操作を測る。
 */

const LINES = Array.from({ length: 120 }, (_, index) => `${index + 1} 行目の本文`);
const BODY = LINES.join("\n");

const titleEditor = (page: Page): Locator => page.locator(".title-input .cm-content");

async function openLongPage(page: Page, api: OwnerApi, title: string): Promise<ApiPage> {
  const created = await api.createPage({ title, body: BODY });
  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page)).toContainText("1 行目の本文");
  await expect(saveState(page)).toHaveText("保存済み");
  return created;
}

/** 1 行目の末尾に打って保存を始め、PUT が 500 で終わって「もう一度保存する」が出るまで進める */
async function failSave(page: Page, pagePath: string): Promise<Locator> {
  await page.route(pagePath, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"x"}' })
      : route.fallback(),
  );
  await bodyEditor(page).locator(".cm-line").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("、手元の変更");
  const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
  await expect(alert).toBeVisible();
  return alert;
}

async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
}

/** 欄がヘッダーの下から画面の下端の間に、全体が見えている */
async function expectShownBelowHeader(page: Page, target: Locator): Promise<void> {
  const header = await page.locator("header.header").boundingBox();
  const box = await target.boundingBox();
  const viewport = page.viewportSize();
  expect(header).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box?.y ?? 0).toBeGreaterThanOrEqual((header?.y ?? 0) + (header?.height ?? 0));
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport?.height ?? 0);
}

test("下までスクロールして再送し、title の重複で終わると、title の欄が見える位置へ出る", async ({
  page,
  api,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, "タッチ端末は枠に移し、スクロールを動かさない");
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "重複で下から再送"));
  const other = await api.createPage({ title: uniqueTitle(testInfo, "先にある title"), body: "x" });
  const pagePath = `**/api/pages/${created.id}`;
  const alert = await failSave(page, pagePath);

  await page.unroute(pagePath);
  await page.route(pagePath, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "title_conflict",
            existing: { id: other.id, title: other.title, visibility: "draft" },
          }),
        })
      : route.fallback(),
  );
  await scrollToBottom(page);
  await alert.getByRole("button", { name: "もう一度保存する" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "同じタイトルのページがある" }),
  ).toBeVisible();

  await expect(titleEditor(page)).toBeFocused();
  await expect(titleEditor(page)).toBeInViewport({ ratio: 1 });
  await expectShownBelowHeader(page, page.locator(".title-input"));
});

test("下までスクロールして衝突を解決すると、本文の打っていた行が見える位置へ出る", async ({
  page,
  api,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, "タッチ端末は枠に移し、スクロールを動かさない");
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "衝突を下から解決"));
  const pagePath = `**/api/pages/${created.id}`;
  let external: Promise<ApiPage> | undefined;
  await page.route(pagePath, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    external ??= api.updatePage(created, { body: `${BODY}\n別の場所で足した行` });
    await external;
    return route.fallback();
  });
  await bodyEditor(page).locator(".cm-line").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("、手元の変更");
  const conflict = page.getByRole("alert").filter({ hasText: "別の場所でも更新されています" });
  await expect(conflict).toBeVisible();

  await scrollToBottom(page);
  await conflict.getByRole("button", { name: "この画面の内容で上書きする" }).click();
  await conflict.getByRole("button", { name: "上書きする", exact: true }).click();
  await expect(conflict).toBeHidden();

  await expect(bodyEditor(page)).toBeFocused();
  // 行の箱は文字の上下に余白を持つので、カーソルの描画で測る
  const caret = page.locator(".body-editor .cm-cursor-primary");
  await expect(caret).toBeInViewport({ ratio: 1 });
  await expectShownBelowHeader(page, caret);
});

test("見えている title の欄へ移すときは、スクロールを動かさない", async ({
  page,
  api,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, "タッチ端末は枠に移し、スクロールを動かさない");
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "上で再送"));
  const other = await api.createPage({ title: uniqueTitle(testInfo, "先にある title"), body: "x" });
  const pagePath = `**/api/pages/${created.id}`;
  const alert = await failSave(page, pagePath);

  await page.unroute(pagePath);
  await page.route(pagePath, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "title_conflict",
            existing: { id: other.id, title: other.title, visibility: "draft" },
          }),
        })
      : route.fallback(),
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  const before = await page.evaluate(() => window.scrollY);
  await alert.getByRole("button", { name: "もう一度保存する" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "同じタイトルのページがある" }),
  ).toBeVisible();

  await expect(titleEditor(page)).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});
