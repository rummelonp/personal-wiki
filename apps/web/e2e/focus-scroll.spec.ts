import type { Locator, Page } from "@playwright/test";
import type { ApiPage, OwnerApi } from "./support/api";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";

/*
 * 通知のボタンを押した後に script が title の欄や本文へ focus を移すとき、移し先が画面の外にあれば
 * ヘッダーの下に見える位置へ出す。見えているときはスクロールを動かさない。
 * ここは、画面の下に固定した通知を、本文の下の方までスクロールして押すデスクトップの操作を測る。
 */

const LINES = Array.from({ length: 120 }, (_, index) => `${index + 1} 行目の本文`);
const BODY = LINES.join("\n");

/** CodeMirror の scrollIntoView が対象の上に取る余白の既定値 */
const CODEMIRROR_Y_MARGIN = 5;

const titleEditor = (page: Page): Locator => page.locator(".title-input .cm-content");

async function openLongPage(page: Page, api: OwnerApi, title: string): Promise<ApiPage> {
  const created = await api.createPage({ title, body: BODY });
  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page)).toContainText("1 行目の本文");
  await expect(saveState(page)).toHaveText("保存済み");
  return created;
}

/** 1 行目の末尾に打って保存を始め、PUT が 500 で終わって「もう一度保存する」が出るまで進める */
async function failSave(page: Page, pagePath: string): Promise<Locator> {
  await page.route(pagePath, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"x"}' })
      : route.fallback(),
  );
  await bodyEditor(page).locator(".cm-line").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("、手元の変更");
  const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
  await expect(alert).toBeVisible();
  return alert;
}

/** PUT が title の重複（409）で終わるようにする */
async function conflictTitleOnSave(page: Page, pagePath: string, other: ApiPage): Promise<void> {
  await page.unroute(pagePath);
  await page.route(pagePath, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "title_conflict",
            existing: { id: other.id, title: other.title, visibility: "draft" },
          }),
        })
      : route.fallback(),
  );
}

/**
 * 保存の状態の上端がヘッダーの下端から gap だけ下に来るようにスクロールする。
 * title の行は保存の状態のすぐ下にあるので、gap が負なら保存の状態だけがヘッダーに隠れる。
 */
async function placeSaveState(page: Page, gap: number): Promise<void> {
  await page.evaluate((offset) => {
    const header = document.querySelector("header.header")?.getBoundingClientRect().bottom ?? 0;
    const top = document.querySelector(".note > .save-state")?.getBoundingClientRect().top ?? 0;
    window.scrollBy(0, top - header - offset);
  }, gap);
  await expect.poll(() => saveStateGap(page)).toBeCloseTo(gap, 0);
}

/** 保存の状態の上端が、ヘッダーの下端より下にある高さ。隠れていれば負 */
function saveStateGap(page: Page): Promise<number> {
  return page.evaluate(() => {
    const header = document.querySelector("header.header")?.getBoundingClientRect().bottom ?? 0;
    const top = document.querySelector(".note > .save-state")?.getBoundingClientRect().top ?? 0;
    return top - header;
  });
}

/** CodeMirror の scrollIntoView は次の measure（フレーム）で動くので、focus の後に 2 フレーム進めてから読む */
async function afterFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
}

/** 欄がヘッダーの下から画面の下端の間に、全体が見えている */
async function expectShownBelowHeader(page: Page, target: Locator): Promise<void> {
  const header = await page.locator("header.header").boundingBox();
  const box = await target.boundingBox();
  const viewport = page.viewportSize();
  expect(header).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box?.y ?? 0).toBeGreaterThanOrEqual((header?.y ?? 0) + (header?.height ?? 0));
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport?.height ?? 0);
}

test("下までスクロールして再送し、title の重複で終わると、title の欄が見える位置へ出る", async ({
  page,
  api,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, "タッチ端末は枠に移し、スクロールを動かさない");
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "重複で下から再送"));
  const other = await api.createPage({ title: uniqueTitle(testInfo, "先にある title"), body: "x" });
  const pagePath = `**/api/pages/${created.id}`;
  const alert = await failSave(page, pagePath);

  await conflictTitleOnSave(page, pagePath, other);
  await scrollToBottom(page);
  await alert.getByRole("button", { name: "もう一度保存する" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "同じタイトルのページがある" }),
  ).toBeVisible();

  await expect(titleEditor(page)).toBeFocused();
  await expect(titleEditor(page)).toBeInViewport({ ratio: 1 });
  await expectShownBelowHeader(page, page.locator(".title-input"));
});

