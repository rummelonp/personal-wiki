import type { Page } from "@playwright/test";
import type { ApiPage, OwnerApi } from "./support/api";
import {
  bodyEditor,
  expect,
  expectNoHorizontalScroll,
  saveState,
  test,
  typeAtBodyEnd,
  uniqueTitle,
} from "./support/fixtures";

/*
 * 保存の前の検査: サーバーが拒む内容（長すぎる本文と title、本文の NUL）は送らず、理由と直し方を出して
 * 端末に退避する。直せばそのまま保存する。title の重複は、既存のページを開く導線を出す。
 * 送らないことは、ページの PUT を page.route で数えて確かめる。
 */

const MAX_BODY_BYTES = 65_536;
const MAX_TITLE_BYTES = 1024;
const LINE = `${"a".repeat(99)}\n`;
const titleEditor = (page: Page) => page.locator(".title-input .cm-content");
const notice = (page: Page, title: string) =>
  page.locator(".notice").filter({ has: page.locator(".notice-title", { hasText: title }) });

/** このページへの以後の PUT の数を返す関数を返す。 */
async function countPuts(page: Page, id: string): Promise<() => number> {
  let count = 0;
  await page.route(`**/api/pages/${id}`, (route) => {
    if (route.request().method() === "PUT") count += 1;
    return route.fallback();
  });
  return () => count;
}

/** 上限まで `room` バイトを残した本文のページを開き、以後の PUT の数を返す関数を返す。 */
async function openNearLimit(
  page: Page,
  api: OwnerApi,
  title: string,
  room: number,
): Promise<{ created: ApiPage; puts: () => number }> {
  const fill = MAX_BODY_BYTES - room;
  const body = `${LINE.repeat(Math.floor(fill / LINE.length))}${"a".repeat(fill % LINE.length)}`;
  const created = await api.createPage({ title, body });
  const puts = await countPuts(page, created.id);
  await page.goto(`/p/${created.id}`);
  await expect(saveState(page)).toHaveText("保存済み");
  return { created, puts };
}

test("本文が上限を超えると送らずに超えた量を出し、減らすとそのまま保存する", async ({
  page,
  api,
}, testInfo) => {
  const { created, puts } = await openNearLimit(page, api, uniqueTitle(testInfo, "長い本文"), 4);
  const meter = page.locator(".body-meter .input-meter");
  await expect(meter).toHaveClass(/input-meter-near/);

  await typeAtBodyEnd(page, "bbbbbb");
  const over = notice(page, "本文が長すぎて保存できません");
  await expect(over).toBeVisible();
  await expect(over).toContainText("2 バイト以上減らすか、ページを分けてください。");
  await expect(saveState(page)).toHaveText("保存できません");
  await expect(meter).toHaveClass(/input-meter-over/);
  await expect(meter).toContainText("65,538 / 65,536 バイト");
  await expectNoHorizontalScroll(page);
  // 自動保存（打ってから 2 秒）と blur のどちらでも送らない
  await page.waitForTimeout(2_500);
  await bodyEditor(page).blur();
  await page.waitForTimeout(500);
  expect(puts()).toBe(0);

  // focus を戻すと caret は打った位置のまま。長い本文は見えている行だけが描かれるので、行を押して
  // 戻ると、打った位置と違う行に caret が移ることがある
  await bodyEditor(page).focus();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(over).toBeHidden();
  await expect(saveState(page)).toHaveText("保存済み");
  expect(puts()).toBeGreaterThan(0);
  const saved = await api.getPage(created.id);
  expect(saved.body.replace(/[a\n]/g, "")).toBe("bbbb");
});

test("上限を超えたまま画面を離れると送らずに退避し、開き直すと復元を選べる", async ({
  page,
  api,
}, testInfo) => {
  const { created, puts } = await openNearLimit(page, api, uniqueTitle(testInfo, "離れる"), 2);
  await typeAtBodyEnd(page, "cccc");
  await expect(saveState(page)).toHaveText("保存できません");

  // アプリの中で離れる。文書ごと移ると、閉じる間の要求が数える前に取り消されることがある
  await page.getByRole("link", { name: "personal-wiki" }).click();
  await expect(page.locator(".entries .entry").first()).toBeVisible();
  await page.waitForTimeout(500);
  expect(puts()).toBe(0);
  expect((await api.getPage(created.id)).version).toBe(created.version);

  await page.goto(`/p/${created.id}`);
  const kept = notice(page, "前回、保存できなかった内容があります");
  await expect(kept).toBeVisible();
  await kept.getByRole("button", { name: "復元する" }).click();
  await expect(notice(page, "本文が長すぎて保存できません")).toBeVisible();
  expect(puts()).toBe(0);
});

