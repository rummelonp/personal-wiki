import type { Page } from "@playwright/test";
import {
  bodyEditor,
  expect,
  saveState,
  test,
  typeAtBodyEnd,
  uniqueTitle,
} from "./support/fixtures";

/*
 * 書き留める流れ: 新規作成 → 本文に入力 → 自動保存 → 再読み込みで残っている。
 * 入力は keyboard.type で、日本語の変換（IME）は対象外。
 *
 * 作成のレスポンスを待たずに打ち始める。新規作成の画面は、開く操作の中で入力欄にフォーカスし、作った後も
 * 同じエディタを使い続けるので、最初の文字から残るはず。
 */

/** caret が本文にある前提でそのまま打ち、作成と保存を待つ。 */
async function typeRightAwayAndSave(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text);
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  await expect(bodyEditor(page)).toHaveText(text);
  await expect(saveState(page)).toHaveText("保存済み");
}

async function expectKeptAfterReload(page: Page, title: string, text: string): Promise<void> {
  await page.reload();
  await expect(page.locator(".title-input")).toHaveText(title);
  await expect(bodyEditor(page)).toHaveText(text);
}

test("+ から title を決めて作り、続けて書いた本文が再読み込みで残っている @smoke", async ({
  page,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "+ で作成");
  const text = "ヘッダーの新規作成から作ったページの本文 with English";
  await page.goto("/");
  await page.getByRole("button", { name: "新規作成" }).click();
  await expect(page).toHaveURL(/\/\?new$/);
  await expect(page.locator(".title-input .cm-content")).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press("Enter");
  // Android の Chrome では CodeMirror が Enter を次のフレームで処理する。同じフレームで打つと改行と
  // 本文が 1 つの入力にまとまり Enter が消えるので、caret が本文へ移ったのを見てから打つ（作成のレスポンスは待たない）。
  await expect(bodyEditor(page)).toBeFocused();
  await typeRightAwayAndSave(page, text);
  await expectKeptAfterReload(page, title, text);
});

test("quick switcher から作り、すぐ書いた本文が再読み込みで残っている", async ({
  page,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "switcher で作成");
  const text = "quick switcher から作ったページの本文";
  // 負荷の高い機械で起きる、エディタの chunk の読み込みの遅れを固定で再現する
  await page.route("**/assets/PageView-*.js", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "ページを検索" }).click();
  const switcher = page.getByRole("dialog", { name: "ページを検索" });
  await switcher.getByRole("combobox", { name: "検索語" }).fill(title);
  await switcher.getByRole("option", { name: `「${title}」を作成` }).click();
  await expect(switcher).toBeHidden();
  // chunk が来るまで画面はスケルトンで、本文の欄が無い。その間に打った文字は落ちるので、
  // 利用者と同じく caret が本文に入ったのを見てから打つ（作成のレスポンスは待たない）
  await expect(bodyEditor(page)).toBeFocused();
  await typeRightAwayAndSave(page, text);
  await expectKeptAfterReload(page, title, text);
});

test("本文を編集した直後に「このページを削除」を 1 回押すと、保存の間でも確認が開き、保存の後に削除する", async ({
  page,
  api,
  hasTouch,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "編集直後の削除");
  const created = await api.createPage({ title, body: "削除の検査に使う本文" });
  await page.goto(`/p/${created.id}`);
  await expect(page.locator(".title-input")).toHaveText(title);
  // 保存を止め、押した時点で本文の blur が始めた保存が終わっていないようにする
  let releaseSaves: () => void = () => {};
  const saves = new Promise<void>((resolve) => {
    releaseSaves = resolve;
  });
  let saveRequests = 0;
  await page.route(`**/api/pages/${created.id}`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    saveRequests += 1;
    await saves;
    return route.fallback();
  });

  await typeAtBodyEnd(page, "追記");
  let confirmMessage = "";
  page.once("dialog", (dialog) => {
    confirmMessage = dialog.message();
    void dialog.accept();
  });
  const remove = page.getByRole("button", { name: "このページを削除" });
  // タッチの端末では、タップから作られる event の順でも届くことを見る
  if (hasTouch) await remove.tap();
  else await remove.click();
  await expect.poll(() => confirmMessage).toContain(`「${title}」を削除しますか？`);
  await expect(page.getByRole("button", { name: "削除中…" })).toBeDisabled();
  expect((await page.request.get(`/api/pages/${created.id}`)).status()).toBe(200);

  releaseSaves();
  await expect(page).toHaveURL(/\/$/);
  expect(saveRequests).toBe(1);
  expect((await page.request.get(`/api/pages/${created.id}`)).status()).toBe(404);
});
