import type { Page, Route } from "@playwright/test";
import type { ApiPage, OwnerApi } from "./support/api";
import {
  bodyEditor,
  expect,
  saveState,
  test,
  typeAtBodyEnd,
  uniqueTitle,
} from "./support/fixtures";

/*
 * 削除したページの退避: あるタブでページを削除したとき、別のタブが保存できずに端末へ退避した内容は、
 * 黙って消えずに、新規作成の画面から新しいページとして作り直せる。
 * 別のタブの保存の失敗は、保存の PUT を page.route で 500 にして起こす。
 */

const FIRST_LINE = "最初からある行";
const isSave = (route: Route) => route.request().method() === "PUT";

async function openPage(page: Page, id: string): Promise<void> {
  await page.goto(`/p/${id}`);
  await expect(bodyEditor(page)).toHaveText(FIRST_LINE);
  await expect(saveState(page)).toHaveText("保存済み");
}

/** 保存を 500 にして打ち、端末に退避させる。 */
async function typeUnsaved(page: Page, created: ApiPage, typed: string): Promise<void> {
  await page.route(`**/api/pages/${created.id}`, (route) =>
    isSave(route)
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "internal" }),
        })
      : route.fallback(),
  );
  await typeAtBodyEnd(page, typed);
  const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
  await expect(alert).toContainText("入力した内容は、この端末に残してあります。");
}

async function deleteFromRail(page: Page): Promise<void> {
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "このページを削除" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function restoreAsNewPage(page: Page, title: string, body: string, api: OwnerApi) {
  await expect(
    page.getByText(`この端末に残っている「${title}」の内容`, { exact: false }),
  ).toBeVisible();
  // 通知が重なって本文が畳まれても、見出しだけで削除されたページの内容と分かる
  await expect(
    page.getByRole("heading", { name: "削除されたページで保存できなかった内容があります" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新しいページとして作る" }).click();
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  await expect(saveState(page)).toHaveText("保存済み");
  await expect(bodyEditor(page)).toHaveText(body);
  const id = new URL(page.url()).pathname.split("/").pop() ?? "";
  expect(await api.getPage(id)).toMatchObject({ title, body });
}

test("閉じたタブの退避は、別のタブでページを削除した後、新規作成の画面で新しいページとして作れる", async ({
  page,
  context,
  api,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "閉じたタブの退避");
  const created = await api.createPage({ title, body: FIRST_LINE });
  await openPage(page, created.id);
  const other = await context.newPage();
  await openPage(other, created.id);
  const typed = "、閉じたタブで打った";
  await typeUnsaved(other, created, typed);
  // 閉じる途中の keepalive の保存は、Chromium では route でも offline でも止まらずサーバーに届く。
  // 先にサーバーの版を進め、その保存を版の衝突で失敗させる
  const changed = "別の場所で書き換えた行";
  await api.updatePage(created, { body: changed });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(bodyEditor(page)).toHaveText(changed);
  await other.close();

  await deleteFromRail(page);
  await expect(page.locator(".entries .entry").first()).toBeVisible();
  await page.getByRole("button", { name: "新規作成" }).click();
  await expect(page).toHaveURL(/\/\?new$/);
  await restoreAsNewPage(page, title, FIRST_LINE + typed, api);
});

test("開いていたタブは、別のタブの削除を知ると、未保存の内容を新しいページとして作り直せる", async ({
  page,
  context,
  api,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "削除を知ったタブ");
  const created = await api.createPage({ title, body: FIRST_LINE });
  await openPage(page, created.id);
  const other = await context.newPage();
  await openPage(other, created.id);
  const typed = "、削除されたタブで打った";
  await typeUnsaved(other, created, typed);

  // 削除したタブが退避を移したことを storage イベントで知るので、保存を試み直さなくても通知が変わる
  await deleteFromRail(page);
  const gone = other.getByRole("alert").filter({
    has: other.getByRole("heading", { name: "このページはサーバーにありません" }),
  });
  await expect(gone).toContainText("新しいページとして作り直せます。");
  await expect(saveState(other)).toHaveText("削除済み");
  await gone.getByRole("button", { name: "新しいページとして作る" }).click();
  await expect(other).toHaveURL(/\/\?new$/);
  await restoreAsNewPage(other, title, FIRST_LINE + typed, api);

  // 削除したタブが移した写しと、削除を知ったタブの写しを二重に残さない
  await other.getByRole("button", { name: "新規作成" }).click();
  await expect(other).toHaveURL(/\/\?new$/);
  // 画面が描かれる前の toBeHidden は、案内が出る前に通ってしまう
  await expect(other.locator(".title-input .cm-content")).toBeVisible();
  await expect(other.getByRole("button", { name: "新しいページとして作る" })).toBeHidden();
});
