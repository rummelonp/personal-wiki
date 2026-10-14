import type { Page } from "@playwright/test";
import { bodyEditor, expect, expectNoHorizontalScroll, test } from "./support/fixtures";
import { SEED } from "./support/seed";

/*
 * 目次。広い画面では右の列をヘッダーの下に固定し、長いページでスクロールしても目次が見える。
 * 狭い画面では右の列が本文の下に回るので、title の下に畳んだ目次を置き、本文の前から辿れる。
 * 長いページは見出しが 40 個ある（見出し 1 〜 見出し 40）。
 */

const TARGET = "見出し 30";

const headerBottom = (page: Page) =>
  page.evaluate(() => document.querySelector("header.header")?.getBoundingClientRect().bottom ?? 0);

/** 本文の見出しが、ヘッダーの下に見えている。CodeMirror は画面外の行を作らないので、移動の後に探す */
async function expectHeadingBelowHeader(page: Page, text: string): Promise<void> {
  const heading = bodyEditor(page).getByText(text, { exact: true });
  await expect(heading).toBeInViewport();
  const box = await heading.boundingBox();
  expect(box?.y ?? 0).toBeGreaterThanOrEqual((await headerBottom(page)) - 1);
}

async function openLongPage(page: Page, ids: Record<string, string>, owner: boolean) {
  await page.goto(owner ? `/p/${ids[SEED.longPage]}` : `/${encodeURIComponent(SEED.longPage)}`);
  await expect(bodyEditor(page)).toBeVisible();
  await expect(bodyEditor(page).getByText("見出し 1", { exact: true })).toBeVisible();
}

for (const owner of [true, false]) {
  const who = owner ? "owner" : "匿名";

  test.describe(`${who}: 広い画面の目次 @widths`, () => {
    test.use({ role: owner ? "owner" : "anonymous" });

    test("長いページをスクロールしても目次が見え、リンクで移れる", async ({ page, seedIds }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openLongPage(page, seedIds, owner);
      const rail = page.locator(".rail");
      const label = rail.getByRole("heading", { name: "目次" });
      await expect(label).toBeVisible();
      await expect(page.locator("details.toc")).toBeHidden();

      await page.evaluate(() => window.scrollTo(0, 3000));
      await expect
        .poll(() => page.evaluate(() => Math.round(window.scrollY)))
        .toBeGreaterThan(2000);
      await expect(label).toBeInViewport();
      const labelBox = await label.boundingBox();
      expect(labelBox?.y ?? 0).toBeGreaterThanOrEqual((await headerBottom(page)) - 1);

      // 目次は右の列の中でスクロールできる。見出しは 40 個あり、列の目次の高さに収まらない
      await rail.getByRole("button", { name: TARGET, exact: true }).click();
      await expectHeadingBelowHeader(page, TARGET);
      await expect(label).toBeInViewport();
    });

    test("目次が長くても、下の区画に届く", async ({ page, seedIds }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openLongPage(page, seedIds, owner);
      await page.evaluate(() => window.scrollTo(0, 3000));
      const info = page.locator(".rail").getByRole("heading", { name: "情報" });
      await info.scrollIntoViewIfNeeded();
      await expect(info).toBeInViewport();
    });
  });

  test.describe(`${who}: 狭い画面の目次`, () => {
    test.use({ role: owner ? "owner" : "anonymous" });

    test.beforeEach(async ({ page }, testInfo) => {
      // iPhone の project は実機の幅のまま、デスクトップの Chromium は 375px に絞る
      if (testInfo.project.name === "chromium-desktop") {
        await page.setViewportSize({ width: 375, height: 812 });
      }
    });

    test("本文の前の畳んだ目次を開き、リンクで移れる", async ({ page, seedIds }) => {
      await openLongPage(page, seedIds, owner);
      const toc = page.locator("details.toc");
      await expect(toc).toBeVisible();
      await expect(page.locator(".rail-section-outline")).toBeHidden();
      const tocBox = await toc.boundingBox();
      const bodyBox = await bodyEditor(page).boundingBox();
      expect(tocBox?.y ?? 0).toBeLessThan(bodyBox?.y ?? 0);

      await expect(toc).not.toHaveJSProperty("open", true);
      await toc.locator("summary").click();
      await expect(toc).toHaveJSProperty("open", true);
      await toc.getByRole("button", { name: TARGET, exact: true }).click();
      await expect(toc).toHaveJSProperty("open", false);
      await expectHeadingBelowHeader(page, TARGET);
      // 畳んだ目次の中のボタンが消えても、キーボードの利用者の focus は body に落ちない
      await expect
        .poll(() => page.evaluate(() => document.activeElement === document.body))
        .toBe(false);
      await expectNoHorizontalScroll(page);
    });

    test("見出しが少ないページには出ない", async ({ page, seedIds }) => {
      await page.goto(
        owner ? `/p/${seedIds[SEED.welcome]}` : `/${encodeURIComponent(SEED.welcome)}`,
      );
      await expect(bodyEditor(page)).toBeVisible();
      await expect(page.locator("details.toc")).toHaveCount(0);
    });
  });
}
