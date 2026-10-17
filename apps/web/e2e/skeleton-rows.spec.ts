import type { Page, Route } from "@playwright/test";
import { expect, test } from "./support/fixtures";

/*
 * 一覧の読み込み中のスケルトンは、直前に受け取った一覧でタグの有る行が多ければ、行にチップの帯を持つ。
 * 帯が無いと、タグの有る本物の行より低く、読み込みが終わった瞬間に 2 行目から下がずれる。
 */

type Entry = { excerpt?: string; tags: string[] };

/** 一覧の API の応答を shape で作り替える。hold の後の応答は、release まで返さない。 */
async function controlRecent(page: Page, shape: (entry: Entry) => void) {
  let gate: Promise<void> = Promise.resolve();
  let release: () => void = () => {};
  await page.route(
    (url) => url.pathname === "/api/pages/recent",
    async (route: Route) => {
      await gate;
      const response = await route.fetch();
      const body = (await response.json()) as { pages: Entry[] };
      for (const entry of body.pages) shape(entry);
      await route.fulfill({ response, json: body });
    },
  );
  return {
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release(),
  };
}

const withTags = (entry: Entry) => {
  entry.excerpt = "抜粋を 2 行に折り返させるための、少し長めの文章。".repeat(8);
  entry.tags = ["あ", "いう"];
};

const withoutTags = (entry: Entry) => {
  withTags(entry);
  entry.tags = [];
};

const rowTops = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((rows) => {
    const listTop = rows[0]?.parentElement?.getBoundingClientRect().top ?? 0;
    return rows.map((row) => row.getBoundingClientRect().top - listTop);
  });

test("最初の読み込みのスケルトンは、チップの帯を持たない", async ({ page }) => {
  const recent = await controlRecent(page, withTags);
  recent.hold();
  await page.goto("/");
  await expect(
    page.locator(".skeleton-entries.skeleton-painted .skeleton-entry").first(),
  ).toBeVisible();
  await expect(page.locator(".skeleton-entry-chips")).toHaveCount(0);
  recent.release();
  await expect(page.locator(".entries .entry").first()).toBeVisible();
});

for (const [name, shape, tagged] of [
  ["タグの有る行が多い一覧の後", withTags, true],
  ["タグの無い行が多い一覧の後", withoutTags, false],
] as const) {
  test(`${name}の読み込み中は、スケルトンの行の高さが本物の行に合う`, async ({
    page,
    isMobile,
  }) => {
    // 主の環境のうち、デスクトップは幅を切り替え、iPhone（タッチ）はその幅で測る
    for (const width of isMobile ? [undefined] : [1280, 375]) {
      if (width !== undefined) await page.setViewportSize({ width, height: 800 });
      const label = `幅 ${width ?? "端末"}`;
      const recent = await controlRecent(page, shape);
      await page.goto("/");
      await expect(page.locator(".entries .entry").first()).toBeVisible();

      // 一覧から別の画面へ移って戻ると、一覧を取り直す間はスケルトンが出る
      recent.hold();
      await page.locator(".entries .entry-title").first().click();
      await expect(page.locator("h1.note-title, .title-input").first()).toBeVisible();
      await page.goBack();
      await expect(
        page.locator(".skeleton-entries.skeleton-painted .skeleton-entry").first(),
      ).toBeVisible();
      await expect(page.locator(".skeleton-entries .skeleton-entry-chips"), label).toHaveCount(
        tagged ? 5 : 0,
      );
      const skeleton = await rowTops(page, ".skeleton-entries .skeleton-entry");
      recent.release();
      await expect(page.locator(".entries .entry").first()).toBeVisible();
      const actual = await rowTops(page, ".entries .entry");

      expect(actual.length, `${label}: 比べる行が足りない`).toBeGreaterThanOrEqual(skeleton.length);
      skeleton.forEach((top, i) => {
        expect(actual[i], `${label}: ${i + 1} 行目の上端（スケルトン ${top}）`).toBeCloseTo(top, 0);
      });
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });
}
