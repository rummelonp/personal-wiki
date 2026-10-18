import type { Locator, Page, Route } from "@playwright/test";
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
 * 失敗の扱い: 保存が 401、500、オフライン、版の衝突で失敗したとき、案内が出て、
 * 打った内容が画面から消えず、案内に従えば保存まで進める。
 * 401 と 500 は保存の PUT だけを page.route で差し替える。衝突は差し替えず、別の場所（REST）から
 * 実際に保存して起こす（差し替えた 409 では、取り直した版が手元の版と同じなので衝突にならず、
 * 送り直しを繰り返す）。
 */

const FIRST_LINE = "最初からある行";

async function openFreshPage(page: Page, api: OwnerApi, title: string): Promise<ApiPage> {
  const created = await api.createPage({ title, body: FIRST_LINE });
  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page)).toHaveText(FIRST_LINE);
  await expect(saveState(page)).toHaveText("保存済み");
  return created;
}

const isSave = (route: Route) => route.request().method() === "PUT";

async function expectSavedOnServer(api: OwnerApi, id: string, body: string): Promise<void> {
  expect((await api.getPage(id)).body).toBe(body);
}

test("保存が 401 になるとログインし直す案内が出て、再試行で保存できる", async ({
  page,
  api,
}, testInfo) => {
  const created = await openFreshPage(page, api, uniqueTitle(testInfo, "401"));
  const pagePath = `**/api/pages/${created.id}`;
  await page.route(pagePath, (route) =>
    isSave(route)
      ? route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "unauthorized" }),
        })
      : route.fallback(),
  );
  const typed = "、ログインが切れても残る";
  await typeAtBodyEnd(page, typed);
  const alert = page.getByRole("alert").filter({ hasText: "ログインの期限が切れました" });
  await expect(alert).toContainText("未保存の内容は、この端末に残してあります。");
  await expect(saveState(page)).toHaveText("ログインの期限切れ");
  await expect(bodyEditor(page)).toHaveText(FIRST_LINE + typed);

  await page.unroute(pagePath);
  await alert.getByRole("button", { name: "もう一度保存する" }).click();
  await expect(saveState(page)).toHaveText("保存済み");
  await expect(alert).toBeHidden();
  await expectSavedOnServer(api, created.id, FIRST_LINE + typed);
});

test("保存が 500 になると失敗の案内が出て、もう一度保存できる", async ({ page, api }, testInfo) => {
  const created = await openFreshPage(page, api, uniqueTitle(testInfo, "500"));
  const pagePath = `**/api/pages/${created.id}`;
  await page.route(pagePath, (route) =>
    isSave(route)
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "internal" }),
        })
      : route.fallback(),
  );
  const typed = "、サーバーが落ちても残る";
  await typeAtBodyEnd(page, typed);
  const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
  await expect(alert).toContainText("wiki の側で問題が起きました");
  await expect(alert).toContainText("時間をおいて、もう一度試してください。");
  await expect(alert).toContainText("入力した内容は、この端末に残してあります。");
  await expect(saveState(page)).toHaveText("保存に失敗");
  await expect(bodyEditor(page)).toHaveText(FIRST_LINE + typed);

  await page.unroute(pagePath);
  await alert.getByRole("button", { name: "もう一度保存する" }).click();
  await expect(saveState(page)).toHaveText("保存済み");
  await expect(alert).toBeHidden();
  await expectSavedOnServer(api, created.id, FIRST_LINE + typed);
});

interface FailingSaves {
  puts: () => number;
  /** 応答を止める。戻り値で再開する。 */
  hold: () => () => void;
}

/**
 * 保存の PUT をすべて 500 にする。応答は DELAY_MS だけ遅らせる。即座に返すと、通知が作り直された直後に
 * 検査が走り、作り直しの間の focus の動き（WebKit は消えた直後に本文へ移す）を測れない。
 */
const DELAY_MS = 100;