test("本文の NUL に印を付け、通知のボタンで選んで消すと保存する", async ({
  page,
  api,
}, testInfo) => {
  const created = await api.createPage({ title: uniqueTitle(testInfo, "NUL"), body: "前の行" });
  await page.goto(`/p/${created.id}`);
  await expect(saveState(page)).toHaveText("保存済み");
  await typeAtBodyEnd(page, "x");
  // NUL はキーボードでは打てないので、貼り付けで入れる
  await bodyEditor(page).evaluate((element) => {
    const data = new DataTransfer();
    data.setData("text/plain", "\u0000");
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(bodyEditor(page).locator(".cm-nul")).toHaveCount(1);
  const found = notice(page, "見えない文字があって保存できません");
  await expect(found).toContainText("本文の 1 行目に、目に見えない文字（NUL）");
  await expect(saveState(page)).toHaveText("保存できません");

  await found.getByRole("button", { name: "その文字を選択する" }).click();
  await expect(bodyEditor(page)).toBeFocused();
  await page.keyboard.press("Backspace");
  await expect(bodyEditor(page).locator(".cm-nul")).toHaveCount(0);
  await expect(found).toBeHidden();
  await page.locator(".title-input .cm-content").click();
  await expect(saveState(page)).toHaveText("保存済み");
  expect((await api.getPage(created.id)).body).toBe("前の行x");
});

test("title が上限に近づくと欄の下に長さを出し、超えたら送らずに理由を出す", async ({
  page,
  api,
}, testInfo) => {
  const created = await api.createPage({ title: uniqueTitle(testInfo, "長い題"), body: "本文" });
  const puts = await countPuts(page, created.id);
  await page.goto(`/p/${created.id}`);
  await expect(saveState(page)).toHaveText("保存済み");
  const hintMeter = page.locator(".title-hint .input-meter");
  await titleEditor(page).click();
  await page.keyboard.press("End");
  await expect(hintMeter).toHaveCount(0);
  const bytes = new TextEncoder().encode(created.title).length;
  await page.keyboard.insertText("a".repeat(Math.ceil(MAX_TITLE_BYTES * 0.8) - bytes));
  await expect(hintMeter).toBeVisible();
  await expect(hintMeter).toHaveClass(/input-meter-normal/);
  await expectNoHorizontalScroll(page);

  await page.keyboard.insertText("#".repeat(MAX_TITLE_BYTES));
  await expect(page.locator(".title-hint")).toContainText("「#」はリンクに書けない文字です");
  await expect(hintMeter).toHaveClass(/input-meter-over/);
  await page.keyboard.press("Enter");
  const tooLong = notice(page, "タイトルが長すぎて保存できません");
  await expect(tooLong).toBeVisible();
  await expect(saveState(page)).toHaveText("保存できません");
  await page.waitForTimeout(500);
  expect(puts()).toBe(0);
  expect((await api.getPage(created.id)).title).toBe(created.title);
});

test("保存で title の重複と言われたら、再試行を出さずに既存のページを開く導線を出す", async ({
  page,
  api,
}, testInfo) => {
  const existing = await api.createPage({ title: uniqueTitle(testInfo, "Taken"), body: "先" });
  const created = await api.createPage({ title: uniqueTitle(testInfo, "後から"), body: "後" });
  await page.goto(`/p/${created.id}`);
  await expect(saveState(page)).toHaveText("保存済み");
  await titleEditor(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  // 大文字と小文字だけが違う title も同じとみなされる
  await page.keyboard.insertText(existing.title.toLowerCase());
  await page.keyboard.press("Enter");

  const taken = notice(page, "同じタイトルのページがあるため、保存できません");
  await expect(taken).toBeVisible();
  await expect(taken).toContainText(`「${existing.title}」というページがすでにあります。`);
  await expect(taken).toContainText("大文字と小文字、全角と半角、_ と空白の違いは");
  await expect(taken.getByRole("button", { name: "もう一度保存する" })).toHaveCount(0);
  const link = taken.getByRole("link", { name: "そのページを開く" });
  await expect(link).toHaveAttribute("href", new RegExp(`/p/${existing.id}`));
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/p/${existing.id}`));
  await expect(bodyEditor(page)).toHaveText("先");
});
