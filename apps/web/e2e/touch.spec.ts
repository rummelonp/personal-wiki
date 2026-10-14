import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalScroll, test, uniqueTitle } from "./support/fixtures";
import { SEED } from "./support/seed";

/*
 * 指で押す端末（iPhone 幅の WebKit、pointer: coarse）で、主なタップ対象の当たり判定が 44px 以上であり、
 * 隣の対象と重ならないこと。デスクトップでは密度を変えないことも確かめる。
 * 当たり判定は要素の箱で測る。一覧の title だけは横幅を疑似要素（::after）で広げるので、その幅も含める。
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
  ".toc > summary",
  ".segmented-option",
  ".rail .button",
  ".chips .chip-link",
];

interface Box {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 画面に在ることを確かめたい selector（required）のうち、この要素が当てはまるもの。 */
  matched: string[];
}

async function targetBoxes(page: Page, required: string[]): Promise<Box[]> {
  return page.evaluate(
    ({ selectors, required }) => {
      const boxes: Box[] = [];
      for (const element of document.querySelectorAll(selectors.join(","))) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const after = getComputedStyle(element, "::after");
        const afterWidth = after.position === "absolute" ? Number.parseFloat(after.width) : 0;
        const label = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
        boxes.push({
          name: `${element.tagName.toLowerCase()}.${[...element.classList].join(".")} 「${label.slice(0, 20)}」`,
          x: rect.x,
          y: rect.y,
          width: Math.max(rect.width, afterWidth),
          height: rect.height,
          matched: required.filter((selector) => element.matches(selector)),
        });
      }
      return boxes;
    },
    { selectors: TARGETS, required },
  );
}

