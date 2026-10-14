import type { Page, Route } from "@playwright/test";
import {
  bodyEditor,
  expect,
  expectNoHorizontalScroll,
  saveState,
  test,
  uniqueTitle,
} from "./support/fixtures";
import { SEED } from "./support/seed";

/*
 * 新規作成の画面（`/?new`）: title を決めた時点で作り、作る前後で編集の画面を作り直さない。
 * 作成の失敗（title の重複、401、オフライン）では、打った内容が残り、直し方が出て、直せば作れる。
 * 401 は作成の POST だけを page.route で差し替える。重複は seed の title で実際に起こす。
 */

const CREATE = "**/api/pages";
const isCreate = (route: Route) => route.request().method() === "POST";
const titleEditor = (page: Page) => page.locator(".title-input .cm-content");

async function openFromPlus(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".entries .entry").first()).toBeVisible();
  await page.getByRole("button", { name: "新規作成" }).click();
  await expect(page).toHaveURL(/\/\?new$/);
  await expect(titleEditor(page)).toBeFocused();
}

/** title 欄で打って Enter し、続けて本文を打つ。 */
async function typeTitleThenBody(page: Page, title: string, body: string): Promise<void> {
  await page.keyboard.type(title);
  await page.keyboard.press("Enter");
  await page.keyboard.type(body);
}

async function expectCreatedAndKept(page: Page, title: string, body: string): Promise<void> {
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  await expect(bodyEditor(page)).toHaveText(body);
  await expect(saveState(page)).toHaveText("保存済み");
  await page.reload();
  await expect(page.locator(".title-input")).toHaveText(title);
  await expect(bodyEditor(page)).toHaveText(body);
}

test("作る POST が遅くても、待つ間に打った本文は残り、本文のエディタは同じ要素のまま", async ({
  page,
}, testInfo) => {
  await page.route(CREATE, async (route) => {
    if (!isCreate(route)) return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return route.fallback();
  });
  const title = uniqueTitle(testInfo, "遅い作成");
  const body = "作成を待つ間に打った本文";
  await openFromPlus(page);
  await bodyEditor(page).evaluate((element) => element.setAttribute("data-e2e-mark", "before"));
  await typeTitleThenBody(page, title, body);
  await expect(saveState(page)).toHaveText("作成中…");
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  await expect(bodyEditor(page)).toHaveAttribute("data-e2e-mark", "before");
  await expect(bodyEditor(page)).toHaveText(body);
  await expectCreatedAndKept(page, title, body);
});

test("存在しないリンクの「作成して開く」から、すぐ打った最初の文字から残る", async ({
  page,
  api,
}, testInfo) => {
  const missing = uniqueTitle(testInfo, "リンク先");
  const source = await api.createPage({
    title: uniqueTitle(testInfo, "リンク元"),
    body: `[[${missing}]]`,
  });
  await page.goto(`/p/${source.id}`);
  await expect(saveState(page)).toHaveText("保存済み");
  await bodyEditor(page).locator(".cm-wikilink", { hasText: missing }).click();
  const notice = page
    .getByRole("alert")
    .filter({ hasText: `「${missing}」のページはまだありません` });
  await notice.getByRole("button", { name: "作成して開く" }).click();
  const body = "リンクから作ったページの本文";
  await page.keyboard.type(body);
  await expectCreatedAndKept(page, missing, body);
});

test("存在しない title の画面の「このタイトルで作成」から、すぐ打った最初の文字から残る", async ({
  page,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "まだ無い");
  await page.goto(`/${encodeURIComponent(title)}`);
  await page.getByRole("button", { name: "このタイトルで作成" }).click();
  const body = "まだ無いページの画面から作った本文";
  await page.keyboard.type(body);
  await expectCreatedAndKept(page, title, body);
});

test("title が空のままでは Enter でも作らず、本文を打っても /?new に留まる", async ({ page }) => {
  let creates = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/pages") creates++;
  });
  await openFromPlus(page);
  // 空の title の Enter は打ち終えたとみなさず、欄にとどまる
  await page.keyboard.press("Enter");
  await expect(titleEditor(page)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(bodyEditor(page)).toBeFocused();
  await page.keyboard.type("title の無い本文");
  // 自動保存は入力が止まって 2 秒後に走る。それを過ぎても作らないことを見る
  await page.waitForTimeout(3_000);
  expect(creates).toBe(0);
  await expect(page).toHaveURL(/\/\?new$/);
  await expect(saveState(page)).toHaveText("タイトルを決めると保存します");
  await expect(bodyEditor(page)).toHaveText("title の無い本文");
});

