import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalScroll, test } from "./support/fixtures";
import { SEED } from "./support/seed";

/*
 * 指で押す端末（iPhone 幅の WebKit、pointer: coarse）で、主なタップ対象の当たり判定が 44px 以上であり、
 * 隣の対象と重ならないこと。デスクトップでは密度を変えないことも確かめる。
 * 当たり判定は要素の箱そのもの（疑似要素で広げていない）なので、箱の大きさで測る。
 */

const TAP = 44;
// 計算で 44px ちょうどにした箱の端数を許す
const TOLERANCE = 0.1;

/** 画面ごとに調べる対象。ページ内の文章に混ざるリンクは、押す対象として扱わない。 */
const TARGETS = [
  ".header a",
  ".header button",
  ".entries .entry-title",
  ".entries .chip-link",
  ".rail .chip-link",
  ".rail-list a",
  ".outline-link",
  ".segmented-option",
  ".rail .button",
  ".note .chip-link",
];

interface Box {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

async function targetBoxes(page: Page): Promise<Box[]> {
  return page.evaluate((selectors) => {
    const seen = new Set<Element>();
    const boxes: Box[] = [];
    for (const element of document.querySelectorAll(selectors.join(","))) {
      if (seen.has(element)) continue;
      seen.add(element);
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const name = `${element.tagName.toLowerCase()}.${[...element.classList].join(".")} 「${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 20)}」`;
      boxes.push({ name, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    return boxes;
  }, TARGETS);
}

async function expectTapTargets(page: Page, required: string[]): Promise<void> {
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  const boxes = await targetBoxes(page);
  for (const selector of required) {
    expect(
      boxes.some((b) => b.name.startsWith(selector)),
      `${selector} の対象が画面に無い`,
    ).toBe(true);
  }
  const small = boxes.filter((b) => b.width < TAP - TOLERANCE || b.height < TAP - TOLERANCE);
  expect(
    small.map((b) => `${b.name} ${b.width.toFixed(1)}x${b.height.toFixed(1)}`),
    "44px に満たない対象",
  ).toEqual([]);
  const overlaps: string[] = [];
  boxes.forEach((a, i) => {
    for (const b of boxes.slice(i + 1)) {
      const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (w > TOLERANCE && h > TOLERANCE) overlaps.push(`${a.name} と ${b.name}`);
    }
  });
  expect(overlaps, "当たり判定が重なる対象").toEqual([]);
}

test.describe("タップ対象", () => {
  test.skip(({ isMobile }) => !isMobile, "pointer: coarse の端末だけ");
  test.use({ viewport: { width: 375, height: 812 } });

  test("owner の一覧", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await expect(page.locator(".rail .chip-link").first()).toBeVisible();
    await expectTapTargets(page, [
      "a.brand",
      "button.header-search",
      "button.button.button-primary.button-compact.header-new",
      "button.button.button-quiet.button-compact.header-logout",
      "a.entry-title",
      "a.chip.chip-link",
    ]);
  });

  test("owner のページの編集（公開の切り替え、backlink、目次）", async ({ page, seedIds }) => {
    await page.goto(`/p/${seedIds[SEED.welcome]}`);
    await expect(page.locator(".title-input")).toHaveText(SEED.welcome);
    await expect(page.locator(".rail-list a").first()).toBeVisible();
    await expect(page.locator(".segmented-option").first()).toBeVisible();
    await expectTapTargets(page, ["button.segmented-option", "a.brand"]);
    await page.goto(`/p/${seedIds[SEED.server]}`);
    await expect(page.locator(".title-input")).toHaveText(SEED.server);
    await expect(page.locator(".rail-list a").first()).toBeVisible();
    await expectTapTargets(page, ["a"]);
  });

  test("見出しの多いページの目次", async ({ page, seedIds }) => {
    await page.goto(`/p/${seedIds[SEED.longPage]}`);
    await expect(page.locator(".title-input")).toHaveText(SEED.longPage);
    await expect(page.locator(".outline-link").first()).toBeVisible();
    await expectTapTargets(page, ["button.outline-link"]);
  });

  test.describe("匿名", () => {
    test.use({ role: "anonymous" });

    test("一覧と public のページ", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator(".entries .entry").first()).toBeVisible();
      await expectTapTargets(page, ["a.brand", "a.button.button-compact", "a.entry-title"]);
      await page.goto(`/${encodeURIComponent(SEED.server)}`);
      await expect(page.getByRole("heading", { level: 1, name: SEED.server })).toBeVisible();
      await expectTapTargets(page, ["a.brand"]);
      await page.goto(`/${encodeURIComponent(SEED.manyTags)}`);
      await expect(page.getByRole("heading", { level: 1, name: SEED.manyTags })).toBeVisible();
      await expectTapTargets(page, ["a.chip.chip-link"]);
    });
  });

  for (const role of ["owner", "anonymous"] as const) {
    test(`幅 320px でも ${role} の画面に横スクロールが出ない`, async ({
      page,
      context,
      seedIds,
    }) => {
      if (role === "anonymous") await context.clearCookies();
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto("/");
      await expect(page.locator(".entries .entry").first()).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectTapTargets(page, ["a.brand"]);
      if (role === "owner") {
        await page.goto(`/p/${seedIds[SEED.server]}`);
        await expect(page.locator(".title-input")).toHaveText(SEED.server);
        await expectNoHorizontalScroll(page);
      }
    });
  }
});

test.describe("デスクトップの密度", () => {
  test.skip(({ isMobile }) => isMobile, "pointer: fine の端末だけ");

  test("タッチ向けに大きくした対象が、デスクトップでは従来の大きさのまま", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    const heights = await page.evaluate(() => {
      const h = (selector: string) =>
        document.querySelector(selector)?.getBoundingClientRect().height;
      return {
        search: h(".header-search"),
        logout: h(".header-logout"),
        title: h(".entry-title"),
        chip: h(".entries .chip-link"),
      };
    });
    expect(heights.search).toBe(32);
    expect(heights.logout).toBe(32);
    expect(heights.title).toBeLessThan(TAP);
    expect(heights.chip).toBeLessThan(TAP);
  });
});