test("下までスクロールして衝突を解決すると、本文の打っていた行が見える位置へ出る", async ({
  page,
  api,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, "タッチ端末は枠に移し、スクロールを動かさない");
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "衝突を下から解決"));
  const pagePath = `**/api/pages/${created.id}`;
  let external: Promise<ApiPage> | undefined;
  await page.route(pagePath, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    external ??= api.updatePage(created, { body: `${BODY}\n別の場所で足した行` });
    await external;
    return route.fallback();
  });
  await bodyEditor(page).locator(".cm-line").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("、手元の変更");
  const conflict = page.getByRole("alert").filter({ hasText: "別の場所でも更新されています" });
  await expect(conflict).toBeVisible();

  await scrollToBottom(page);
  await conflict.getByRole("button", { name: "この画面の内容で上書きする" }).click();
  await conflict.getByRole("button", { name: "上書きする", exact: true }).click();
  await expect(conflict).toBeHidden();

  await expect(bodyEditor(page)).toBeFocused();
  // 行の箱は文字の上下に余白を持つので、カーソルの描画で測る
  const caret = page.locator(".body-editor .cm-cursor-primary");
  await expect(caret).toBeInViewport({ ratio: 1 });
  await expectShownBelowHeader(page, caret);
});

/**
 * title の欄の先頭の文字の上端が、.cm-content の上端から下にある距離（c）。カーソルの上端は行の上端より
 * c だけ下にある。c は font、--font-size-title、--line-height-tight で変わるので固定値にしない。
 * .cm-content は縦の padding を持たないので、CodeMirror の documentTop と同じ位置から測れる。
 */
function measureTitleCaretOffset(page: Page): Promise<number> {
  return page.evaluate(() => {
    const content = document.querySelector(".title-input .cm-content");
    const first = content?.querySelector(".cm-line");
    if (!content || !first) throw new Error("title の欄が無い");
    const text = document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode();
    if (!text) throw new Error("title の欄に文字が無い");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    return range.getBoundingClientRect().top - content.getBoundingClientRect().top;
  });
}

/** focus を移した後の、カーソルの描画の上端が .cm-content の上端から下にある距離 */
function measureDrawnCaretOffset(page: Page): Promise<number> {
  return page.evaluate(() => {
    const content = document.querySelector(".title-input .cm-content");
    const caret = document.querySelector(".title-input .cm-cursor-primary");
    if (!content || !caret) throw new Error("title の欄のカーソルが無い");
    return caret.getBoundingClientRect().top - content.getBoundingClientRect().top;
  });
}

/**
 * 再送が title の重複で終わると、script が title の欄へ focus を移す。
 * 移す前に、カーソルの上端が scrollIntoView の上の余白（ヘッダーの下端に保存の状態の分を足した位置）より
 * margin だけ下に来るよう title の欄を置き、移した後のスクロールの位置を返す。
 * 余白の位置は、ヘッダーの下端に (.cm-content の上端 - 保存の状態の上端) を足した高さ。
 * 保存の状態の上端をヘッダーの下端から (margin - c) だけ下に置くと、カーソルの上端は余白から margin だけ下に来る。
 */
async function resendIntoTitleConflict(
  page: Page,
  api: OwnerApi,
  testInfo: Parameters<typeof uniqueTitle>[0],
  margin: number,
): Promise<{ before: number; after: number; offset: number }> {
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "上で再送"));
  const other = await api.createPage({ title: uniqueTitle(testInfo, "先にある title"), body: "x" });
  const pagePath = `**/api/pages/${created.id}`;
  const alert = await failSave(page, pagePath);
  await conflictTitleOnSave(page, pagePath, other);
  const offset = await measureTitleCaretOffset(page);
  await placeSaveState(page, margin - offset);
  const before = await page.evaluate(() => window.scrollY);

  await alert.getByRole("button", { name: "もう一度保存する" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "同じタイトルのページがある" }),
  ).toBeVisible();
  await expect(titleEditor(page)).toBeFocused();
  await afterFrames(page);
  // 描画されたカーソルが測った位置にあることで、置いた余白が狙い通りだったと確かめる
  expect(await measureDrawnCaretOffset(page)).toBeCloseTo(offset, 0);
  return { before, after: await page.evaluate(() => window.scrollY), offset };
}

test("見えている title の欄へ移すときは、ヘッダーのすぐ下でもスクロールを動かさない", async ({
  page,
  api,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, "タッチ端末は枠に移し、スクロールを動かさない");
  // カーソルの上端が余白より 2px 下にある位置。余白より下なので見えているが、scrollIntoView は余白の上に
  // 5px（yMargin）を足した位置より上を寄せるので、見えているかの判定を外すと、次の measure で動く
  const { before, after } = await resendIntoTitleConflict(page, api, testInfo, 2);
  expect(after).toBe(before);
});

test("title の行は見えていても保存の状態がヘッダーに隠れているときは、保存の状態が見える位置へ出す", async ({
  page,
  api,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, "タッチ端末は枠に移し、スクロールを動かさない");
  // カーソルの上端が余白より 3px 上にある位置。ヘッダーの下端だけを見る判定では、保存の状態が隠れた
  // まま見えている扱いになる
  const { before, after, offset } = await resendIntoTitleConflict(page, api, testInfo, -3);
  expect(after).toBeLessThan(before);
  // scrollIntoView はカーソルの上端を余白の 5px（yMargin）下に置くので、保存の状態の上端は
  // ヘッダーの下端から (5 - c) 下に来る。c が 5 を超える font では、その分だけヘッダーに掛かる
  expect(await saveStateGap(page)).toBeGreaterThanOrEqual(CODEMIRROR_Y_MARGIN - offset - 1);
  await expectShownBelowHeader(page, page.locator(".title-input"));
});
