import type { Page } from "@playwright/test";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";

/*
 * ジャーニー #1 書き留める: 新規作成 → 本文に入力 → 自動保存 → 再読み込みで残っている。
 * 入力は keyboard.type で、日本語の変換（IME）は対象外。
 */

/** 作成した直後の画面で、本文に caret が来ていることを確かめてから打ち、保存を待つ。 */
async function typeIntoNewPageAndSave(page: Page, text: string): Promise<void> {
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  await expect(bodyEditor(page)).toBeFocused();
  const saved = page.waitForResponse(
    (res) => res.request().method() === "PUT" && /\/api\/pages\/[^/]+$/.test(res.url()),
  );
  await page.keyboard.type(text);
  expect((await saved).status()).toBe(200);
  await expect(saveState(page)).toHaveText("保存済み");
}

async function expectKeptAfterReload(page: Page, title: string, text: string): Promise<void> {
  await page.reload();
  await expect(page.locator(".title-input")).toHaveText(title);
  await expect(bodyEditor(page)).toHaveText(text);
}

test("新規作成のダイアログから作って書き、再読み込みで残っている @smoke", async ({
  page,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "ダイアログで作成");
  const text = "ダイアログから作ったページの本文 with English";
  await page.goto("/");
  await page.getByRole("button", { name: "新規作成" }).click();
  const dialog = page.getByRole("dialog", { name: "新規作成" });
  await dialog.getByRole("textbox", { name: "タイトル" }).fill(title);
  await dialog.getByRole("button", { name: "作成" }).click();
  await expect(dialog).toBeHidden();
  await typeIntoNewPageAndSave(page, text);
  await expectKeptAfterReload(page, title, text);
});

test("quick switcher から作って書き、再読み込みで残っている", async ({ page }, testInfo) => {
  const title = uniqueTitle(testInfo, "switcher で作成");
  const text = "quick switcher から作ったページの本文";
  await page.goto("/");
  await page.getByRole("button", { name: "ページを検索" }).click();
  const switcher = page.getByRole("dialog", { name: "ページを検索" });
  await switcher.getByRole("combobox", { name: "ページを検索" }).fill(title);
  await switcher.getByRole("option", { name: `「${title}」を作成` }).click();
  await expect(switcher).toBeHidden();
  await typeIntoNewPageAndSave(page, text);
  await expectKeptAfterReload(page, title, text);
});
