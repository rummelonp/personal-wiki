import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalScroll, test } from "./support/fixtures";

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

/*
 * 既定のサイト名（E2E の Worker は名前を持たず既定を出す）は、owner の 4 つの操作と並ぶと電話の幅に
 * 収まらないので、狭い幅では「wiki」を見せる。リンクの名前は、どの幅でも正式な名前のまま。
 */
const SITE = "personal-wiki";

/** 画面に見えているロゴの文字の要素 */
const visibleBrandText = (page: Page) =>
  page
    .locator(".brand-text")
    .evaluateAll((els) =>
      els
        .filter((el) => getComputedStyle(el).display !== "none")
        .map((el) => ({ text: el.textContent, clipped: el.scrollWidth > el.clientWidth })),
    );

test.describe("ロゴの文字", () => {
  test.describe("iPhone の幅 375px", () => {
    test.skip(({ isMobile }) => !isMobile, "タッチ端末だけ");
    test.use({ viewport: { width: 375, height: 812 } });

    test("owner のロゴは「wiki」で、省略されず、リンクの名前は正式な名前", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator(".header-grants")).toBeVisible();
      expect(await visibleBrandText(page)).toEqual([{ text: "wiki", clipped: false }]);
      await expect(page.getByRole("banner").getByRole("link", { name: SITE })).toBeVisible();
    });
  });

  test.describe("デスクトップの幅 1280px", () => {
    test.skip(({ isMobile }) => isMobile, "マウスの端末だけ");

    test("owner のロゴは既定の名前で、リンクの名前も同じ", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator(".header-grants")).toBeVisible();
      expect(await visibleBrandText(page)).toEqual([{ text: SITE, clipped: false }]);
      await expect(page.getByRole("banner").getByRole("link", { name: SITE })).toBeVisible();
    });
  });
});

test.describe("検索語を出した header", () => {
  test.skip(({ isMobile }) => !isMobile, "タッチ端末だけ");
  test.use({ viewport: { width: 320, height: 568 } });

  // 検索語に残る幅の下限。ロゴが下限まで縮んだ幅 320px の owner（操作が 4 つ）で約 64px 残る
  const MIN_TEXT_WIDTH = 48;

  for (const [label, query] of [
    ["短い", "メモ"],
    ["長い", "とても長い検索語".repeat(8)],
  ] as const) {
    test(`幅 320px の owner で${label}検索語を出しても、要素が重ならず、検索語の欄が潰れない`, async ({
      page,
    }) => {
      await page.goto("/");
      const header = page.locator("header.header");
      await expect(page.locator(".header-grants")).toBeVisible();
      const plainHeight = (await header.boundingBox())?.height;

      await page.goto(`/?q=${encodeURIComponent(query)}`);
      await expect(page.getByRole("button", { name: `ページを検索: ${query}` })).toBeVisible();
      await expect(page.locator(".header-grants")).toBeVisible();
      expect((await header.boundingBox())?.height, "header は 1 行のまま").toBe(plainHeight);
      await expectNoHorizontalScroll(page);

      const { boxes, text } = await page.evaluate(() => {
        const rect = (element: Element) => {
          const { left, right } = element.getBoundingClientRect();
          return { left, right };
        };
        const search = document.querySelector<HTMLElement>(".header-search-text");
        return {
          // 左から順に、ロゴ、検索語のボタン、右の操作
          boxes: [
            ...document.querySelectorAll(".header > .brand, .header > .header-search"),
            ...document.querySelectorAll(".header-actions > *"),
          ].map(rect),
          text: search && {
            width: search.clientWidth,
            scrollWidth: search.scrollWidth,
          },
        };
      });
      expect(boxes).toHaveLength(5);
      for (const [index, box] of boxes.entries()) {
        const previous = boxes[index - 1];
        if (previous)
          expect(box.left, `${index} 番目の左端が前の要素と重ならない`).toBeGreaterThanOrEqual(
            previous.right - 0.5,
          );
      }
      // 右の余白（左と同じ 12px）を食わない
      expect(boxes.at(-1)?.right).toBeLessThanOrEqual(320 - 12 + 0.5);
      // 短い語は省略されず、長い語は残る幅いっぱいの欄の中で省略される
      const truncated = (text?.scrollWidth ?? 0) > (text?.width ?? 0);
      expect(truncated, "語が省略される").toBe(label === "長い");
      if (truncated) expect(text?.width, "検索語の欄の幅").toBeGreaterThanOrEqual(MIN_TEXT_WIDTH);
    });
  }
});
