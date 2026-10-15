import type { Locator, Page } from "@playwright/test";
import type { ApiPage, OwnerApi } from "./support/api";
import {
  bodyEditor,
  expect,
  expectNoHorizontalScroll,
  saveState,
  test,
  uniqueTitle,
} from "./support/fixtures";

/*
 * 通知（失敗、衝突、ログイン切れ）が出入りしても、title と本文の位置は動かず、打っている行は通知に隠れない。
 * 通知は画面の下端に重ねて出る台（.notice-dock）に入り、本文の流れに高さを取らない。
 * 測るのは座標で、幅は 375、768、1280（@widths）と、iPhone の WebKit（主の環境）。
 */

const WIDTHS = [375, 768, 1280] as const;
const LINES = Array.from({ length: 60 }, (_, index) => `${index + 1} 行目の本文`);
const BODY = LINES.join("\n");

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function openLongPage(page: Page, api: OwnerApi, title: string): Promise<ApiPage> {
  const created = await api.createPage({ title, body: BODY });
  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page)).toContainText("1 行目の本文");
  await expect(saveState(page)).toHaveText("保存済み");
  return created;
}

const titleBox = (page: Page): Locator => page.locator(".title-input");

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("要素が描画されていない");
  return box;
}

/** 文書の左上を原点にした位置。スクロールで画面上の位置が動いても、置き場所の移動だけを測れる。 */
async function documentBoxOf(locator: Locator): Promise<Box> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  });
}

async function expectSameBox(actual: Locator, expected: Box, label: string): Promise<void> {
  const box = await documentBoxOf(actual);
  expect(box.x, `${label}の x`).toBeCloseTo(expected.x, 0);
  expect(box.y, `${label}の y`).toBeCloseTo(expected.y, 0);
  expect(box.width, `${label}の幅`).toBeCloseTo(expected.width, 0);
  expect(box.height, `${label}の高さ`).toBeCloseTo(expected.height, 0);
}

/** 本文の n 行目（0 始まり）の位置。画面外にあれば描画されていないので null。 */
async function lineBox(page: Page, index: number): Promise<Box | null> {
  return bodyEditor(page).locator(".cm-line").nth(index).boundingBox();
}

/** いま打っている位置（caret）の矩形。 */
async function caretRect(page: Page): Promise<{ top: number; bottom: number }> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0) throw new Error("選択が無い");
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(true);
    let rect = range.getBoundingClientRect();
    if (rect.height === 0) {
      const node = range.startContainer;
      const element = node instanceof Element ? node : node.parentElement;
      rect = (element?.closest(".cm-line") ?? document.body).getBoundingClientRect();
    }
    return { top: rect.top, bottom: rect.bottom };
  });
}

const dock = (page: Page): Locator => page.locator(".notice-dock");

function failSaveWith500(page: Page, created: ApiPage) {
  return page.route(`**/api/pages/${created.id}`, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "internal" }),
        })
      : route.fallback(),
  );
}

async function typeAt(page: Page, lineIndex: number, text: string): Promise<void> {
  await bodyEditor(page).locator(".cm-line").nth(lineIndex).click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

async function expectDockOnScreen(page: Page): Promise<void> {
  // 高い通知（衝突の差分）は台の中でスクロールするので、台の枠が画面に収まることを測る
  const box = await boxOf(dock(page));
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("viewport が無い");
  expect(box.y, "通知が画面の上にはみ出している").toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, "通知が画面の下にはみ出している").toBeLessThanOrEqual(
    viewport.height + 0.5,
  );
  expect(box.x, "通知が画面の左にはみ出している").toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, "通知が画面の右にはみ出している").toBeLessThanOrEqual(
    viewport.width + 0.5,
  );
}

async function expectBodyNotShifted(page: Page, before: { title: Box; line: Box }): Promise<void> {
  await expectSameBox(titleBox(page), before.title, "title");
  await expectSameBox(bodyEditor(page).locator(".cm-line").first(), before.line, "本文の先頭行");
}

async function measureBefore(page: Page): Promise<{ title: Box; line: Box }> {
  return {
    title: await documentBoxOf(titleBox(page)),
    line: await documentBoxOf(bodyEditor(page).locator(".cm-line").first()),
  };
}

