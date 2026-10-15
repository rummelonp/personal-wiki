import type { Page } from "@playwright/test";
import { expect, test, uniqueTitle } from "./support/fixtures";
import { SEED } from "./support/seed";

/* 探して開く流れ: 一覧、quick switcher、検索、タグ、backlink。 */

const entryLink = (title: string) => ({ name: title, exact: true });

test("トップの一覧から開ける @smoke", async ({ page, api }, testInfo) => {
  // 他のテストが draft を作り続けると seed の公開ページが先頭から外れるので、公開の行を自分で作る
  await api.createPage({
    title: uniqueTitle(testInfo, "公開の印"),
    body: "本文",
    visibility: "public",
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "最近の更新" })).toBeVisible();
  // 並列に走る他のテストがページを作り、先頭に来るページが変わるので、どのページかは決め打ちしない。
  // owner の一覧では公開の行にだけ印が付き、draft（作られたばかりのページ）には付かない。
  await expect(page.locator(".entries .chip-public").first()).toBeVisible();
  await expect(page.locator(".entries .entry:not(:has(.chip-public))").first()).toBeVisible();
  const first = page.locator(".entries .entry-title").first();
  const title = (await first.textContent()) ?? "";
  expect(title).not.toBe("");
  await first.click();
  await expect(page.locator(".title-input")).toHaveText(title);
});

test("quick switcher で title の一部から開ける", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "ページを検索" }).click();
  const switcher = page.getByRole("dialog", { name: "ページを検索" });
  await switcher.getByRole("combobox", { name: "ページを検索" }).fill("データベース");
  await switcher.getByRole("option", { name: SEED.database }).click();
  await expect(switcher).toBeHidden();
  await expect(page.locator(".title-input")).toHaveText(SEED.database);
});

test("quick switcher から本文を検索し、結果から開ける", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "ページを検索" }).click();
  const switcher = page.getByRole("dialog", { name: "ページを検索" });
  await switcher.getByRole("combobox", { name: "ページを検索" }).fill("無料枠");
  await switcher.getByRole("option", { name: "「無料枠」を本文から検索" }).click();
  await expect(page).toHaveURL(/\/\?q=/);
  await expect(page.getByRole("heading", { name: "「無料枠」の検索結果" })).toBeVisible();
  await page.locator(".entries").getByRole("link", entryLink(SEED.server)).click();
  await expect(page.locator(".title-input")).toHaveText(SEED.server);
});

/** title がこのとおりのページがあるか。 */
async function pageExists(page: Page, title: string): Promise<boolean> {
  const res = await page.request.get(`/api/pages/by-title?title=${encodeURIComponent(title)}`);
  return res.status() === 200;
}

async function openSwitcherAndType(page: Page, text: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "ページを検索" }).click();
  const switcher = page.getByRole("dialog", { name: "ページを検索" });
  const input = switcher.getByRole("combobox", { name: "ページを検索" });
  await input.fill(text);
  return { switcher, input };
}

test("quick switcher で語を打って Enter しても、ページは作られず本文の検索になる @smoke", async ({
  page,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "Enter で作らない");
  const { switcher, input } = await openSwitcherAndType(page, title);
  // 既定の行は「本文から検索」。作成は選ばれていない
  await expect(switcher.getByRole("option", { selected: true })).toHaveText(
    `「${title}」を本文から検索`,
  );
  await input.press("Enter");
  await expect(page).toHaveURL(/\/\?q=/);
  await expect(page.getByRole("heading", { name: `「${title}」の検索結果` })).toBeVisible();
  expect(await pageExists(page, title)).toBe(false);
});

test("0 件の検索結果から、検索語の title で作れる", async ({ page }, testInfo) => {
  const title = uniqueTitle(testInfo, "0 件から作る");
  await page.goto(`/?q=${encodeURIComponent(title)}`);
  await expect(page.getByRole("heading", { name: "一致するページがありません" })).toBeVisible();
  expect(await pageExists(page, title)).toBe(false);
  await page.getByRole("button", { name: `「${title}」を作成` }).click();
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  await expect(page.locator(".title-input")).toHaveText(title);
  expect(await pageExists(page, title)).toBe(true);
});

test("title が完全に一致する語で Enter すると、そのページを開く", async ({ page }) => {
  const { switcher, input } = await openSwitcherAndType(page, SEED.database);
  // title の一覧を取り終える前の Enter は、完全一致を知らないので本文の検索になる
  await expect(switcher.getByRole("option", { name: SEED.database, exact: true })).toBeVisible();
  await input.press("Enter");
  await expect(page.locator(".title-input")).toHaveText(SEED.database);
});

test("quick switcher で ↓ を押して「作成」を選べば、キーボードだけで作れる", async ({
  page,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "矢印で作る");
  const { switcher, input } = await openSwitcherAndType(page, title);
  await input.press("ArrowDown");
  await expect(switcher.getByRole("option", { selected: true })).toHaveText(`「${title}」を作成`);
  await input.press("Enter");
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  await expect(page.locator(".title-input")).toHaveText(title);
  expect(await pageExists(page, title)).toBe(true);
});

test("一致しない検索は 0 件の案内を出す", async ({ page }) => {
  await page.goto(`/?q=${encodeURIComponent("どこにも無い語句")}`);
  await expect(page.getByRole("heading", { name: "一致するページがありません" })).toBeVisible();
});

test("タグで絞り込める", async ({ page }) => {
  await page.goto("/");
  await page
    .locator(".rail .chip-link")
    .filter({ hasText: /^database\d+$/ })
    .click();
  await expect(page.getByRole("heading", { name: "タグ「database」" })).toBeVisible();
  const entries = page.locator(".entries .entry");
  await expect(entries).toHaveCount(1);
  await expect(entries.getByRole("link", entryLink(SEED.database))).toBeVisible();
});

test("backlink から参照元へ移れる", async ({ page, seedIds }) => {
  await page.goto(`/p/${seedIds[SEED.database]}`);
  const links = page.locator(".rail-section-links");
  // owner には draft の参照元も出る
  await expect(links.getByRole("link", entryLink(SEED.draftSecret))).toBeVisible();
  await links.getByRole("link", entryLink(SEED.server)).click();
  await expect(page.locator(".title-input")).toHaveText(SEED.server);
});
