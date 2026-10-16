import type { Page } from "@playwright/test";
import type { OwnerApi } from "./support/api";
import { expect, test, uniqueTitle } from "./support/fixtures";
import { E2E_ORIGIN } from "./support/stack";

/*
 * ページの公開の導線: title の下の行で、公開の状態を見て、切り替え、共有の URL をコピーする。
 * draft から公開へは確認を挟み、公開から draft へは挟まない。匿名からの見え方は、cookie の無い
 * fetch で調べる（owner の画面が「公開」と言っていても、実際に匿名に出ているかは別に確かめる）。
 */

const titlePath = (title: string) => `/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
const option = (page: Page, label: "下書き" | "公開") =>
  page.locator(".publish-bar .segmented-option", { hasText: new RegExp(`^${label}$`) });
const confirmPanel = (page: Page) => page.getByRole("region", { name: "公開の確認" });
const notice = (page: Page) => page.locator(".publish-note");

async function anonymousSees(title: string): Promise<boolean> {
  const res = await fetch(`${E2E_ORIGIN}/api/pages/by-title?title=${encodeURIComponent(title)}`);
  return res.status === 200;
}

async function anonymousListsTitle(title: string): Promise<boolean> {
  const res = await fetch(`${E2E_ORIGIN}/api/pages/recent?limit=50`);
  const json = (await res.json()) as { pages: { title: string }[] };
  return json.pages.some((p) => p.title === title);
}

async function openDraft(page: Page, title: string, api: OwnerApi) {
  const created = await api.createPage({ title, body: "公開の検査に使う本文" });
  await page.goto(`/p/${created.id}`);
  await expect(page.locator(".title-input")).toHaveText(title);
  return created.id;
}

test("公開の確認を取り消すと、draft のまま匿名に出ない", async ({ page, api }, testInfo) => {
  const title = uniqueTitle(testInfo, "公開の取り消し");
  await openDraft(page, title, api);
  await expect(option(page, "下書き")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "URL をコピー" })).toHaveCount(0);

  await option(page, "公開").click();
  await expect(confirmPanel(page)).toContainText("最近の更新、検索、タグの一覧にも載ります");
  // 開いた直後の焦点は、確定でなく「やめる」に置く
  await expect(confirmPanel(page).getByRole("button", { name: "やめる" })).toBeFocused();
  // 確認の最中は、まだ何も変わっていない
  await expect(option(page, "下書き")).toHaveAttribute("aria-pressed", "true");
  expect(await anonymousSees(title)).toBe(false);
  // 塗りの強調はヘッダーの新規作成の 1 つだけ。確定の操作も塗らない
  await expect(page.locator(".main .button-primary")).toHaveCount(0);

  // 焦点を「公開」に戻して Enter を重ねても、確認が開いたままで確定しない
  await option(page, "公開").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(confirmPanel(page)).toBeVisible();
  await expect(option(page, "下書き")).toHaveAttribute("aria-pressed", "true");
  expect(await anonymousSees(title)).toBe(false);

  await confirmPanel(page).getByRole("button", { name: "やめる" }).click();
  await expect(confirmPanel(page)).toHaveCount(0);
  await expect(option(page, "公開")).toBeFocused();
  await expect(option(page, "下書き")).toHaveAttribute("aria-pressed", "true");
  expect(await anonymousSees(title)).toBe(false);

  // Escape でも閉じる
  await option(page, "公開").click();
  await expect(confirmPanel(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmPanel(page)).toHaveCount(0);
  expect(await anonymousSees(title)).toBe(false);

  // 確認の最中に「下書き」を押しても閉じる
  await option(page, "公開").click();
  await expect(confirmPanel(page)).toBeVisible();
  await option(page, "下書き").click();
  await expect(confirmPanel(page)).toHaveCount(0);
  expect(await anonymousSees(title)).toBe(false);
});

test("確認を開いている間に他で内容が変わったら、確認を閉じる", async ({ page, api }, testInfo) => {
  const title = uniqueTitle(testInfo, "確認中の更新");
  const id = await openDraft(page, title, api);
  await option(page, "公開").click();
  await expect(confirmPanel(page)).toBeVisible();
  await api.updatePage(await api.getPage(id), { body: "他で書き換えた本文" });
  // フォーカス復帰の確認は、最後の確認から 3 秒空ける
  await page.waitForTimeout(3_200);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(".body-editor")).toContainText("他で書き換えた本文");
  await expect(confirmPanel(page)).toHaveCount(0);
  expect(await anonymousSees(title)).toBe(false);
});

test("確認して公開すると匿名の一覧に出て、結果が知らされ、下書きに戻すと確認なしで消える @smoke", async ({
  page,
  api,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "公開と取り下げ");
  await openDraft(page, title, api);
  expect(await anonymousListsTitle(title)).toBe(false);

  const pressedColor = () =>
    page
      .locator('.publish-bar .segmented-option[aria-pressed="true"]')
      .evaluate((element) => getComputedStyle(element).color);
  const draftColor = await pressedColor();

  await option(page, "公開").click();
  await confirmPanel(page).getByRole("button", { name: "公開する" }).click();
  await expect(confirmPanel(page)).toHaveCount(0);
  await expect(option(page, "公開")).toHaveAttribute("aria-pressed", "true");
  // 差し色は公開中の印。draft の選択中は中立の色
  expect(await pressedColor()).not.toBe(draftColor);
  await expect(notice(page)).toHaveText("公開しました。");
  // 確認を閉じて失った焦点を「公開」に戻す
  await expect(option(page, "公開")).toBeFocused();
  await expect(page.getByRole("button", { name: "URL をコピー" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).toBe(titlePath(title));
  expect(await anonymousListsTitle(title)).toBe(true);
  expect(await anonymousSees(title)).toBe(true);

  // 公開から draft へは確認を挟まない
  await option(page, "下書き").click();
  await expect(confirmPanel(page)).toHaveCount(0);
  await expect(option(page, "下書き")).toHaveAttribute("aria-pressed", "true");
  await expect(notice(page)).toHaveText("下書きに戻しました。");
  await expect(page.getByRole("button", { name: "URL をコピー" })).toHaveCount(0);
  expect(await anonymousListsTitle(title)).toBe(false);
  expect(await anonymousSees(title)).toBe(false);
});

test("公開に失敗したら draft のまま理由と再試行が出て、再試行で公開できる", async ({
  page,
  api,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "公開の失敗");
  await openDraft(page, title, api);
  await page.route("**/api/pages/*/visibility", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
  );
  await option(page, "公開").click();
  await confirmPanel(page).getByRole("button", { name: "公開する" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "公開範囲を変更できませんでした" }),
  ).toBeVisible();
  await expect(option(page, "下書き")).toHaveAttribute("aria-pressed", "true");
  await expect(notice(page)).toHaveText("");
  expect(await anonymousSees(title)).toBe(false);

  await page.unroute("**/api/pages/*/visibility");
  await page.getByRole("button", { name: "もう一度公開にする" }).click();
  await expect(option(page, "公開")).toHaveAttribute("aria-pressed", "true");
  await expect(notice(page)).toHaveText("公開しました。");
  expect(await anonymousSees(title)).toBe(true);
});

test.describe("共有の URL", () => {
  test("コピーすると title の URL が入り、知らされる", async ({
    page,
    context,
    api,
    browserName,
  }, testInfo) => {
    test.skip(browserName !== "chromium", "clipboard の権限を与えられるのは Chromium だけ");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });
    const title = uniqueTitle(testInfo, "共有の URL");
    await api.createPage({ title, body: "本文", visibility: "public" });
    await page.goto(titlePath(title));
    await expect(page.locator(".title-input")).toHaveText(title);

    await page.getByRole("button", { name: "URL をコピー" }).click();
    await expect(notice(page)).toHaveText("コピーしました。");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `${E2E_ORIGIN}${titlePath(title)}`,
    );
    // 匿名がその URL で開ける
    expect(await anonymousSees(title)).toBe(true);
  });

  test("予約語と重なる title の公開ページは、id の URL をコピーする", async ({
    page,
    context,
    api,
    browserName,
  }, testInfo) => {
    test.skip(browserName !== "chromium", "clipboard の権限を与えられるのは Chromium だけ");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });
    // 先頭の segment が予約語（p）なので、title の URL を持てない
    const created = await api.createPage({
      title: uniqueTitle(testInfo, "p/予約語"),
      body: "本文",
      visibility: "public",
    });
    await page.goto(`/p/${created.id}`);
    await expect(page.locator(".title-input")).toContainText("予約語");
    await page.getByRole("button", { name: "URL をコピー" }).click();
    await expect(notice(page)).toHaveText("コピーしました。");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `${E2E_ORIGIN}/p/${created.id}`,
    );
  });

  test("title が未保存の間は、コピーできない", async ({ page, api }, testInfo) => {
    const title = uniqueTitle(testInfo, "未保存の title");
    await api.createPage({ title, body: "本文", visibility: "public" });
    await page.goto(titlePath(title));
    await expect(page.locator(".title-input")).toHaveText(title);
    const copyButton = page.getByRole("button", { name: "URL をコピー" });
    await expect(copyButton).toBeEnabled();
    await page.locator(".title-input .cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.type("X");
    await expect(copyButton).toBeDisabled();
  });

  test("clipboard に書けない環境では、URL を選んだ入力欄を見せる", async ({
    page,
    api,
  }, testInfo) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    });
    const title = uniqueTitle(testInfo, "共有の URL 手動");
    await api.createPage({ title, body: "本文", visibility: "public" });
    await page.goto(titlePath(title));
    await expect(page.locator(".title-input")).toHaveText(title);

    await page.getByRole("button", { name: "URL をコピー" }).click();
    await expect(notice(page)).toContainText("コピーできませんでした");
    const url = page.getByRole("textbox", { name: "共有する URL" });
    // percent-encoding を戻して読める形で見せる。title の空白は URL では `_` になっている
    const readable = `${E2E_ORIGIN}${decodeURI(titlePath(title))}`;
    await expect(url).toHaveValue(readable);
    expect(readable).not.toContain("%E");
    expect(readable).not.toMatch(/\s|%20/);
    await expect(url).toBeFocused();
    const selection = await url.evaluate((input: HTMLInputElement) => ({
      start: input.selectionStart,
      end: input.selectionEnd,
      length: input.value.length,
      direction: input.selectionDirection,
      scrollLeft: input.scrollLeft,
    }));
    expect(selection).toMatchObject({ start: 0, end: selection.length, direction: "backward" });
    // 長い URL でも、見えているのは先頭（焦点が末尾に移ると先頭が欄の外へ流れる）
    expect(selection.scrollLeft).toBe(0);
  });

  test("コピーの知らせは公開の行に収まり、下の内容を動かさない", async ({
    page,
    context,
    api,
    browserName,
  }, testInfo) => {
    test.skip(browserName !== "chromium", "clipboard の権限を与えられるのは Chromium だけ");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });
    await page.setViewportSize({ width: 375, height: 812 });
    const title = uniqueTitle(testInfo, "共有の URL の幅");
    await api.createPage({ title, body: "本文", visibility: "public" });
    await page.goto(titlePath(title));
    await expect(page.locator(".title-input")).toHaveText(title);

    const boxes = () =>
      page.evaluate(() => {
        const box = (selector: string) => {
          const rect = document.querySelector(selector)?.getBoundingClientRect();
          return { top: rect?.top ?? 0, bottom: rect?.bottom ?? 0 };
        };
        const note = document.querySelector(".publish-note");
        return {
          body: box(".body-editor"),
          button: box(".publish-bar .button"),
          note: box(".publish-note"),
          // 省略や切り取りで文字が欠けていないこと（textContent は欠けても全文を返す）
          clipped:
            note === null ||
            note.scrollWidth > note.clientWidth ||
            note.scrollHeight > note.clientHeight,
        };
      });
    const before = await boxes();
    await page.getByRole("button", { name: "URL をコピー" }).click();
    await expect(notice(page)).toHaveText("コピーしました。");
    const after = await boxes();
    expect(after.body.top, "知らせが出ても本文は動かない").toBe(before.body.top);
    expect(after.note.top, "知らせは操作と同じ行").toBeGreaterThanOrEqual(after.button.top);
    expect(after.note.bottom, "知らせは操作と同じ行").toBeLessThanOrEqual(after.button.bottom);
    expect(after.clipped, "知らせの文字は欠けない").toBe(false);
  });
});

test("作る前のページでは、公開の操作を選べない", async ({ page }) => {
  await page.goto("/?new");
  await expect(page.locator(".title-input .cm-content")).toBeFocused();
  await expect(option(page, "下書き")).toBeDisabled();
  await expect(option(page, "公開")).toBeDisabled();
  await expect(page.locator(".publish-bar")).toContainText("ページを作ると、公開を選べます。");
  await expect(page.getByRole("button", { name: "URL をコピー" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "このページを削除" })).toHaveCount(0);
});