/** required は、画面に 1 つは在るはずの対象の selector（TARGETS のどれかに当てはまるもの）。 */
async function expectTapTargets(page: Page, required: string[]): Promise<Box[]> {
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  const boxes = await targetBoxes(page, required);
  for (const selector of required) {
    expect(
      boxes.some((b) => b.matched.includes(selector)),
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
  return boxes;
}

test.describe("タップ対象", () => {
  test.skip(({ isMobile }) => !isMobile, "pointer: coarse の端末だけ");
  test.use({ viewport: { width: 375, height: 812 } });

  test("owner の一覧", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await expect(page.locator(".rail .chip-link").first()).toBeVisible();
    await expectTapTargets(page, [
      ".brand",
      ".header-search",
      ".header-new",
      ".header-logout",
      ".entry-title",
      ".entries .chip-link",
      ".rail .chip-link",
    ]);
  });

  test("一覧の行とヘッダーの見た目の寸法は、押す範囲を広げても間延びしない", async ({
    page,
    api,
  }, testInfo) => {
    // 他のテストが draft を作り続けると seed の公開ページが一覧の先頭から外れるので、行を自分で作る
    await api.createPage({
      title: uniqueTitle(testInfo, "寸法"),
      body: "寸法の検査に使う抜粋の文章。 #寸法検査",
      visibility: "public",
    });
    await page.goto("/");
    await expect(page.locator(".entries .entry-excerpt").first()).toBeVisible();
    const m = await page.evaluate(() => {
      // 他のテストが作ったページは抜粋もタグも持たないので、両方を持つ行を選ぶ。短い title のすぐ隣に
      // 印が付くことも見るので、公開の印を持つ行にする
      const entry = document.querySelector(
        ".entries .entry:has(.entry-excerpt):has(.chip-link):has(.chip-public)",
      );
      // 他のテストが作ったページが上に積もると画面の外へ押し出され、elementFromPoint が何も返さない
      entry?.scrollIntoView({ block: "center" });
      const box = (selector: string) => {
        const element = entry?.querySelector(selector);
        if (element === null || element === undefined) throw new Error(`${selector} が無い`);
        return element.getBoundingClientRect();
      };
      const title = box(".entry-title");
      const excerpt = box(".entry-excerpt");
      const chip = box(".chip-link");
      // 箱から押す範囲の余りを除いた、見える字と丸い背景の縁。1.7 は line-height、他は字の大きさと padding（px）
      const titleTextBottom = title.bottom - (title.height - 16 * 1.7) / 2;
      const pillTop = chip.top + (chip.height - (2 * 4 + 12 * 1.7)) / 2;
      const hit = (x: number, y: number, selector: string) =>
        document.elementFromPoint(x, y)?.closest(selector) != null;
      // 1 文字の title でも横に 44px 押せ、title の箱は字の幅のままで、隣の印との間が開かない
      const shortTitle = () => {
        const link = entry?.querySelector<HTMLElement>(".entry-title");
        if (link === null || link === undefined) throw new Error(".entry-title が無い");
        const text = link.textContent;
        link.textContent = "夜";
        const rect = link.getBoundingClientRect();
        const badge = entry?.querySelector(".chip-public")?.getBoundingClientRect();
        if (badge === undefined) throw new Error(".chip-public が無い");
        const result = {
          shortTitleWidth: rect.width,
          badgeGap: badge.left - rect.right,
          shortTitleFarHit: hit(rect.x + 42, rect.y + rect.height / 2, ".entry-title"),
        };
        link.textContent = text;
        return result;
      };
      return {
        header: document.querySelector(".header")?.getBoundingClientRect().height ?? 0,
        titleToExcerpt: excerpt.top - titleTextBottom,
        excerptToPill: pillTop - excerpt.bottom,
        titleBottomHit: hit(title.x + 10, title.bottom - 2, ".entry-title"),
        ...shortTitle(),
        chipTopHit: hit(chip.x + chip.width / 2, chip.top + 2, ".chip-link"),
      };
    });
    expect(m.header, "ヘッダーの高さ（PC は 56px）").toBeLessThanOrEqual(60);
    expect(m.titleToExcerpt, "title から抜粋までの見た目の間隔（PC は 4px）").toBeLessThanOrEqual(
      6,
    );
    expect(m.excerptToPill, "抜粋からタグまでの見た目の間隔（PC は 4px）").toBeLessThanOrEqual(6);
    expect(m.titleBottomHit, "抜粋に重ねても title の下端が押せる").toBe(true);
    expect(m.shortTitleWidth, "1 文字の title の箱は字の幅のまま").toBeLessThan(TAP / 2);
    expect(m.shortTitleFarHit, "1 文字の title でも左端から 42px の所が押せる").toBe(true);
    expect(m.badgeGap, "1 文字の title と公開の印の間（PC は 12px）").toBeLessThanOrEqual(14);
    expect(m.chipTopHit, "抜粋に重ねてもタグの上端が押せる").toBe(true);
  });

  test("owner のページの編集（公開の切り替え、backlink、目次）", async ({ page, seedIds }) => {
    await page.goto(`/p/${seedIds[SEED.welcome]}`);
    await expect(page.locator(".title-input")).toHaveText(SEED.welcome);
    await expect(page.locator(".rail-list a").first()).toBeVisible();
    await expect(page.locator(".segmented-option").first()).toBeVisible();
    await expectTapTargets(page, [".segmented-option", ".brand", ".rail-list a"]);
    await page.goto(`/p/${seedIds[SEED.server]}`);
    await expect(page.locator(".title-input")).toHaveText(SEED.server);
    await expect(page.locator(".rail-list a").first()).toBeVisible();
    await expectTapTargets(page, [".rail-list a"]);
  });

  test("見出しの多いページの目次", async ({ page, seedIds }) => {
    await page.goto(`/p/${seedIds[SEED.longPage]}`);
    await expect(page.locator(".title-input")).toHaveText(SEED.longPage);
    // 狭い画面の目次は title の下に畳んであるので、開いてから測る
    const toc = page.locator("details.toc");
    await toc.locator("summary").click();
    await expect(toc.locator(".outline-link").first()).toBeVisible();
    await expectTapTargets(page, [".toc > summary", ".toc .outline-link"]);
  });

  test.describe("匿名", () => {
    test.use({ role: "anonymous" });

    test("一覧と public のページ", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator(".entries .entry").first()).toBeVisible();
      await expectTapTargets(page, [".brand", ".header .button-compact", ".entry-title"]);
      await page.goto(`/${encodeURIComponent(SEED.server)}`);
      await expect(page.getByRole("heading", { level: 1, name: SEED.server })).toBeVisible();
      await expectTapTargets(page, [".brand"]);
      await page.goto(`/${encodeURIComponent(SEED.manyTags)}`);
      await expect(page.getByRole("heading", { level: 1, name: SEED.manyTags })).toBeVisible();
      await expectTapTargets(page, [".chips .chip-link"]);
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
      await expectTapTargets(page, [".brand"]);
      // 操作が右の余白（左と同じ 12px）を食わずに収まる
      const edge = await page.evaluate(() => {
        const last = [...document.querySelectorAll(".header-actions > *")].at(-1);
        return last?.getBoundingClientRect().right ?? 0;
      });
      expect(edge, "ヘッダーの右端の操作の右端").toBeLessThanOrEqual(320 - 12 + 0.5);
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
    // 行の高さは line-height（1.7）× 字の大きさ。タッチ向けの箱の拡大が PC に及んでいないことを見る
    expect(heights.title).toBeCloseTo(16 * 1.7, 0);
    expect(heights.chip).toBeCloseTo(12 * 1.7, 0);
  });
});
