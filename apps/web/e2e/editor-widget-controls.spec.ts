import type { Page } from "@playwright/test";
import type { OwnerApi } from "./support/api";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";

/*
 * 本文の中の部品（callout の開閉、frontmatter の tag、embed の「記法を編集」、添付の完了）の
 * 操作と表示。部品の単体の挙動はエディタのテストが見る。ここでは実際のブラウザで、Tab で届くことと、
 * 操作した後に focus が残ることを見る。
 */

// 1x1 の PNG。サーバーが形式を検査するので、読める画像にする。
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function openWithBody(page: Page, api: OwnerApi, title: string, body: string): Promise<void> {
  const created = await api.createPage({ title, body });
  await page.goto(`/p/${created.id}`);
  await expect(saveState(page)).toHaveText("保存済み");
}

test("callout の開閉ボタンは Tab で届き、Enter と Space で開閉し、focus が残る", async ({
  page,
  api,
}, testInfo) => {
  await openWithBody(
    page,
    api,
    uniqueTitle(testInfo, "開閉"),
    "> [!note]- 手順\n> 中の本文\n\n外の本文",
  );
  const fold = bodyEditor(page).getByRole("button", { name: "「手順」の内容" });
  const inner = bodyEditor(page).locator(".cm-line", { hasText: "中の本文" });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(inner).toBeHidden();

  // caret が見出し行に触れていると、見出しは source で出て開閉ボタンが無い。別の行から Tab で入る
  await bodyEditor(page).locator(".cm-line", { hasText: "外の本文" }).click();
  await page.keyboard.press("Tab");
  await expect(fold).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(inner).toBeVisible();
  await expect(fold).toBeFocused();

  await page.keyboard.press("Space");
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(inner).toBeHidden();
  await expect(fold).toBeFocused();
  // 開閉は本文を書き換えない
  await expect(saveState(page)).toHaveText("保存済み");
});

test("frontmatter の tag の chip は Tab で届き、Enter でタグの一覧へ移る", async ({
  page,
  api,
}, testInfo) => {
  const tag = `chip${Date.now().toString(36)}`;
  await openWithBody(page, api, uniqueTitle(testInfo, "chip"), `---\ntags: [${tag}]\n---\n本文`);
  const chip = bodyEditor(page).getByRole("link", { name: `#${tag}` });

  // caret が frontmatter に触れていると、枠は source で出て chip が無い。本文の行から Tab で入る
  await bodyEditor(page).locator(".cm-line", { hasText: "本文" }).click();
  await page.keyboard.press("Tab");
  await expect(chip).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(new RegExp(`tag=${tag}`));
});

test("callout の開閉ボタンから Shift+Tab で本文に戻ると、caret は Tab の前の位置にある", async ({
  page,
  api,
}, testInfo) => {
  await openWithBody(
    page,
    api,
    uniqueTitle(testInfo, "戻る callout"),
    "> [!note]- 手順\n> 中の本文\n\n外の本文",
  );
  const fold = bodyEditor(page).getByRole("button", { name: "「手順」の内容" });
  await bodyEditor(page).locator(".cm-line", { hasText: "外の本文" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Tab");
  await expect(fold).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(fold).not.toBeFocused();
  await page.keyboard.type("X");
  await expect(bodyEditor(page).locator(".cm-line", { hasText: "外の本文" })).toHaveText(
    "外の本文X",
  );
});

test("tag の chip から Shift+Tab で本文に戻ると、caret は Tab の前の位置にある", async ({
  page,
  api,
}, testInfo) => {
  const tag = `back${Date.now().toString(36)}`;
  await openWithBody(
    page,
    api,
    uniqueTitle(testInfo, "戻る chip"),
    `---\ntags: [${tag}]\n---\n本文`,
  );
  const chip = bodyEditor(page).getByRole("link", { name: `#${tag}` });
  await bodyEditor(page).locator(".cm-line", { hasText: "本文" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Tab");
  await expect(chip).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(chip).not.toBeFocused();
  await page.keyboard.type("X");
  await expect(bodyEditor(page).locator(".cm-line", { hasText: "本文" })).toHaveText("本文X");
});

test("短い名前の未解決の embed でも「記法を編集」の文字が省略されない", async ({
  page,
  api,
}, testInfo) => {
  await openWithBody(page, api, uniqueTitle(testInfo, "短い名前"), "前 ![[ab]] 後");
  const button = bodyEditor(page).locator(".cm-embed-edit");
  await expect(button).toHaveCount(1);
  const clipped = await button.evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(clipped).toBe(false);
});

test("caret が仮の記法の上にあるまま添付が済むと、添付の画像に替わる", async ({
  page,
  api,
}, testInfo) => {
  await openWithBody(page, api, uniqueTitle(testInfo, "添付の完了"), "本文");
  await bodyEditor(page).click();
  await page.keyboard.press("End");
  // アップロードを止めて、caret が仮の記法に触れた状態で「添付中」を描かせてから完了させる
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/attachments", async (route) => {
    await gate;
    await route.continue();
  });
  await bodyEditor(page).evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "dot.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, PNG_BASE64);
  // 仮の記法から離れて「添付中」の表示を描かせ、また記法に触れて source を出す
  await page.keyboard.press("Home");
  await expect(bodyEditor(page).locator(".cm-embed-uploading")).toHaveCount(1);
  await page.keyboard.press("End");
  await expect(bodyEditor(page)).toContainText("![[uploading.");
  await expect(bodyEditor(page).locator(".cm-embed-uploading")).toHaveCount(1);

  release();

  await expect(bodyEditor(page)).toContainText(/!\[\[[A-Za-z0-9_-]{22}\.png\]\]/);
  await expect(bodyEditor(page).locator(".cm-embed-uploading")).toHaveCount(0);
  await expect(bodyEditor(page).locator(".cm-embed img")).toHaveCount(1);
});
