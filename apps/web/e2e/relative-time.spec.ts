import type { Page, Route } from "@playwright/test";
import { expect, test } from "./support/fixtures";

/*
 * 一覧の相対の日付。読み込み中のスケルトンが実際の表記より細くならないことと、
 * タッチ端末にも届く形で絶対の日時を持つことを確かめる。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 最も長い表記（2 桁の時間の「約 20 時間前」）と、1 桁の時間、年を含める
const AGES = [
  20_000,
  7 * MINUTE,
  3 * HOUR,
  20 * HOUR,
  26 * HOUR,
  5 * DAY,
  45 * DAY,
  400 * DAY,
  1000 * DAY,
];

type Entry = { updatedAt: number; excerpt?: string; tags: string[] };

/**
 * 一覧の API を、更新日が AGES で散らばったレスポンスに差し替え、release まで止める。
 * shape で、行の中身（抜粋やタグ）も差し替えられる。
 */
async function holdRecent(page: Page, shape?: (entry: Entry) => void): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === "/api/pages/recent",
    async (route: Route) => {
      await gate;
      const response = await route.fetch();
      const body = (await response.json()) as { pages: Entry[] };
      const now = Date.now();
      body.pages.forEach((entry, i) => {
        entry.updatedAt = now - (AGES[i % AGES.length] ?? 0);
        shape?.(entry);
      });
      await route.fulfill({ response, json: body });
    },
  );
  return release;
}

test("読み込み中の更新日のスケルトンは、実際の最も長い表記より細くならない", async ({ page }) => {
  const release = await holdRecent(page);
  await page.goto("/");
  const band = page.locator(".skeleton-entries.skeleton-painted .skeleton-entry-time").first();
  await expect(band).toBeVisible();
  const bandWidth = (await band.boundingBox())?.width ?? 0;
  release();

  await expect(page.locator(".entries .entry-time").first()).toBeVisible();
  // 絶対の日時は読み上げにだけ足すので、見える文字（最初の text node）の幅で比べる
  const widest = await page.locator(".entries .entry-time").evaluateAll((times) =>
    Math.max(
      ...times.map((time) => {
        const range = document.createRange();
        range.selectNodeContents(time.firstChild as Node);
        return range.getBoundingClientRect().width;
      }),
    ),
  );
  expect(bandWidth).toBeGreaterThanOrEqual(widest);
});

test("更新日は相対の表記だけを本文に持ち、絶対の日時は読み上げと title に届く", async ({
  page,
}) => {
  const release = await holdRecent(page);
  await page.goto("/");
  release();
  const time = page.locator(".entries .entry-time").nth(2);
  await expect(time).toBeVisible();
  await expect(time).toHaveText("約 3 時間前");
  await expect(time).toHaveAttribute("title", /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
  await expect(time).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);

  // 絶対の日時は本文に無いので、範囲選択（コピー）の文字列にも innerText（ページ内検索の対象）にも出ない
  const copied = await page.evaluate(() => {
    const list = document.querySelector(".entries") as HTMLElement;
    getSelection()?.selectAllChildren(list);
    return { selection: getSelection()?.toString() ?? "", text: list.innerText };
  });
  expect(copied.selection).not.toMatch(/\d{4}\/\d{2}\/\d{2}/);
  expect(copied.text).not.toMatch(/\d{4}\/\d{2}\/\d{2}/);

  // 読み上げ（アクセシビリティツリー）には、相対の表記に続けて絶対の日時が届く
  const absolute = (await time.getAttribute("title")) ?? "";
  expect(await time.ariaSnapshot()).toBe(`- time: 約 3 時間前 （${absolute}）`);
});

test("読み込みが終わっても、各行の上端は動かない", async ({ page, isMobile }) => {
  // スケルトンの行は、抜粋が 2 行でタグの無い行の形。実際の行もその形にそろえて、行の送りを比べる
  const shape = (entry: Entry) => {
    entry.excerpt = "抜粋を 2 行に折り返させるための、少し長めの文章。".repeat(8);
    entry.tags = [];
  };
  const rowTops = (selector: string) =>
    page.locator(selector).evaluateAll((rows) => {
      const list = rows[0]?.parentElement as HTMLElement;
      const listTop = list.getBoundingClientRect().top;
      return rows.map((row) => row.getBoundingClientRect().top - listTop);
    });

  // 主の環境のうち、デスクトップは幅を切り替え、iPhone（タッチ）はその幅で測る
  for (const width of isMobile ? [undefined] : [1280, 375]) {
    if (width !== undefined) await page.setViewportSize({ width, height: 800 });
    const release = await holdRecent(page, shape);
    await page.goto("/");
    await expect(
      page.locator(".skeleton-entries.skeleton-painted .skeleton-entry").first(),
    ).toBeVisible();
    const skeleton = await rowTops(".skeleton-entries .skeleton-entry");
    const listFromTop = await page
      .locator(".skeleton-entries")
      .evaluate((list) => list.getBoundingClientRect().top);
    release();
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    const actual = await rowTops(".entries .entry");
    const actualFromTop = await page
      .locator(".entries")
      .evaluate((list) => list.getBoundingClientRect().top);

    const label = `幅 ${width ?? "端末"}`;
    expect(actual.length, `${label}: 比べる行が足りない`).toBeGreaterThanOrEqual(skeleton.length);
    expect(actualFromTop, `${label}: 一覧の上端`).toBeCloseTo(listFromTop, 0);
    skeleton.forEach((top, i) => {
      expect(actual[i], `${label}: ${i + 1} 行目の上端（スケルトン ${top}）`).toBeCloseTo(top, 0);
    });
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

// タッチ端末では title が出ないので、行から開いた先のページで絶対の日時を見られることを保つ
for (const role of ["owner", "anonymous"] as const) {
  test.describe(role, () => {
    test.use({ role });

    test("行を開いたページに、更新の絶対の日時が見える", async ({ page }) => {
      await page.goto("/");
      await page.locator(".entries .entry-title").first().click();
      const updated = page.locator(".facts dd").first();
      await expect(updated).toBeVisible();
      await expect(updated).toHaveText(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
    });
  });
}