async function failSaves(page: Page, id: string): Promise<FailingSaves> {
  let puts = 0;
  let gate: Promise<void> | null = null;
  await page.route(`**/api/pages/${id}`, async (route) => {
    if (!isSave(route)) return route.fallback();
    puts += 1;
    await gate;
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "internal" }),
    });
  });
  return {
    puts: () => puts,
    hold: () => {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

async function clickCenter(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error("クリックする要素の位置が取れない");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("もう一度保存するを Enter で押して再び失敗しても、focus は失敗の通知の中に残る", async ({
  page,
  api,
}, testInfo) => {
  const created = await openFreshPage(page, api, uniqueTitle(testInfo, "再送の focus"));
  const saves = await failSaves(page, created.id);
  await typeAtBodyEnd(page, "、再送が失敗する");
  const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
  await expect(alert).toBeVisible();
  const retry = alert.getByRole("button", { name: "もう一度保存する" });
  // ボタンへ移ると本文の blur が保存を始めるので、その失敗でボタンが作り直された後の focus から始める
  const first = saves.puts();
  await retry.focus();
  await expect.poll(saves.puts, "blur の保存が送られない").toBeGreaterThan(first);
  await expect(saveState(page)).toHaveText("保存に失敗");
  await expect(retry).toBeFocused();

  // 応答の遅れの間に、押したボタンが消えて作り直される。何度押しても focus が残る
  for (let round = 0; round < 2; round++) {
    const before = saves.puts();
    await page.keyboard.press("Enter");
    await expect.poll(saves.puts, "再送が送られない").toBeGreaterThan(before);
    await expect(retry).toBeFocused();
    await expect(retry).toBeEnabled();
  }
});

test("もう一度保存するを Enter で押して応答を待つ間にもう一度 Enter を押しても、本文は変わらない", async ({
  page,
  api,
}, testInfo) => {
  const created = await openFreshPage(page, api, uniqueTitle(testInfo, "待つ間の Enter"));
  const saves = await failSaves(page, created.id);
  const typed = "、待つ間に押す";
  await typeAtBodyEnd(page, typed);
  const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
  await expect(alert).toBeVisible();
  const retry = alert.getByRole("button", { name: "もう一度保存する" });
  const first = saves.puts();
  await retry.focus();
  await expect.poll(saves.puts, "blur の保存が送られない").toBeGreaterThan(first);
  await expect(saveState(page)).toHaveText("保存に失敗");
  await expect(retry).toBeFocused();

  // 押したボタンは待つ間に消える。WebKit は本文の選択が残っていると、focus を本文へ移すか、
  // 打鍵の既定の動作を本文へ届けるので、2 回目の Enter が改行として入らないよう、待つ間の focus の置き場を持つ。
  // toHaveText は空白を畳むので、改行は innerText で見る
  const release = saves.hold();
  const before = saves.puts();
  await page.keyboard.press("Enter");
  await expect.poll(saves.puts, "再送が送られない").toBeGreaterThan(before);
  await expect(retry).toBeHidden();
  await page.keyboard.press("Enter");
  release();
  await expect(retry).toBeFocused();
  await expect(retry).toBeEnabled();
  const bodyText = () => bodyEditor(page).evaluate((element) => (element as HTMLElement).innerText);
  expect(await bodyText()).toBe(FIRST_LINE + typed);
});

test("再送の応答を待つ間に Enter を押して、再送が成功しても、本文は変わらず focus は body に落ちない", async ({
  page,
  api,
  isMobile,
}, testInfo) => {
  const created = await openFreshPage(page, api, uniqueTitle(testInfo, "待つ間の成功"));
  let succeed = false;
  let puts = 0;
  let gate: Promise<void> | null = null;
  await page.route(`**/api/pages/${created.id}`, async (route) => {
    if (!isSave(route)) return route.fallback();
    puts += 1;
    await gate;
    if (succeed) return route.fallback();
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "internal" }),
    });
  });
  const typed = "、成功しても残る";
  await typeAtBodyEnd(page, typed);
  const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
  const retry = alert.getByRole("button", { name: "もう一度保存する" });
  await expect(retry).toBeVisible();
  const first = puts;
  await retry.focus();
  await expect.poll(() => puts, "blur の保存が送られない").toBeGreaterThan(first);
  await expect(saveState(page)).toHaveText("保存に失敗");
  await expect(retry).toBeFocused();

  let release = () => {};
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  succeed = true;
  const before = puts;
  await page.keyboard.press("Enter");
  await expect.poll(() => puts, "再送が送られない").toBeGreaterThan(before);
  await expect(retry).toBeHidden();
  await page.keyboard.press("Enter");
  release();
  await expect(saveState(page)).toHaveText("保存済み");
  await expect(alert).toBeHidden();
  // タッチ端末では、キーボードを開かないよう、本文でなくページの枠に移る
  if (isMobile) await expect(page.locator("article.note")).toBeFocused();
  else await expect(bodyEditor(page)).toBeFocused();
  const bodyText = () => bodyEditor(page).evaluate((element) => (element as HTMLElement).innerText);
  expect(await bodyText()).toBe(FIRST_LINE + typed);
  await expectSavedOnServer(api, created.id, FIRST_LINE + typed);
});

