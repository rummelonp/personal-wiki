import type { Page, Route } from "@playwright/test";
import { expect, test } from "./support/fixtures";

/*
 * 一覧の相対の日付。読み込み中の帯が実際の表記より細くならないことと、
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

/** 一覧の API を、更新日が AGES で散らばった応答に差し替え、release まで止める。 */
async function holdRecent(page: Page): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === "/api/pages/recent",
    async (route: Route) => {
      await gate;
      const response = await route.fetch();
      const body = (await response.json()) as { pages: { updatedAt: number }[] };
      const now = Date.now();
      body.pages.forEach((entry, i) => {
        entry.updatedAt = now - (AGES[i % AGES.length] ?? 0);
      });
      await route.fulfill({ response, json: body });
    },
  );
  return release;
}

test("読み込み中の更新日の帯は、実際の最も長い表記より細くならない", async ({ page }) => {
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

test("更新日は相対の表記を見せ、絶対の日時を読み上げと title に持つ", async ({ page }) => {
  const release = await holdRecent(page);
  await page.goto("/");
  release();
  const time = page.locator(".entries .entry-time").nth(2);
  await expect(time).toBeVisible();
  // 見える文字は相対の表記だけ。絶対の日時は visually-hidden で、箱を持たない（行の高さと密度を変えない）
  await expect(time).toHaveText(/^約 3 時間前（\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}）$/);
  const hidden = time.locator(".visually-hidden");
  const box = await hidden.boundingBox();
  expect((box?.width ?? 0) <= 1 && (box?.height ?? 0) <= 1).toBe(true);
  await expect(time).toHaveAttribute("title", /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
  await expect(time).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
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
