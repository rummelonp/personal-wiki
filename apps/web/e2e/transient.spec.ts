import type { Page, Route } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { SEED } from "./support/seed";

/*
 * 取得の途中の画面。応答を止めて、待っている間に何が見えるかを確かめる。
 * 描き終わった画面だけを見ていると、待ちの間の崩れは見つからない。
 * スケルトンは 250ms 遅れて描くので、見えるまでは expect が待つ。
 */

async function holdResponses(
  page: Page,
  match: (url: URL) => boolean,
): Promise<{ release: () => void }> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => match(url),
    async (route: Route) => {
      await gate;
      await route.continue().catch(() => {});
    },
  );
  return { release };
}

/** title で検索した一覧を描き終えるまで待つ。最近の更新の先頭の外にあるページも、行として開ける。 */
async function listed(page: Page, title: string): Promise<void> {
  await page.goto(`/?q=${encodeURIComponent(title)}`);
  await expect(
    page.locator(".entries .entry-title").filter({ hasText: title }).first(),
  ).toBeVisible();
}

test.describe("ページを開く途中", () => {
  const cases = [
    { name: "title の URL（公開）", title: SEED.server, byId: false },
    { name: "id の URL（draft）", title: SEED.draftSecret, byId: true },
  ];

  for (const { name, title, byId } of cases) {
    test(`一覧から開く途中に、title の文字と本文の帯が出る: ${name}`, async ({ page, seedIds }) => {
      await listed(page, title);
      const hold = await holdResponses(page, (url) =>
        byId
          ? url.pathname === `/api/pages/${seedIds[title]}`
          : url.pathname === "/api/pages/by-title",
      );
      await page.locator(".entries .entry-title").filter({ hasText: title }).first().click();

      // 左上の 1 語ではなく、title は文字で、本文と右の欄は帯で出る
      await expect(page.locator(".note[aria-busy='true'] .note-title")).toHaveText(title);
      await expect(page.locator(".note .skeleton-body .skeleton").first()).toBeVisible();
      await expect(page.locator(".skeleton-rail .skeleton").first()).toBeVisible();
      expect(await page.locator(".note .skeleton-body .skeleton").count()).toBeGreaterThanOrEqual(
        3,
      );
      await expect(page.getByRole("status")).toHaveText("読み込み中…");

      hold.release();
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await expect(page.locator(".note[aria-busy='true']")).toHaveCount(0);
      await expect(page.locator(".title-input, .note-title").first()).toContainText(title);
    });
  }
});
