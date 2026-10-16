import type { Page } from "@playwright/test";
import {
  bodyEditor,
  expect,
  saveState,
  test,
  typeAtBodyEnd,
  uniqueTitle,
} from "./support/fixtures";
import { E2E_ORIGIN } from "./support/stack";

/*
 * 右の列の履歴。owner の保存は 10 分ごとに 1 つの版にまとまり、公開範囲の切り替えがまとまりを区切る。
 * 版を開くダイアログは読み取り専用で、画面の本文の編集に影響しない。
 */

const history = (page: Page) => page.locator(".rail-section-history");
const entries = (page: Page) => history(page).locator(".revision-entry");
const viewer = (page: Page) => page.getByRole("dialog");

test("版を時刻と作成者で並べ、押した版の本文を読み取り専用で開く", async ({
  page,
  api,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "履歴");
  // 作成、公開（版を積まずに区切る）、保存で、版は 2 つになる
  const created = await api.createPage({ title, body: "最初の本文", visibility: "public" });
  await api.updatePage(created, { body: "二つ目の本文" });

  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page)).toContainText("二つ目の本文");
  await expect(history(page).getByRole("heading", { name: "履歴" })).toBeVisible();
  await expect(entries(page)).toHaveCount(2);
  await expect(entries(page).first()).toContainText("1 分未満");
  await expect(entries(page).first()).toContainText("オーナー");
  // 版の番号は飛ぶので見せない
  await expect(history(page)).not.toContainText("版");

  // キーボードで開くと、閉じた後に焦点が押した行へ戻る
  await entries(page).nth(1).focus();
  await page.keyboard.press("Enter");
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page).getByRole("heading", { name: title })).toBeVisible();
  await expect(viewer(page)).toContainText("読み取り専用");
  const oldBody = viewer(page).locator(".cm-content");
  await expect(oldBody).toHaveText("最初の本文");
  await oldBody.click();
  await page.keyboard.type("書き換え");
  await expect(oldBody).toHaveText("最初の本文");

  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
  await expect(entries(page).nth(1)).toBeFocused();
  await expect(bodyEditor(page)).toHaveText("二つ目の本文");
});

test("保存すると履歴を取り直し、10 分のうちの保存は先頭の版にまとまる", async ({
  page,
  api,
}, testInfo) => {
  const created = await api.createPage({ title: uniqueTitle(testInfo, "まとめ"), body: "本文" });
  await page.goto(`/p/${created.id}`);
  await expect(entries(page)).toHaveCount(1);

  const refetched = page.waitForResponse(
    (res) => res.url().endsWith(`/api/pages/${created.id}/revisions`) && res.status() === 200,
  );
  await typeAtBodyEnd(page, "を足す");
  await expect(saveState(page)).toHaveText("保存済み");
  // まとめた版は番号が進むので、取り直した一覧の先頭は今の版の番号になる
  const json = (await (await refetched).json()) as { revisions: { version: number }[] };
  expect(json.revisions.map((r) => r.version)).toEqual([2]);
  await expect(entries(page)).toHaveCount(1);

  await entries(page).first().click();
  await expect(viewer(page).locator(".cm-content")).toHaveText("本文を足す");
});

test.describe("匿名", () => {
  test.use({ role: "anonymous" });

  test("履歴の節を出さず、API は公開のページでも 401 を返す", async ({ page, api }, testInfo) => {
    const title = uniqueTitle(testInfo, "匿名の履歴");
    const created = await api.createPage({ title, body: "公開の本文", visibility: "public" });
    await page.goto(`/p/${created.id}`);
    await expect(page.getByText("公開の本文")).toBeVisible();
    await expect(history(page)).toHaveCount(0);
    for (const path of [`/revisions`, `/revisions/1`]) {
      const res = await fetch(`${E2E_ORIGIN}/api/pages/${created.id}${path}`);
      expect(res.status, path).toBe(401);
    }
  });
});
