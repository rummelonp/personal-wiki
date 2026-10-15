import type { Page } from "@playwright/test";
import type { ApiPage, OwnerApi } from "./support/api";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";

/*
 * 失敗の通知から衝突に移る流れ。
 */

const LINES = Array.from({ length: 60 }, (_, index) => `${index + 1} 行目の本文`);
const BODY = LINES.join("\n");

async function openLongPage(page: Page, api: OwnerApi, title: string): Promise<ApiPage> {
  const created = await api.createPage({ title, body: BODY });
  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page)).toContainText("1 行目の本文");
  await expect(saveState(page)).toHaveText("保存済み");
  return created;
}

async function typeAt(page: Page, lineIndex: number, text: string): Promise<void> {
  await bodyEditor(page).locator(".cm-line").nth(lineIndex).click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

const CONFLICT_HEADING = "サーバーの内容と食い違っています";

test("失敗の通知からマウスで再試行して衝突になっても、見出しに focus の枠を出さない", async ({
  page,
  api,
}, testInfo) => {
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "枠なし"));
  const pagePath = `**/api/pages/${created.id}`;
  await page.route(pagePath, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"x"}' })
      : route.fallback(),
  );
  await typeAt(page, 0, "、手元の変更");
  const alert = page.getByRole("alert").filter({ hasText: "保存に失敗しました" });
  await expect(alert).toBeVisible();
  await page.unroute(pagePath);
  await api.updatePage(created, { body: `${BODY}\n別の場所で足した行` });

  await alert.getByRole("button", { name: "もう一度保存する" }).click();
  const heading = page.getByRole("heading", { name: CONFLICT_HEADING });
  await expect(heading).toBeFocused();
  expect(await heading.evaluate((element) => element.matches(":focus-visible"))).toBe(false);
  expect(await heading.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
});

test("失敗の通知からキーボードで再試行して衝突になったときは、見出しに focus の枠で示す", async ({
  page,
  api,
  isMobile,
}, testInfo) => {
  // タッチ端末の WebKit は、keyboard で移した focus にも枠を付けない
  test.skip(isMobile, "デスクトップの keyboard の操作を測る");
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "枠あり"));
  const pagePath = `**/api/pages/${created.id}`;
  await page.route(pagePath, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"x"}' })
      : route.fallback(),
  );
  await typeAt(page, 0, "、手元の変更");
  const alert = page.getByRole("alert").filter({ hasText: "保存に失敗しました" });
  await expect(alert).toBeVisible();
  await page.unroute(pagePath);
  await api.updatePage(created, { body: `${BODY}\n別の場所で足した行` });

  await alert.getByRole("button", { name: "もう一度保存する" }).focus();
  await page.keyboard.press("Enter");
  const heading = page.getByRole("heading", { name: CONFLICT_HEADING });
  await expect(heading).toBeFocused();
  expect(await heading.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
});