test("本文を打った後に失敗の通知のボタンを押し、blur の保存が失敗しても、focus はその通知に残る", async ({
  page,
  api,
}, testInfo) => {
  const created = await openFreshPage(page, api, uniqueTitle(testInfo, "blur の focus"));
  const saves = await failSaves(page, created.id);
  await typeAtBodyEnd(page, "、最初の失敗");
  const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
  await expect(alert).toBeVisible();
  const retry = alert.getByRole("button", { name: "もう一度保存する" });
  // 失敗の後にさらに打つと、本文の blur が次の保存を始める。実際の押下では、その保存が focus の着く前にボタンを消す
  await typeAtBodyEnd(page, "、続きを打つ");
  const before = saves.puts();
  await clickCenter(page, retry);
  await expect.poll(saves.puts, "blur の保存が送られない").toBeGreaterThan(before);
  await expect(saveState(page)).toHaveText("保存に失敗");
  await expect(retry).toBeFocused();
});

test("再送が失敗して通知が作り直されても、その間に本文へ移した focus は奪わない", async ({
  page,
  api,
}, testInfo) => {
  const created = await openFreshPage(page, api, uniqueTitle(testInfo, "focus を奪わない"));
  const saves = await failSaves(page, created.id);
  await typeAtBodyEnd(page, "、奪わない");
  const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
  const retry = alert.getByRole("button", { name: "もう一度保存する" });
  await expect(retry).toBeVisible();
  const release = saves.hold();
  await retry.focus();
  await page.keyboard.press("Enter");
  // 再送の応答を待つ間に本文を打ち始める
  await bodyEditor(page).locator(".cm-line").first().click();
  await expect(bodyEditor(page)).toBeFocused();
  release();
  await expect(retry).toBeEnabled();
  await expect(bodyEditor(page)).toBeFocused();
});

test("オフラインで保存できないと失敗の案内が出て、戻ってからもう一度保存できる", async ({
  page,
  context,
  api,
}, testInfo) => {
  const created = await openFreshPage(page, api, uniqueTitle(testInfo, "オフライン"));
  await context.setOffline(true);
  const typed = "、オフラインでも残る";
  await typeAtBodyEnd(page, typed);
  const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
  await expect(alert).toContainText("接続できません");
  await expect(bodyEditor(page)).toHaveText(FIRST_LINE + typed);

  await context.setOffline(false);
  await alert.getByRole("button", { name: "もう一度保存する" }).click();
  await expect(saveState(page)).toHaveText("保存済み");
  await expectSavedOnServer(api, created.id, FIRST_LINE + typed);
});

