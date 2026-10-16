import type { Page } from "@playwright/test";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";

/*
 * 添付の失敗の文: 上限を超えたときは大きさと上限（1,000 単位の MB）を、中身が申告した形式として
 * 読めないときは形式が違うときとは別の文を出す。どちらも本文には placeholder を残さない。
 */

async function pasteImage(
  page: Page,
  file: { name: string; type: string; size: number },
): Promise<void> {
  await bodyEditor(page).click();
  await bodyEditor(page).evaluate((element, spec) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(spec.size)], spec.name, { type: spec.type }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, file);
}

test.beforeEach(async ({ page, api }, testInfo) => {
  const created = await api.createPage({ title: uniqueTitle(testInfo, "添付"), body: "本文" });
  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page)).toHaveText("本文");
  await expect(saveState(page)).toHaveText("保存済み");
});

test("上限を超える画像は、大きさと 10 MB までであることを出し、送らない", async ({ page }) => {
  let uploads = 0;
  await page.route("**/api/attachments", (route) => {
    uploads += 1;
    return route.continue();
  });
  await pasteImage(page, { name: "big.png", type: "image/png", size: 10_000_001 });
  const alert = page.getByRole("alert").filter({ hasText: "big.png" });
  await expect(alert).toContainText("10.1 MB あります");
  await expect(alert).toContainText("10 MB までです");
  await expect(bodyEditor(page)).toHaveText("本文");
  expect(uploads).toBe(0);
});

test("拡張子の形式として読めない画像は、形式が違う画像とは別の文を出す", async ({ page }) => {
  await pasteImage(page, { name: "broken.png", type: "image/png", size: 16 });
  const alert = page.getByRole("alert").filter({ hasText: "broken.png" });
  await expect(alert).toContainText("PNG として読めませんでした");
  await expect(alert).not.toContainText("添付できない形式");
  await expect(bodyEditor(page)).toHaveText("本文");
});
