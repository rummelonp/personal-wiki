import type { Page } from "@playwright/test";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";

/*
 * 書き留める流れ: 新規作成 → 本文に入力 → 自動保存 → 再読み込みで残っている。
 * 入力は keyboard.type で、日本語の変換（IME）は対象外。
 *
 * 作成のレスポンスを待たずに打ち始める。新規作成の画面は、開く操作の中で入力欄にフォーカスし、作った後も
 * 同じエディタを使い続けるので、最初の文字から残るはず。
 */

/** caret が本文にある前提でそのまま打ち、作成と保存を待つ。 */
async function typeRightAwayAndSave(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text);
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  await expect(bodyEditor(page)).toHaveText(text);
  await expect(saveState(page)).toHaveText("保存済み");
}

async function expectKeptAfterReload(page: Page, title: string, text: string): Promise<void> {
  await page.reload();
  await expect(page.locator(".title-input")).toHaveText(title);
  await expect(bodyEditor(page)).toHaveText(text);
}

test("+ から title を決めて作り、続けて書いた本文が再読み込みで残っている @smoke", async ({
  page,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "+ で作成");
  const text = "ヘッダーの新規作成から作ったページの本文 with English";
  await page.goto("/");
  await page.getByRole("button", { name: "新規作成" }).click();
  await expect(page).toHaveURL(/\/\?new$/);
  await expect(page.locator(".title-input .cm-content")).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press("Enter");
  // Android の Chrome では CodeMirror が Enter を次のフレームで処理する。同じフレームで打つと改行と
  // 本文が 1 つの入力にまとまり Enter が消えるので、caret が本文へ移ったのを見てから打つ（作成のレスポンスは待たない）。
  await expect(bodyEditor(page)).toBeFocused();
  await typeRightAwayAndSave(page, text);
  await expectKeptAfterReload(page, title, text);
});

test("quick switcher から作り、すぐ書いた本文が再読み込みで残っている", async ({
  page,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "switcher で作成");
  const text = "quick switcher から作ったページの本文";
  await page.goto("/");
  await page.getByRole("button", { name: "ページを検索" }).click();
  const switcher = page.getByRole("dialog", { name: "ページを検索" });
  await switcher.getByRole("combobox", { name: "検索語" }).fill(title);
  await switcher.getByRole("option", { name: `「${title}」を作成` }).click();
  await expect(switcher).toBeHidden();
  await typeRightAwayAndSave(page, text);
  await expectKeptAfterReload(page, title, text);
});
