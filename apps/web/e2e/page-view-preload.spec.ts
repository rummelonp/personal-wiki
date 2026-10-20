import type { Page } from "@playwright/test";
import { bodyEditor, expect, test, uniqueTitle } from "./support/fixtures";

/*
 * ページの URL の HTML は、ページの画面の chunk を modulepreload で指し、入口の chunk の実行を待たずに取り始める。
 * トップと絞り込みの画面は、匿名にはページの画面の chunk を取らせない。
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

test("トップと絞り込みの画面は、匿名にはページの画面の chunk を取らせない", async ({
  page,
  api,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "トップの一覧");
  await api.createPage({ title, body: "", visibility: "public" });
  const requests = recordAssetRequests(page);

  await page.goto("/");
  await expect(
    page.locator(".entries").getByRole("link", { name: title, exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.goto(`/?q=${encodeURIComponent("どこにも無い語句")}`);
  await expect(page.getByRole("heading", { name: "一致するページがありません" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  expect(requests.some((path) => ENTRY_CHUNK.test(path))).toBe(true);
  expect(requests.filter((path) => PAGE_VIEW_CHUNK.test(path))).toEqual([]);
});
