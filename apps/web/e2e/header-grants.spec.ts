import { expect, test } from "./support/fixtures";

/*
 * ヘッダーの「許可した接続」は、Worker が返す一覧の画面への素のリンク。
 * owner にだけ出し、押すとページ遷移で開く（SPA の中の遷移にしない）。
 */

test("owner のヘッダーのリンクが接続の一覧を指し、押すとその画面が開く", async ({ page }) => {
  await page.goto("/");
  // E2E の Worker は OAuth を開いている。閉じた環境ではリンクを出さない（Worker と画面の単体テストが見る）
  const me = await page.evaluate(() => fetch("/api/me").then((res) => res.json()));
  expect(me.features.oauth).toBe(true);
  const link = page.getByRole("banner").getByRole("link", { name: "許可した接続" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "/_auth/oauth/grants");
  await link.click();
  await expect(page).toHaveURL(/\/_auth\/oauth\/grants$/);
  await expect(page.locator("h1")).toHaveText("許可した接続");
});

test.describe("匿名", () => {
  test.use({ role: "anonymous" });

  test("ヘッダーに接続の一覧へのリンクが無い", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("banner").getByRole("link", { name: "ログイン" })).toBeVisible();
    await expect(page.locator("a[href^='/_auth/oauth']")).toHaveCount(0);
  });
});
