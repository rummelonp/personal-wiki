import type { Locator, Page } from "@playwright/test";
import type { ApiPage, OwnerApi } from "./support/api";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";

/*
 * title が違うときに出す 2 行の見出し（.conflict-titles）。
 * 衝突の通知と版の差分で、名前と title の最初の行のベースラインがそろう。
 * 名前は小さい字なので、上端でそろえると title の文字より上に浮く。
 */

const LONG = "とても長い題名が欄の幅で折り返して複数の行になる場合の例".repeat(3);

const history = (page: Page) => page.locator(".rail-section-history");
const viewer = (page: Page) => page.getByRole("dialog");

/** 幅 0 の inline-block の下端は、その行のベースラインに載る */
async function baselineGaps(titles: Locator): Promise<number[]> {
  return titles.evaluate((list) => {
    const baseline = (element: Element) => {
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0";
      element.prepend(probe);
      const y = probe.getBoundingClientRect().bottom;
      probe.remove();
      return y;
    };
    return [...list.querySelectorAll("dt")].map((term) => {
      const detail = term.nextElementSibling as Element;
      return Math.abs(baseline(term) - baseline(detail));
    });
  });
}

async function expectAligned(titles: Locator): Promise<void> {
  await expect(titles).toBeVisible();
  const gaps = await baselineGaps(titles);
  expect(gaps).toHaveLength(2);
  for (const gap of gaps) expect(gap).toBeLessThanOrEqual(1);
}

const CASES = [
  { name: "1 行の title", suffix: "を改めた" },
  { name: "折り返す title", suffix: LONG },
];

for (const { name, suffix } of CASES) {
  test(`版の差分の title の見出しは、${name}でも名前と title の文字の下端がそろう`, async ({
    page,
    api,
  }, testInfo) => {
    const title = uniqueTitle(testInfo, "見出しの差分");
    const created = await api.createPage({ title, body: "共通\n消える行", visibility: "public" });
    await api.updatePage(created, { title: `${title}${suffix}`, body: "共通\n加わる行" });

    await page.goto(`/p/${created.id}`);
    const entries = history(page).locator(".revision-entry");
    await expect(entries).toHaveCount(2);
    await entries.first().click();
    await expectAligned(viewer(page).locator(".revision-diff-titles"));
  });

  test(`衝突の title の見出しは、${name}でも名前と title の文字の下端がそろう`, async ({
    page,
    api,
  }, testInfo) => {
    const created = await openPage(page, api, uniqueTitle(testInfo, "見出しの衝突"));
    await collide(page, api, created, `${created.title}${suffix}`);
    await expectAligned(page.locator(".notice .conflict-titles"));
  });
}

async function openPage(page: Page, api: OwnerApi, title: string): Promise<ApiPage> {
  const created = await api.createPage({ title, body: "最初の行\n二つ目の行" });
  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page)).toContainText("最初の行");
  await expect(saveState(page)).toHaveText("保存済み");
  return created;
}

/** 手元の保存の直前に別の場所で title と本文を変えて、衝突にする */
async function collide(
  page: Page,
  api: OwnerApi,
  created: ApiPage,
  serverTitle: string,
): Promise<void> {
  let external: Promise<ApiPage> | undefined;
  await page.route(`**/api/pages/${created.id}`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    external ??= api.updatePage(created, { title: serverTitle, body: "最初の行\n別の場所の行" });
    const updated = await external.then(
      () => true,
      () => false,
    );
    return updated ? route.fallback() : route.abort();
  });
  await bodyEditor(page).locator(".cm-line").nth(1).click();
  await page.keyboard.press("End");
  await page.keyboard.type("、手元の変更");
  await expect.poll(() => external, "保存が送られない").toBeDefined();
  await expect(page.getByRole("heading", { name: "別の場所でも更新されています" })).toBeVisible();
}