test("保存の失敗の通知が出入りしても、title と本文の位置は動かず、打っている行は通知に隠れない", async ({
  page,
  api,
}, testInfo) => {
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "通知の位置"));
  const before = await measureBefore(page);
  await failSaveWith500(page, created);

  // 画面の下端に近い行を打つ。通知は台に重なって出るので、この行は通知で確実に覆われる
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("viewport が無い");
  let index = 0;
  for (; index < LINES.length; index++) {
    const box = await lineBox(page, index);
    if (box !== null && box.y + box.height > viewport.height * 0.9) break;
  }
  expect(index, "画面の下端に近い行が無い").toBeLessThan(LINES.length);
  await typeAt(page, index, "、打っている途中");
  const caretBefore = await caretRect(page);

  const alert = page.getByRole("alert").filter({ hasText: "保存に失敗しました" });
  await expect(alert).toBeVisible();
  await expect(dock(page)).toContainText("時間をおいて、もう一度試してください。");
  // 追加の入力の前に測る。台が出る前の行は台に覆われる位置にあり、それでも台の上へ逃げている
  expect(caretBefore.bottom, "行が台に覆われる位置になく、検査にならない").toBeGreaterThan(
    (await boxOf(alert)).y,
  );
  await expect
    .poll(async () => (await caretRect(page)).bottom, "打っている行が通知に隠れている")
    .toBeLessThanOrEqual((await boxOf(alert)).y + 0.5);
  const caret = await caretRect(page);
  expect(caret.top, "打っている行がヘッダーより上に出ている").toBeGreaterThanOrEqual(0);
  await expectBodyNotShifted(page, before);
  await expectDockOnScreen(page);
  await expectNoHorizontalScroll(page);

  // 続けて打っても、通知は動かず、行は隠れない
  const failedAgain = page.waitForResponse(
    (res) => res.request().method() === "PUT" && res.url().endsWith(`/api/pages/${created.id}`),
  );
  await page.keyboard.type("さらに打つ");
  await expect
    .poll(async () => (await caretRect(page)).bottom)
    .toBeLessThanOrEqual((await boxOf(alert)).y + 0.5);

  // 通知が消えても、title と本文は動かない（スクロールは戻さないので、先頭までスクロールして比べる）
  // 横取りを外すのは、打った分の自動保存が失敗で返ってから。横取り中の要求を残したまま外すと、
  // 送り直しが通信の失敗で終わることがある（原因は特定していない）
  await failedAgain;
  await page.unroute(`**/api/pages/${created.id}`);
  await alert.getByRole("button", { name: "もう一度保存する" }).click();
  await expect(saveState(page)).toHaveText("保存済み");
  await expect(alert).toBeHidden();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expectBodyNotShifted(page, before);
});

test("保存の失敗の通知は、操作の前後で title の位置を動かさない（先頭の行を打つとき）", async ({
  page,
  api,
}, testInfo) => {
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "先頭の行"));
  const before = await measureBefore(page);
  await failSaveWith500(page, created);
  await typeAt(page, 0, "、先頭の行");
  const alert = page.getByRole("alert").filter({ hasText: "保存に失敗しました" });
  await expect(alert).toBeVisible();
  await expectBodyNotShifted(page, before);
  expect((await caretRect(page)).bottom).toBeLessThanOrEqual((await boxOf(alert)).y + 0.5);
});

test.describe("幅ごとの通知 @widths", () => {
  test("500 の通知は、どの幅でも位置を動かさず、画面に収まる", async ({ page, api }, testInfo) => {
    const created = await openLongPage(page, api, uniqueTitle(testInfo, "幅の通知"));
    await failSaveWith500(page, created);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await expect(bodyEditor(page)).toContainText("1 行目の本文");
      await page.evaluate(() => window.scrollTo(0, 0));
      const before = await measureBefore(page);
      await typeAt(page, 0, `、${width}`);
      const alert = page.getByRole("alert").filter({ hasText: "保存に失敗しました" });
      await expect(alert).toBeVisible();
      await expectBodyNotShifted(page, before);
      await expectDockOnScreen(page);
      await expectNoHorizontalScroll(page);
      await page.unroute(`**/api/pages/${created.id}`);
      await alert.getByRole("button", { name: "もう一度保存する" }).click();
      await expect(alert).toBeHidden();
      await failSaveWith500(page, created);
    }
  });
});

