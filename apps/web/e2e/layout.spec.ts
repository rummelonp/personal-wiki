import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalScroll, test } from "./support/fixtures";
import { SEED } from "./support/seed";

/*
 * 画面ごとに幅を切り替え、どの幅でも横スクロールが出ないことを確かめる。
 * iPhone 幅の WebKit そのものでの確認は、匿名のジャーニー（anonymous.spec.ts）が受け持つ。
 */

const WIDTHS = [320, 375, 768, 1280, 1440];
async function sweepWidths(page: Page, widths = WIDTHS): Promise<void> {
  for (const width of widths) {
    await test.step(`${width}px`, async () => {
      await page.setViewportSize({ width, height: 800 });
      await expectNoHorizontalScroll(page);
    });
  }
}

test.describe("owner @widths", () => {
  test("トップの一覧", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await sweepWidths(page);
  });

  test("検索の結果", async ({ page }) => {
    await page.goto(`/?q=${encodeURIComponent("メモ")}`);
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await sweepWidths(page);
  });

  for (const title of [SEED.server, SEED.database, SEED.longTitle, SEED.manyTags, SEED.longPage]) {
    test(`ページの編集: ${title}`, async ({ page, seedIds }) => {
      await page.goto(`/p/${seedIds[title]}`);
      await expect(page.locator(".title-input")).toHaveText(title);
      await sweepWidths(page);
    });
  }

  test("0 件の検索結果の「作成」は、長い検索語でも画面の幅に収まる", async ({ page }) => {
    const query = "どこにも無い語句をとても長く書いた検索語".repeat(3);
    await page.goto(`/?q=${encodeURIComponent(query)}`);
    const create = page.getByRole("button", { name: `「${query}」を作成` });
    await expect(create).toBeVisible();
    for (const width of [320, 375, 768, 1280]) {
      await test.step(`${width}px`, async () => {
        await page.setViewportSize({ width, height: 800 });
        const box = await create.boundingBox();
        expect(box?.x).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
        await expectNoHorizontalScroll(page);
      });
    }
  });

  test("新規作成の画面", async ({ page }) => {
    await page.goto("/?new");
    await expect(page.locator(".title-input .cm-content")).toBeVisible();
    await sweepWidths(page);
  });

  test("quick switcher を開いた画面", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "ページを検索" }).click();
    await page
      .getByRole("dialog", { name: "ページを検索" })
      .getByRole("combobox", { name: "検索語" })
      .fill("メモ");
    await expect(page.getByRole("option").first()).toBeVisible();
    await sweepWidths(page);
  });
});

test.describe("匿名 @widths", () => {
  test.use({ role: "anonymous" });

  for (const title of [SEED.welcome, SEED.longTitle, SEED.manyTags, SEED.longPage]) {
    test(`public のページ: ${title}`, async ({ page }) => {
      await page.goto(`/${encodeURIComponent(title)}`);
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await sweepWidths(page);
    });
  }

  test("長い検索語が header のボタンに出ても、header は 1 行のまま", async ({ page }) => {
    const longQuery = "とても長い検索語".repeat(8);
    await page.goto("/");
    const header = page.locator("header.header");
    await expect(header).toBeVisible();
    for (const width of [320, 375, 768, 1280]) {
      await test.step(`${width}px`, async () => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto("/");
        await expect(page.getByRole("button", { name: "ページを検索" })).toBeVisible();
        const plain = (await header.boundingBox())?.height;
        await page.goto(`/?q=${encodeURIComponent(longQuery)}`);
        const search = page.getByRole("button", {
          name: `ページを検索: ${longQuery}`,
          exact: true,
        });
        await expect(search).toBeVisible();
        expect((await header.boundingBox())?.height).toBe(plain);
        // 語は省略され、ボタンの外へ出ない
        const truncated = await search.evaluate((el) => {
          const text = el.querySelector<HTMLElement>(".header-search-text");
          return text !== null && text.clientWidth > 0 && text.scrollWidth > text.clientWidth;
        });
        expect(truncated).toBe(true);
        await expectNoHorizontalScroll(page);
      });
    }
  });

  test("存在しないページ", async ({ page }) => {
    // 匿名にはリンク元 0 件の節を出さないので、取得を終えたことはレスポンスで待つ
    const backlinks = page.waitForResponse((res) =>
      res.url().includes("/api/pages/by-title/backlinks"),
    );
    await page.goto(`/${encodeURIComponent("本当に存在しないページ")}`);
    await backlinks;
    await expect(
      page.getByRole("heading", { level: 1, name: "本当に存在しないページ" }),
    ).toBeVisible();
    await expect(page.locator(".rail")).toBeHidden();
    await sweepWidths(page);
  });
});