test("内容のある /?new の + は title 欄へ移るだけで、離れた後の + は復元を尋ねる", async ({
  page,
}) => {
  await openFromPlus(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("打ちかけの本文");
  await page.getByRole("button", { name: "新規作成" }).click();
  await expect(titleEditor(page)).toBeFocused();
  await expect(page).toHaveURL(/\/\?new$/);
  await expect(bodyEditor(page)).toHaveText("打ちかけの本文");

  await page.getByRole("link", { name: "personal-wiki" }).click();
  await expect(page.locator(".entries .entry").first()).toBeVisible();
  await page.getByRole("button", { name: "新規作成" }).click();
  await expect(page.getByText("この端末に退避されています", { exact: false })).toBeVisible();
});

test("title が重複して作れないと、打った内容を残して直し方を出し、title を直すと作れる", async ({
  page,
}, testInfo) => {
  const body = "重複した title で打った本文";
  await openFromPlus(page);
  await typeTitleThenBody(page, SEED.server, body);
  const alert = page.getByRole("alert").filter({ hasText: "作成できませんでした。" });
  await expect(alert).toContainText("タイトルを変えて Enter を押すと、もう一度作ります。");
  await expect(alert.getByRole("link", { name: "そのページを開く" })).toBeVisible();
  await expect(saveState(page)).toHaveText("作成に失敗");
  await expect(page).toHaveURL(/\/\?new$/);
  await expect(bodyEditor(page)).toHaveText(body);

  const suffix = ` ${uniqueTitle(testInfo, "直した")}`;
  await titleEditor(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(suffix);
  await page.keyboard.press("Enter");
  await expect(alert).toBeHidden();
  await expectCreatedAndKept(page, `${SEED.server}${suffix}`, body);
});

test("作成が 401 になるとログインし直す案内が出て、打った内容が残り、再試行で作れる", async ({
  page,
}, testInfo) => {
  await page.route(CREATE, (route) =>
    isCreate(route)
      ? route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "unauthorized" }),
        })
      : route.fallback(),
  );
  const title = uniqueTitle(testInfo, "作成で 401");
  const body = "ログインが切れても残る本文";
  await openFromPlus(page);
  await typeTitleThenBody(page, title, body);
  const alert = page.getByRole("alert").filter({ hasText: "ログインの期限が切れました" });
  await expect(alert).toContainText("未保存の内容はこの端末に退避してあります。");
  await expect(saveState(page)).toHaveText("ログインが切れました");
  await expect(bodyEditor(page)).toHaveText(body);

  await page.unroute(CREATE);
  await alert.getByRole("button", { name: "ログインし直したので再試行" }).click();
  await expect(alert).toBeHidden();
  await expectCreatedAndKept(page, title, body);
});

test("オフラインで作れないと失敗の案内が出て、打った内容が残り、戻ってからもう一度作れる", async ({
  page,
  context,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "作成でオフライン");
  const body = "オフラインでも残る本文";
  await openFromPlus(page);
  await context.setOffline(true);
  await typeTitleThenBody(page, title, body);
  const alert = page.getByRole("alert").filter({ hasText: "作成できませんでした。" });
  await expect(alert).toContainText("サーバーに接続できない");
  await expect(saveState(page)).toHaveText("作成に失敗");
  await expect(bodyEditor(page)).toHaveText(body);

  await context.setOffline(false);
  await alert.getByRole("button", { name: "もう一度作成する" }).click();
  await expect(alert).toBeHidden();
  await expectCreatedAndKept(page, title, body);
});

test("/?new に横スクロールが出ない", async ({ page }) => {
  await page.goto("/?new");
  await expect(titleEditor(page)).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test.describe("匿名", () => {
  test.use({ role: "anonymous" });

  test("/?new を開くと、作成の画面を出さずにログインを案内する", async ({ page }) => {
    await page.goto("/?new");
    await expect(page.getByRole("heading", { name: "ログインが必要です" })).toBeVisible();
    await expect(page.locator(".cm-editor")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "新規作成" })).toHaveCount(0);
  });
});
