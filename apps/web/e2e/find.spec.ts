import { expect, test } from "./support/fixtures";
import { SEED } from "./support/seed";

/* ジャーニー #2 探して開く: 一覧、quick switcher、検索、タグ、backlink。 */

const entryLink = (title: string) => ({ name: title, exact: true });

test("トップの一覧から開ける @smoke", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "最近の更新" })).toBeVisible();
  // 並列に走る他のテストがページを作り、先頭に来るページが変わるので、どのページかは決め打ちしない。
  // owner の一覧には draft も出る（作られたばかりのページは draft）。
  await expect(page.locator(".entries .chip-draft").first()).toBeVisible();
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

test("一致しない検索は 0 件の案内を出す", async ({ page }) => {
  await page.goto(`/?q=${encodeURIComponent("どこにも無い語句")}`);
  await expect(page.getByText("一致するページがありません。")).toBeVisible();
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
