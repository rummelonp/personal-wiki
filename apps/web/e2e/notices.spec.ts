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
import { lineTexts, midPhraseBreaks } from "./support/line-breaks";

/*
 * 通知（失敗、衝突、ログイン切れ）が出入りしても、title と本文の位置は動かず、打っている行は通知に隠れない。
 * 通知は画面の下端に重ねて出るドック（.notice-dock）に入り、本文の流れに高さを取らない。
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
  // 高い通知（衝突の差分）はドックの中でスクロールするので、ドックの枠が画面に収まることを測る
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

  // 画面の下端に近い行を打つ。通知はドックに重なって出るので、この行は通知で確実に覆われる
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

  const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
  await expect(alert).toBeVisible();
  await expect(dock(page)).toContainText("時間をおいて、もう一度試してください。");
  // 追加の入力の前に測る。ドックが出る前の行はドックに覆われる位置にあり、それでもドックの上へ逃げている
  expect(caretBefore.bottom, "行がドックに覆われる位置になく、検査にならない").toBeGreaterThan(
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
  // 横取りを外すのは、打った分の自動保存が失敗で返ってから。横取り中のリクエストを残したまま外すと、
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
  const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
  await expect(alert).toBeVisible();
  await expectBodyNotShifted(page, before);
  expect((await caretRect(page)).bottom).toBeLessThanOrEqual((await boxOf(alert)).y + 0.5);
});

test("もう一度保存している間は、下までスクロールしていても、ドックに保存中の通知が残る", async ({
  page,
  api,
}, testInfo) => {
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "保存中の通知"));
  const pagePath = `**/api/pages/${created.id}`;
  await failSaveWith500(page, created);
  await typeAt(page, 0, "、再試行する");
  const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
  await expect(alert).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  // 保存の状態の表示はページの上端にあり、ここからは見えない。ドックの通知が進行を伝える
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.unroute(pagePath);
  await page.route(pagePath, async (route) => {
    if (route.request().method() === "PUT") await gate;
    await route.fallback();
  });
  await alert.getByRole("button", { name: "もう一度保存する" }).click();
  const saving = dock(page).locator(".notice").filter({ hasText: "保存中…" });
  await expect(saving).toBeVisible();
  await expect(alert).toBeHidden();
  await expectDockOnScreen(page);

  release();
  await expect(saving).toBeHidden();
  await expect(alert).toBeHidden();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(saveState(page)).toHaveText("保存済み");
});

test("もう一度保存している間、上端の保存の状態が見えていればドックには出さず、下へスクロールするとドックに出る", async ({
  page,
  api,
}, testInfo) => {
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "上端が見える間"));
  const pagePath = `**/api/pages/${created.id}`;
  await failSaveWith500(page, created);
  await typeAt(page, 0, "、再試行する");
  const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
  await expect(alert).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.unroute(pagePath);
  await page.route(pagePath, async (route) => {
    if (route.request().method() === "PUT") await gate;
    await route.fallback();
  });
  await alert.getByRole("button", { name: "もう一度保存する" }).click();
  // 上端の「保存中…」が同じ保存を伝えるので、ドックに同じ意味の通知を重ねない
  await expect(saveState(page)).toHaveText("保存中…");
  await expect(alert).toBeHidden();
  const saving = dock(page).locator(".notice").filter({ hasText: "保存中…" });
  await expect(saving).toHaveCount(0);

  // 保存の途中で上端が見えなくなったら、ドックが進行を伝える
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(saving).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(saving).toHaveCount(0);

  release();
  await expect(saveState(page)).toHaveText("保存済み");
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
      const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
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
    has: page.getByRole("heading", { name: "別の場所でも更新されています" }),
  });
  await expect(conflict).toBeVisible();
  await expectBodyNotShifted(page, before);
  await expectDockOnScreen(page);
  // 凡例は差分の前にあり、最初の表示から見える（差分の欄の最下端に置くと、スクロールするまで見えない）
  const legend = dock(page).locator(".diff-legend");
  await expect(legend).toBeInViewport({ ratio: 1 });
  expect((await boxOf(legend)).y, "凡例が差分より下にある").toBeLessThan(
    (await boxOf(dock(page).locator(".diff"))).y,
  );
  // WebKit は文節を判定しないので、句読点と空白でだけ折り返す。判定する描画は文節で切るので測らない
  if (!(await page.evaluate(() => CSS.supports("word-break", "auto-phrase")))) {
    expect(await midPhraseBreaks(legend), "凡例が語の途中で折り返している").toEqual([]);
  }
  // 記号が説明と別の行に分かれると、何の記号か読み取れない。空白の後の折り返しは midPhraseBreaks が許すので別に見る
  for (const line of await lineTexts(legend)) {
    expect(line, "凡例の記号が行末に残っている").not.toMatch(/[＋−]$/);
  }
  // 本文を打っている最中に通知が出ても、focus は奪わない（変換中なら IME が切れる）
  await expect(bodyEditor(page)).toBeFocused();

  // 枠は role を持つ内側の要素ではなく、線と余白を持つ通知の要素
  const panel = await boxOf(page.locator(".notice").filter({ has: conflict }));
  const take = conflict.getByRole("button", { name: "別の場所の内容を使う" });
  const overwrite = conflict.getByRole("button", { name: "この画面の内容で上書きする" });
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
  const heading = conflict.getByRole("heading", { name: "別の場所でも更新されています" });
  const lines = await heading.evaluate((element) => {
    // 先頭の点と、文字の行の top。文節の切れ目に <wbr> を置く描画では文字が <span> に入るので、
    // 要素の箱ではなく text node の行を測る
    const range = document.createRange();
    const tops = new Set<number>();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) if (rect.width > 0) tops.add(Math.round(rect.top));
    }
    const dot = element.querySelector(".dot")?.getBoundingClientRect();
    if (dot !== undefined) tops.add(Math.round(dot.top));
    return tops.size;
  });
  expect(lines, "見出しが短い行に折り返している").toBeLessThanOrEqual(2);
  const orphan = await heading.evaluate((element) => {
    // 文節の切れ目に <wbr> を置く描画では、見出しの文字列が複数の text node に分かれる
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      nodes.push(node as Text);
    }
    const first = nodes.at(0);
    const last = nodes.at(-1);
    if (first === undefined || last === undefined || (element.textContent ?? "").length < 2) {
      return false;
    }
    const topOf = (node: Text, start: number): number => {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 1);
      return Math.round(range.getBoundingClientRect().top);
    };
    const tail = topOf(last, last.length - 1);
    if (topOf(first, 0) === tail) return false;
    // 最後の行が 1 文字だけか。最後の text node が 1 文字なら、その前の文字は前の text node にある
    const beforeLast =
      last.length >= 2
        ? topOf(last, last.length - 2)
        : (() => {
            const previous = nodes.at(-2);
            return previous === undefined ? tail : topOf(previous, previous.length - 1);
          })();
    return beforeLast !== tail;
  });
  expect(orphan, "見出しの最後の 1 文字だけが次の行に落ちている").toBe(false);

  // 取り込むと、手元の変更は消えてサーバーの版になる。押す前に確かめ、断れば何も変わらない
  await take.click();
  await expect(conflict.getByRole("button", { name: "やめる" })).toBeFocused();
  await conflict.getByRole("button", { name: "やめる" }).click();
  await expect(take).toBeFocused();
  await expect(conflict).toBeVisible();
  await take.click();
  await conflict.getByRole("button", { name: "置き換える", exact: true }).click();
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

/** 保存の間に別の場所で多くの行と title を書き換えて、差分の長い衝突の通知を出す。 */
async function provokeLongConflict(page: Page, api: OwnerApi, title: string): Promise<Locator> {
  const created = await openLongPage(page, api, title);
  const pagePath = `**/api/pages/${created.id}`;
  const changed = LINES.map((line, index) =>
    index % 4 === 0 ? `${line}を別の場所で直した` : line,
  );
  let external: Promise<ApiPage> | undefined;
  await page.route(pagePath, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    external ??= api.updatePage(created, {
      title: `${created.title}（別の場所）`,
      body: changed.join("\n"),
    });
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
    has: page.getByRole("heading", { name: "別の場所でも更新されています" }),
  });
  await expect(conflict).toBeVisible();
  return conflict;
}

test.describe("差分の長い衝突の通知は、ドックの中と差分の欄が二重にスクロールしない", () => {
  // iPhone 15 の layout viewport は 393x659。キーボードが無くても、ドックの上限（0.6）は 395 ほどになる
  const SIZES = [
    { width: 375, height: 667 },
    { width: 393, height: 659 },
  ];
  for (const size of SIZES) {
    test(`幅 ${size.width}`, async ({ page, api }, testInfo) => {
      test.skip(
        testInfo.project.name === "webkit-iphone" && size.width !== 393,
        "iPhone の WebKit は自分の幅（393）で測る",
      );
      if (testInfo.project.name === "chromium-desktop") await page.setViewportSize(size);
      const conflict = await provokeLongConflict(page, api, uniqueTitle(testInfo, "差分の長さ"));
      await expect(page.locator(".diff")).toBeVisible();
      const { detailsScrolls, dockScrolls } = await page.evaluate(() => {
        const dockEl = document.querySelector(".notice-dock") as HTMLElement;
        const detailsEl = document.querySelector(".notice-details") as HTMLElement;
        return {
          dockScrolls: dockEl.scrollHeight > dockEl.clientHeight + 1,
          detailsScrolls: detailsEl.scrollHeight > detailsEl.clientHeight + 1,
        };
      });
      expect(detailsScrolls, "差分が長いので、差分の欄の中でスクロールする").toBe(true);
      expect(dockScrolls, "ドックの中がスクロールしている（二重のスクロール）").toBe(false);
      await expect(dock(page)).not.toHaveAttribute("data-more-below");
      await expectDockOnScreen(page);
      for (const name of ["別の場所の内容を使う", "この画面の内容で上書きする"]) {
        await expect(conflict.getByRole("button", { name })).toBeInViewport({ ratio: 1 });
      }
      // 凡例は差分をスクロールする欄の外にあり、差分を送っても同じ位置で見え続ける
      const legend = dock(page).locator(".diff-legend");
      const legendBefore = await boxOf(legend);
      await dock(page)
        .locator(".notice-details")
        .evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
      expect((await boxOf(legend)).y, "差分を送ると凡例が動いた").toBe(legendBefore.y);
      await expect(legend).toBeInViewport({ ratio: 1 });
    });
  }
});

test("最初の変更の前に共通の行が続いても、最初の表示で変更の行が見える", async ({
  page,
  api,
}, testInfo) => {
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "差分の最初の変更"));
  const pagePath = `**/api/pages/${created.id}`;
  let external: Promise<ApiPage> | undefined;
  await page.route(pagePath, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    external ??= api.updatePage(created, {
      body: LINES.map((line, index) => (index === 40 ? `${line}を別の場所で直した` : line)).join(
        "\n",
      ),
    });
    const updated = await external.then(
      () => true,
      () => false,
    );
    return updated ? route.fallback() : route.abort();
  });
  // 手元の変更も遠い行にして、差分の先頭に共通の行を続ける
  await typeAt(page, 20, "、手元の変更");
  await expect.poll(() => external, "保存が送られない").toBeDefined();
  await external;
  await expect(
    page.getByRole("alert").filter({
      has: page.getByRole("heading", { name: "別の場所でも更新されています" }),
    }),
  ).toBeVisible();
  const details = await boxOf(dock(page).locator(".notice-details"));
  const first = await boxOf(dock(page).locator(".diff-delete, .diff-insert").first());
  expect(first.y, "最初の変更の行が差分の欄の上にはみ出している").toBeGreaterThanOrEqual(
    details.y - 0.5,
  );
  expect(first.y + first.height, "最初の変更の行が差分の欄に見えていない").toBeLessThanOrEqual(
    details.y + details.height + 0.5,
  );
});

test("ドックの上限に達して中でスクロールするとき、続きのある端に手がかりが出る", async ({
  page,
  api,
}, testInfo) => {
  const conflict = await provokeLongConflict(page, api, uniqueTitle(testInfo, "続きの手がかり"));
  // ドックの上限が、通知の下限の高さを収められる限りも下回る低い画面にする。通知は下限の高さのまま、ドックの中をスクロールする
  await page.setViewportSize({ width: 393, height: 360 });
  const edge = (name: "before" | "after") =>
    dock(page).evaluate(
      (element, pseudo) => getComputedStyle(element, `::${pseudo}`).content,
      name,
    );
  await expect(dock(page)).toHaveAttribute("data-more-below", "");
  await expect(dock(page)).not.toHaveAttribute("data-more-above");
  // 通知がドックより高くても、details の欄は通知の枠の中に収まる
  const notice = await boxOf(page.locator(".notice"));
  const details = await boxOf(page.locator(".notice-details"));
  expect(details.y + details.height, "details が通知の枠の下にはみ出している").toBeLessThanOrEqual(
    notice.y + notice.height,
  );
  expect(await edge("after")).not.toBe("none");
  expect(await edge("before")).toBe("none");

  await dock(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(dock(page)).toHaveAttribute("data-more-above", "");
  await expect(dock(page)).not.toHaveAttribute("data-more-below");
  expect(await edge("before")).not.toBe("none");
  expect(await edge("after")).toBe("none");
  // 先頭へ戻れば、操作が見える
  await dock(page).evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(dock(page)).not.toHaveAttribute("data-more-above");
  await expect(conflict.getByRole("button", { name: "この画面の内容で上書きする" })).toBeInViewport(
    {
      ratio: 1,
    },
  );

  // 確認の段でも、実行とやめるの両方がドックの中に見えて押せる
  await conflict.getByRole("button", { name: "この画面の内容で上書きする" }).click();
  const dockBox = await boxOf(dock(page));
  for (const name of ["上書きする", "やめる"]) {
    const button = conflict.getByRole("button", { name });
    await expect(button).toBeInViewport({ ratio: 1 });
    await button.click({ trial: true });
    const box = await boxOf(button);
    expect(box.y, `${name} がドックの上にはみ出している`).toBeGreaterThanOrEqual(dockBox.y);
    expect(box.y + box.height, `${name} がドックの下にはみ出している`).toBeLessThanOrEqual(
      dockBox.y + dockBox.height,
    );
  }
});

test.describe("ドックの上限の境の前後の高さと狭い幅", () => {
  // theme.css の値から出る境。通知の下限の高さ 24rem とドックの余白 2 * 0.75rem を足した 408px が、
  // ドックの既定の上限（0.6）に収まる最も低い高さが 680px、広げた上限（0.85）に収まる最も低い高さが 480px
  const HEIGHTS = [720, 700, 681, 679, 660, 560, 520, 500, 485];
  const REM = 16;
  const NOTICE_MIN = 24 * REM;
  const DOCK_RATIO = 0.6;
  const DOCK_PADDING = 2 * 0.75 * REM;

  for (const width of [320, 375, 393]) {
    test(`幅 ${width}`, async ({ page, api }, testInfo) => {
      await provokeLongConflict(page, api, uniqueTitle(testInfo, "低い画面"));
      for (const height of HEIGHTS) {
        await page.setViewportSize({ width, height });
        const label = `${width}x${height}`;
        // 上の境（680）より高ければ通知はドックの上限に合わせて伸び、低ければ下限の高さのまま、ドックが上限を広げて収める
        const noticeHeight = Math.max(NOTICE_MIN, height * DOCK_RATIO - DOCK_PADDING);
        await expect
          .poll(
            () =>
              dock(page).evaluate((element) => {
                const details = element.querySelector(".notice-details") as HTMLElement;
                const notice = element.querySelector(".notice") as HTMLElement;
                return {
                  dockScrolls: element.scrollHeight > element.clientHeight + 1,
                  detailsScrolls: details.scrollHeight > details.clientHeight + 1,
                  detailsInside:
                    details.getBoundingClientRect().bottom <=
                    notice.getBoundingClientRect().bottom + 0.5,
                  noticeHeight: Math.round(notice.getBoundingClientRect().height),
                };
              }),
            { message: label },
          )
          .toEqual({
            dockScrolls: false,
            detailsScrolls: true,
            detailsInside: true,
            noticeHeight: Math.round(noticeHeight),
          });
        await expect(dock(page)).not.toHaveAttribute("data-more-below");
        await expectDockOnScreen(page);
        await expectNoHorizontalScroll(page);
      }
    });
  }
});

test("上限に達していないドックには、手がかりを出さない", async ({ page, api }, testInfo) => {
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "手がかりなし"));
  await failSaveWith500(page, created);
  await typeAt(page, 0, "、足す");
  await expect(page.getByRole("alert").filter({ hasText: "保存できませんでした" })).toBeVisible();
  await expect(dock(page)).not.toHaveAttribute("data-more-above");
  await expect(dock(page)).not.toHaveAttribute("data-more-below");
});

test("ドックの地は余白まで不透明で、余白を押しても後ろの本文に届かない", async ({
  page,
  api,
}, testInfo) => {
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "台の地"));
  await failSaveWith500(page, created);
  await typeAt(page, 0, "、足す");
  await expect(page.getByRole("alert").filter({ hasText: "保存できませんでした" })).toBeVisible();
  const { background, bodyBackground, hit } = await page.evaluate(() => {
    const dockEl = document.querySelector(".notice-dock") as HTMLElement;
    const rect = dockEl.getBoundingClientRect();
    // 通知の枠の外、ドックの余白の中の点（左上の隅の内側）
    const target = document.elementFromPoint(rect.left + 3, rect.top + 3);
    return {
      background: getComputedStyle(dockEl).backgroundColor,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      hit: target === dockEl,
    };
  });
  expect(background).toBe(bodyBackground);
  expect(hit, "ドックの余白が、後ろの本文の要素に操作を通している").toBe(true);
});

test("リンクの書き換えが通信の失敗で止まったら、alert の通知に再試行を出し、続きから進めると消える", async ({
  page,
  api,
}, testInfo) => {
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "書き換えの停止"),
    body: BODY,
  });
  let failing = true;
  await page.route("**/api/link-rewrites/step", (route) =>
    failing
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "internal" }),
        })
      : route.fallback(),
  );
  await page.goto(`/p/${created.id}`);
  const stopped = page
    .getByRole("alert")
    .filter({ hasText: "他のページのリンクの書き換えが止まりました" });
  await expect(stopped).toBeVisible();
  await expect(stopped.getByRole("button", { name: "再試行" })).toBeVisible();
  await expectDockOnScreen(page);

  // 再試行が通れば止まった通知は消える。完了の報告は status で、alert ではない
  failing = false;
  await stopped.getByRole("button", { name: "再試行" }).click();
  await expect(stopped).toBeHidden();
  await expect(page.getByRole("alert").filter({ hasText: "書き換え" })).toHaveCount(0);
});
