import type { Page, Route } from "@playwright/test";
import { expect, test, uniqueTitle } from "./support/fixtures";

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
  await expect(page.locator(".entries .entry-title").filter({ hasText: title })).toBeVisible();
}

test.describe("ページを開く途中", () => {
  const cases = [
    { name: "title の URL（公開）", visibility: "public" as const },
    { name: "id の URL（draft）", visibility: "draft" as const },
  ];

  for (const { name, visibility } of cases) {
    test(`一覧から開く途中に、title の文字と本文の帯が出る: ${name}`, async ({
      page,
      api,
    }, testInfo) => {
      // 他のテストが書き換えない、このテストだけのページを使う
      const title = uniqueTitle(testInfo, "開く途中");
      const created = await api.createPage({ title, body: "本文", visibility });
      await listed(page, title);
      const hold = await holdResponses(page, (url) =>
        visibility === "draft"
          ? url.pathname === `/api/pages/${created.id}`
          : url.pathname === "/api/pages/by-title",
      );
      await page.locator(".entries .entry-title").filter({ hasText: title }).click();

      // 左上の 1 語ではなく、title は文字で、本文と右の欄は帯で出る
      await expect(page.locator(".note[aria-busy='true'] .note-title")).toHaveText(title);
      await expect(page.locator(".note .skeleton-body .skeleton").first()).toBeVisible();
      // 狭い画面（40rem 以下）では右の欄が本文の下に回り、その場所には本文が入るので帯を出さない
      const railBand = page.locator(".skeleton-rail .skeleton").first();
      if ((page.viewportSize()?.width ?? 0) > 640) await expect(railBand).toBeVisible();
      else await expect(railBand).toBeHidden();
      expect(await page.locator(".note .skeleton-body .skeleton").count()).toBeGreaterThanOrEqual(
        3,
      );
      // リンクの書き換えの空の status も同じ role を持つので、読み込みの文で絞る
      await expect(page.getByRole("status").filter({ hasText: "読み込み中…" })).toHaveCount(1);

      hold.release();
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await expect(page.locator(".note[aria-busy='true']")).toHaveCount(0);
      await expect(page.locator(".title-input, .note-title").first()).toContainText(title);
    });
  }
});

test.describe("一覧の条件を変える途中", () => {
  test("タグを変える途中は、前の行が残り、一覧が縮まない", async ({ page }) => {
    await page.goto("/");
    const rows = page.locator(".entries .entry");
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();
    const heightBefore = await page
      .locator(".entries")
      .evaluate((e) => e.getBoundingClientRect().height);

    const hold = await holdResponses(page, (url) => url.pathname === "/api/pages/recent");
    // 狭い画面ではタグが一覧の下に続くので、画面内に出してから押す
    const tag = page.locator(".entries .chip-link, .rail .chip-link").first();
    await tag.scrollIntoViewIfNeeded();
    await tag.click();

    await expect(page.locator(".list-title")).toHaveText(/^タグ「/);
    await expect(page.locator(".home[aria-busy='true']")).toBeVisible();
    await expect(page.locator(".entries-stale .entry")).toHaveCount(before);
    // 取得が遅いと分かったあとで、前の行を薄くする
    await expect(page.locator(".entries-stale.skeleton-painted")).toBeVisible();
    const heightHeld = await page
      .locator(".entries-stale")
      .evaluate((e) => e.getBoundingClientRect().height);
    expect(heightHeld).toBeGreaterThan(heightBefore * 0.9);

    hold.release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await expect(page.locator(".entries-stale")).toHaveCount(0);
    await expect(page.locator(".home[aria-busy='true']")).toHaveCount(0);
    await expect(rows.first()).toBeVisible();
  });
});
