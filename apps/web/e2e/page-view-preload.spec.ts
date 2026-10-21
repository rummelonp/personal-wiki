import type { Page } from "@playwright/test";
import { bodyEditor, expect, test, uniqueTitle } from "./support/fixtures";

/*
 * ページの URL の HTML は、ページの画面の chunk を modulepreload で指し、入口の chunk の実行を待たずに取り始める。
 * トップと検索の画面は一覧を出した後、404 は描いた後の手が空いたときにページの画面の chunk を取る。
 */

const ENTRY_CHUNK = /\/assets\/index-[^/]+\.js$/;
const PAGE_VIEW_CHUNK = /\/assets\/PageView-[^/]+\.js$/;

/** 開く前から、`/assets/` の取得のパスを要求の順に集める。 */
function recordAssetRequests(page: Page): string[] {
  const paths: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/assets/")) paths.push(pathname);
  });
  return paths;
}

test.use({ role: "anonymous" });

test("public のページの URL は、入口の chunk を返す前にページの画面の chunk を要求し、どの chunk も 1 度だけ取る", async ({
  page,
  api,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "先読み");
  await api.createPage({ title, body: "先読みの本文", visibility: "public" });
  const requests = recordAssetRequests(page);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  // 入口の chunk の応答を止めておき、その間にページの画面の chunk が要求されるかを見る。modulepreload が
  // 無ければ、ページの画面の chunk は入口を実行してからの動的 import で初めて要求される
  const pageViewRequested = () => requests.some((path) => PAGE_VIEW_CHUNK.test(path));
  let requestedBeforeEntry = false;
  await page.route(ENTRY_CHUNK, async (route) => {
    const deadline = Date.now() + 5_000;
    while (!pageViewRequested() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    requestedBeforeEntry = pageViewRequested();
    await route.continue();
  });

  await page.goto(`/${encodeURIComponent(title)}`);
  await expect(bodyEditor(page)).toContainText("先読みの本文");
  expect(requestedBeforeEntry).toBe(true);

  const preloads = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')].map(
      (link) => new URL(link.href).pathname,
    ),
  );
  expect(preloads.some((path) => PAGE_VIEW_CHUNK.test(path))).toBe(true);
  // 入口の動的 import と Vite の preload の helper が、modulepreload と同じ module を取り直さない
  for (const path of new Set(requests)) {
    expect(
      requests.filter((requested) => requested === path),
      path,
    ).toHaveLength(1);
  }
  expect(
    errors.filter((text) => /Content Security Policy|Content-Security-Policy/i.test(text)),
  ).toEqual([]);
});

test("トップと検索の画面は、一覧の応答の前にはページの画面の chunk を取らず、一覧を出した後に取る", async ({
  page,
  api,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "トップの一覧");
  await api.createPage({ title, body: "トップから開く本文", visibility: "public" });
  const requests = recordAssetRequests(page);
  const pageViewRequested = () => requests.some((path) => PAGE_VIEW_CHUNK.test(path));

  // 一覧の応答を遅らせている間に、ページの画面の chunk が要求されないことを見る。要求されれば、
  // 一覧の取得と帯域を取り合い、トップの LCP が遅れる。route を張ると HTTP キャッシュが効かなくなるので、
  // 2 度目に開いたときも chunk を取り直し、要求として数えられる
  const requestedBeforeList: boolean[] = [];
  for (const path of ["**/api/search?*", "**/api/pages/recent*"]) {
    await page.route(path, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      requestedBeforeList.push(pageViewRequested());
      await route.continue();
    });
  }

  await page.goto(`/?q=${encodeURIComponent("どこにも無い語句")}`);
  await expect(page.getByRole("heading", { name: "一致するページがありません" })).toBeVisible();
  await expect.poll(pageViewRequested).toBe(true);
  await page.waitForLoadState("networkidle");

  requests.length = 0;
  await page.goto("/");
  const link = page.locator(".entries").getByRole("link", { name: title, exact: true });
  await expect(link).toBeVisible();
  await expect.poll(pageViewRequested).toBe(true);
  expect(requestedBeforeList.length).toBeGreaterThanOrEqual(2);
  expect(requestedBeforeList.every((requested) => !requested)).toBe(true);
  await page.waitForLoadState("networkidle");

  // 先読みが済んでいれば、画面の中でページへ移るときに chunk を待たずにページを取りに行く
  const requestedBeforeClick = requests.length;
  await link.click();
  await expect(bodyEditor(page)).toContainText("トップから開く本文");
  expect(requests.slice(requestedBeforeClick).filter((path) => PAGE_VIEW_CHUNK.test(path))).toEqual(
    [],
  );
});

test("404 の画面は、描いた後にページの画面の chunk を取る", async ({ page }) => {
  const requests = recordAssetRequests(page);
  await page.goto("/p/short");
  await expect(page.getByRole("heading", { name: "ページが見つかりません" })).toBeVisible();
  await expect.poll(() => requests.some((path) => PAGE_VIEW_CHUNK.test(path))).toBe(true);
});