test("衝突の通知は、title と本文を動かさず、主操作は取り込みで、操作は枠の中に収まる", async ({
  page,
  api,
  isMobile,
}, testInfo) => {
  // 375px で操作が枠を越えないことを測るので、デスクトップの環境は幅を狭める
  if (testInfo.project.name === "chromium-desktop") {
    await page.setViewportSize({ width: 375, height: 800 });
  }
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "衝突の位置"));
  const before = await measureBefore(page);
  const pagePath = `**/api/pages/${created.id}`;
  let external: Promise<ApiPage> | undefined;
  await page.route(pagePath, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    external ??= api.updatePage(created, { body: `${BODY}\n別の場所で足した行` });
    const updated = await external.then(
      () => true,
      () => false,
    );
    return updated ? route.fallback() : route.abort();
  });
  await typeAt(page, 0, "、手元の変更");
  await expect.poll(() => external, "保存が送られない").toBeDefined();
  await external;
  const conflict = page.getByRole("alert").filter({
    has: page.getByRole("heading", { name: "サーバーの内容と食い違っています" }),
  });
  await expect(conflict).toBeVisible();
  await expectBodyNotShifted(page, before);
  await expectDockOnScreen(page);
  // 本文を打っている最中に通知が出ても、focus は奪わない（変換中なら IME が切れる）
  await expect(bodyEditor(page)).toBeFocused();

  // 枠は role を持つ内側の要素ではなく、線と余白を持つ通知の要素
  const panel = await boxOf(page.locator(".notice").filter({ has: conflict }));
  const take = conflict.getByRole("button", { name: "サーバーの版を取り込む" });
  const overwrite = conflict.getByRole("button", { name: "手元で上書き" });
  for (const button of [take, overwrite]) {
    const box = await boxOf(button);
    expect(box.x, "操作が枠の左の線を越えている").toBeGreaterThanOrEqual(panel.x);
    expect(box.x + box.width, "操作が枠の右の線を越えている").toBeLessThanOrEqual(
      panel.x + panel.width,
    );
  }
  // どちらを選んでも手元かサーバーの内容が消えるので、並べ方で一方を勧めず、どちらも差し色にしない
  expect((await boxOf(take)).y).toBeLessThanOrEqual((await boxOf(overwrite)).y);
  expect((await boxOf(take)).x).toBeLessThan((await boxOf(overwrite)).x + 1);
  await expect(take).not.toHaveClass(/button-main/);
  await expect(overwrite).not.toHaveClass(/button-main/);

  // 見出しの最後の 1 文字だけが次の行に落ちない
  const heading = conflict.getByRole("heading", { name: "サーバーの内容と食い違っています" });
  const lines = await heading.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
    return new Set(rects.map((rect) => Math.round(rect.top))).size;
  });
  expect(lines, "見出しが短い行に折り返している").toBeLessThanOrEqual(2);
  const orphan = await heading.evaluate((element) => {
    const text = element.textContent ?? "";
    const range = document.createRange();
    const node = element.lastChild;
    if (node === null || node.nodeType !== Node.TEXT_NODE) return false;
    const last = text.length;
    if (last < 2) return false;
    const textNode = node as Text;
    range.setStart(textNode, textNode.length - 1);
    range.setEnd(textNode, textNode.length);
    const tail = range.getBoundingClientRect();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 1);
    const head = range.getBoundingClientRect();
    if (Math.round(tail.top) === Math.round(head.top)) return false;
    // 最後の行が 1 文字だけか
    range.setStart(textNode, textNode.length - 2);
    range.setEnd(textNode, textNode.length - 1);
    const beforeLast = range.getBoundingClientRect();
    return Math.round(beforeLast.top) !== Math.round(tail.top);
  });
  expect(orphan, "見出しの最後の 1 文字だけが次の行に落ちている").toBe(false);

  // 取り込むと、手元の変更は消えてサーバーの版になる。押す前に確かめ、断れば何も変わらない
  await take.click();
  await expect(conflict.getByRole("button", { name: "やめる" })).toBeFocused();
  await conflict.getByRole("button", { name: "やめる" }).click();
  await expect(take).toBeFocused();
  await expect(conflict).toBeVisible();
  await take.click();
  await conflict.getByRole("button", { name: "取り込む", exact: true }).click();
  await expect(conflict).toBeHidden();
  // 押したボタンが消えても focus は body に落ちず、本文に戻る。タッチ端末では、確認の操作で閉じた
  // キーボードを開き直さないよう、ページの枠に移る
  if (isMobile) await expect(page.locator("article.note")).toBeFocused();
  else await expect(bodyEditor(page)).toBeFocused();
  // 取り込みで本文が差し替わっても、打っていた位置にいた title は見えたまま
  await expect(titleBox(page)).toBeInViewport();
  await expect(bodyEditor(page)).toContainText("別の場所で足した行");
  await expect(saveState(page)).toHaveText("保存済み");
});

test("ログイン切れの通知も同じ型で、塗りの主操作を持たない", async ({ page, api }, testInfo) => {
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "401 の型"));
  const before = await measureBefore(page);
  await page.route(`**/api/pages/${created.id}`, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "unauthorized" }),
        })
      : route.fallback(),
  );
  await typeAt(page, 0, "、切れる");
  const alert = page.getByRole("alert").filter({ hasText: "ログインの期限が切れました" });
  await expect(alert).toBeVisible();
  await expectBodyNotShifted(page, before);
  await expect(alert.getByRole("heading")).toHaveText("ログインの期限が切れました");
  await expect(alert.locator(".button-primary")).toHaveCount(0);
  // 塗りの強調はヘッダーの + だけ
  await expect(page.locator(".button-primary:visible")).toHaveCount(1);
});

test("未作成のリンクの通知も、本文を動かさず、塗りの主操作を持たない", async ({
  page,
  api,
}, testInfo) => {
  // title の URL にできる title は空のページへ移るので、予約語で始まる title で通知を出す
  const missing = `p/${uniqueTitle(testInfo, "未作成")}`;
  const source = await api.createPage({
    title: uniqueTitle(testInfo, "リンク元"),
    body: `[[${missing}]]\n\n${BODY}`,
  });
  await page.goto(`/p/${source.id}`);
  await expect(saveState(page)).toHaveText("保存済み");
  const before = await measureBefore(page);
  await bodyEditor(page).locator(".cm-wikilink", { hasText: missing }).click();
  const notice = page
    .getByRole("alert")
    .filter({ hasText: `「${missing}」のページはまだありません` });
  await expect(notice).toBeVisible();
  await expectBodyNotShifted(page, before);
  await expectDockOnScreen(page);
  await expect(notice.locator(".button-primary")).toHaveCount(0);
  await expect(page.locator(".button-primary:visible")).toHaveCount(1);
});