test("別の場所の保存と食い違うと衝突の画面が出て、手元で上書きできる", async ({
  page,
  api,
  isMobile,
}, testInfo) => {
  const created = await openFreshPage(page, api, uniqueTitle(testInfo, "衝突"));
  const pagePath = `**/api/pages/${created.id}`;
  // 最初の保存を送る直前に、同じ行を別の場所で書き換える。手元の入力の速さに左右されずに、
  // 古い版への保存（409）になる
  let external: Promise<ApiPage> | undefined;
  await page.route(pagePath, async (route) => {
    if (!isSave(route)) return route.fallback();
    external ??= api.updatePage(created, { body: `${FIRST_LINE}を別の場所で書き換えた` });
    // 失敗はテストの本体で await して出す。handler の中で投げると、原因の書かれない失敗になる
    const updated = await external.then(
      () => true,
      () => false,
    );
    return updated ? route.fallback() : route.abort();
  });
  const typed = "を手元で書き換えた";
  await typeAtBodyEnd(page, typed);
  await expect.poll(() => external, "保存が送られない").toBeDefined();
  await external;
  const conflict = page.getByRole("alert").filter({
    has: page.getByRole("heading", { name: "別の場所でも更新されています" }),
  });
  await expect(conflict).toBeVisible();
  await expect(saveState(page)).toHaveText("別の場所でも更新あり");
  await expect(bodyEditor(page)).toHaveText(FIRST_LINE + typed);

  await page.unroute(pagePath);
  // 上書きはサーバーの最新を置き換えるので、押す前に確かめる。断れば何も変わらない
  await conflict.getByRole("button", { name: "この画面の内容で上書きする" }).click();
  await conflict.getByRole("button", { name: "やめる" }).click();
  await expect(conflict).toBeVisible();
  await conflict.getByRole("button", { name: "この画面の内容で上書きする" }).click();
  await conflict.getByRole("button", { name: "上書きする" }).click();
  await expect(saveState(page)).toHaveText("保存済み");
  await expect(conflict).toBeHidden();
  // タッチ端末では、確認の操作で閉じたキーボードを開き直さないよう、本文でなくページの枠に移る
  if (isMobile) await expect(page.locator("article.note")).toBeFocused();
  else await expect(bodyEditor(page)).toBeFocused();
  await expectSavedOnServer(api, created.id, FIRST_LINE + typed);
});

for (const [label, kind] of [
  ["残った内容に戻す", "restore"],
  ["残った内容を破棄する", "discard"],
] as const) {
  test(`端末に残った内容をキーボードで「${label}」と選んでも、focus は body に落ちない`, async ({
    page,
    api,
    isMobile,
  }, testInfo) => {
    const title = uniqueTitle(testInfo, `残った内容 ${kind}`);
    const created = await api.createPage({ title, body: FIRST_LINE });
    const kept = `${FIRST_LINE}、端末に残っていた内容`;
    await page.addInitScript(
      ({ key, value }) => {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      },
      {
        key: `personal-wiki:draft:${created.id}`,
        value: JSON.stringify({
          title,
          body: kept,
          baseVersion: created.version,
          savedAt: Date.now(),
        }),
      },
    );
    await page.goto(`/p/${created.id}`);
    const notice = page
      .getByRole("alert")
      .filter({ hasText: "前回、保存できなかった内容があります" });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole("heading")).toBeFocused();
    const button = notice.getByRole("button", { name: label });
    // WebKit の Tab はボタンを飛ばすので、focus を直接移して Enter で押す
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(notice).toBeHidden();

    // タッチ端末では、キーボードを開かないよう、本文でなくページの枠に移る
    if (isMobile) await expect(page.locator("article.note")).toBeFocused();
    else await expect(bodyEditor(page)).toBeFocused();
    await expect(bodyEditor(page)).toHaveText(kind === "restore" ? kept : FIRST_LINE);
  });
}
