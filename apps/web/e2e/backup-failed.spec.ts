import type { Page, Route, TestInfo } from "@playwright/test";
import type { ApiPage, OwnerApi } from "./support/api";
import {
  bodyEditor,
  expect,
  saveState,
  test,
  typeAtBodyEnd,
  uniqueTitle,
} from "./support/fixtures";

/*
 * 端末に退避できないとき: 保存や作成に失敗し、localStorage への退避も書けなければ、通知の見出しで
 * 内容が画面にしか無いことを伝える。通知を畳むと見出しだけが残るので、見出しで確かめる。
 * 退避の書き込みは Storage.prototype.setItem を容量超過で投げるよう差し替えて失敗させ、
 * 保存と作成の失敗は API の応答を page.route で差し替えて起こす。
 */

const FIRST_LINE = "最初からある行";
const DRAFT_KEY_PREFIX = "personal-wiki:draft:";

test.beforeEach(async ({ page }) => {
  await page.addInitScript((prefix) => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith(prefix)) {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
      setItem.call(this, key, value);
    };
  }, DRAFT_KEY_PREFIX);
});

function fulfillWith(status: number, error: string) {
  return (route: Route) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error }) });
}

async function openFreshPage(page: Page, api: OwnerApi, title: string): Promise<ApiPage> {
  const created = await api.createPage({ title, body: FIRST_LINE });
  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page)).toHaveText(FIRST_LINE);
  await expect(saveState(page)).toHaveText("保存済み");
  return created;
}

/** 保存の PUT だけを status で失敗させて打つ。 */
async function typeWithSaveFailing(
  page: Page,
  created: ApiPage,
  status: number,
  error: string,
  typed: string,
): Promise<void> {
  const fail = fulfillWith(status, error);
  await page.route(`**/api/pages/${created.id}`, (route) =>
    route.request().method() === "PUT" ? fail(route) : route.fallback(),
  );
  await typeAtBodyEnd(page, typed);
}

function alertWithHeading(page: Page, name: string) {
  return page.getByRole("alert").filter({ has: page.getByRole("heading", { name }) });
}

async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-${name}.png`) });
}

test("保存が 500 で退避も書けないと、見出しで内容が画面にしか無いことを伝える", async ({
  page,
  api,
}, testInfo) => {
  const created = await openFreshPage(page, api, uniqueTitle(testInfo, "退避できない保存"));
  const typed = "、退避できない保存";
  await typeWithSaveFailing(page, created, 500, "internal", typed);
  const alert = alertWithHeading(page, "保存できず、内容を端末に退避できませんでした");
  await expect(alert).toContainText("画面を閉じる前に、内容をコピーして残してください。");
  await expect(bodyEditor(page)).toHaveText(FIRST_LINE + typed);
  await shoot(page, testInfo, "save-failed");
});

test("作成が 500 で退避も書けないと、見出しで内容が画面にしか無いことを伝える", async ({
  page,
}, testInfo) => {
  const fail = fulfillWith(500, "internal");
  await page.route("**/api/pages", (route) =>
    route.request().method() === "POST" ? fail(route) : route.fallback(),
  );
  await page.goto("/");
  await expect(page.locator(".entries .entry").first()).toBeVisible();
  await page.getByRole("button", { name: "新規作成" }).click();
  await expect(page).toHaveURL(/\/\?new$/);
  await expect(page.locator(".title-input .cm-content")).toBeFocused();
  await page.keyboard.type(uniqueTitle(testInfo, "退避できない作成"));
  await page.keyboard.press("Enter");
  const body = "作れず退避もできない本文";
  await page.keyboard.type(body);
  const alert = alertWithHeading(page, "作成できず、内容を端末に退避できませんでした");
  await expect(alert).toContainText("画面を閉じる前に、内容をコピーして残してください。");
  await expect(page).toHaveURL(/\/\?new$/);
  await expect(bodyEditor(page)).toHaveText(body);
  await shoot(page, testInfo, "create-failed");
});

test("ログインが切れて退避も書けないと、見出しで内容が画面にしか無いことを伝える", async ({
  page,
  api,
}, testInfo) => {
  const created = await openFreshPage(page, api, uniqueTitle(testInfo, "退避できないログイン切れ"));
  const typed = "、退避できないログイン切れ";
  await typeWithSaveFailing(page, created, 401, "unauthorized", typed);
  const alert = alertWithHeading(page, "ログインの期限が切れ、内容を端末に退避できませんでした");
  await expect(alert).toContainText("ログインし直す前に、内容をコピーして残してください。");
  await expect(saveState(page)).toHaveText("ログインが切れました");
  await expect(bodyEditor(page)).toHaveText(FIRST_LINE + typed);
  await shoot(page, testInfo, "auth-lost");
});

test("ページが消えていて退避も書けないと、新しいページとして作る案内を出さない", async ({
  page,
  api,
}, testInfo) => {
  const created = await openFreshPage(page, api, uniqueTitle(testInfo, "退避できない削除"));
  const typed = "、退避できない削除";
  await typeWithSaveFailing(page, created, 404, "not_found", typed);
  const alert = alertWithHeading(
    page,
    "このページはサーバーになく、内容を端末に退避できませんでした",
  );
  await expect(alert).toContainText("画面を離れる前に、内容をコピーして残してください。");
  await expect(alert.getByRole("button", { name: "新しいページとして作る" })).toHaveCount(0);
  await expect(saveState(page)).toHaveText("ページがありません");
  await expect(bodyEditor(page)).toHaveText(FIRST_LINE + typed);
  await shoot(page, testInfo, "gone");
});
