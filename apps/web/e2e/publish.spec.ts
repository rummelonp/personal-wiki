import type { Page } from "@playwright/test";
import type { OwnerApi } from "./support/api";
import {
  bodyEditor,
  expect,
  expectNoHorizontalScroll,
  saveState,
  test,
  typeAtBodyEnd,
  uniqueTitle,
} from "./support/fixtures";
import { lineTexts, midPhraseBreaks } from "./support/line-breaks";
import { E2E_ORIGIN } from "./support/stack";

/*
 * ページの公開の導線: title の右の印で公開範囲を見て、押して開くメニューで切り替える。
 * draft から公開へは画面の中央のダイアログで確認を挟み、公開から draft へは挟まない。匿名からの見え方は、
 * cookie の無い fetch で調べる（owner の画面が「公開」と言っていても、実際に匿名に出ているかは別に確かめる）。
 */

const titlePath = (title: string) => `/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
const pill = (page: Page) => page.locator(".visibility-pill");
const menu = (page: Page) => page.getByRole("menu", { name: "公開範囲" });
const menuItem = (page: Page, label: "下書き" | "公開") =>
  page.getByRole("menuitemradio", { name: label, exact: true });
const confirmDialog = (page: Page) => page.getByRole("dialog", { name: "公開の確認" });
// 結果と変更中の読み上げ。見た目は印が受け持つので、画面には出さない
const notice = (page: Page) => page.locator(".visibility > [role='status']");
const expectShown = (page: Page, visibility: "draft" | "public") =>
  expect(pill(page)).toHaveAttribute("data-visibility", visibility);

/** 印を押してメニューを開き、項目を選ぶ。「公開」は確認のダイアログを開くところまで */
async function choose(
  page: Page,
  label: "下書き" | "公開",
  how: "click" | "tap" | "dispatch" = "click",
) {
  if (how === "tap") await pill(page).tap();
  else if (how === "dispatch") await pill(page).dispatchEvent("click");
  else await pill(page).click();
  await expect(menu(page)).toBeVisible();
  if (how === "tap") await menuItem(page, label).tap();
  else if (how === "dispatch") await menuItem(page, label).dispatchEvent("click");
  else await menuItem(page, label).click();
}

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

test("公開の確認の本文は、デスクトップの幅で最後の行が 1 字と句読点だけにならない", async ({
  page,
  api,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "デスクトップの幅で測る");
  await openDraft(page, uniqueTitle(testInfo, "公開の確認の折り返し"), api);
  await choose(page, "公開");
  const text = confirmDialog(page).locator(".publish-dialog-head > p");
  await expect(text).toBeVisible();
  const lines = await lineTexts(text);
  expect(lines.length, "本文が折り返していないので測れていない").toBeGreaterThan(1);
  // 句読点は行頭に来ないので、「ん。」のように 1 字と句点だけの行も 1 字の行として数える
  const lastLine = lines.at(-1) ?? "";
  expect(
    lastLine.replace(/[、。]/g, "").length,
    `最後の行「${lastLine}」の字数`,
  ).toBeGreaterThanOrEqual(2);
});

test("公開の確認の本文は、iPhone の幅で語の途中で折り返さない", async ({ page, api }, testInfo) => {
  test.skip(testInfo.project.name !== "webkit-iphone", "auto-phrase を解釈しない描画で測る");
  await openDraft(page, uniqueTitle(testInfo, "公開の確認の文節"), api);
  await choose(page, "公開");
  const text = confirmDialog(page).locator(".publish-dialog-head > p");
  await expect(text).toBeVisible();
  expect((await lineTexts(text)).length, "本文が折り返していないので測れていない").toBeGreaterThan(
    1,
  );
  expect(await midPhraseBreaks(text), "語の途中で折り返している").toEqual([]);
});

test("公開の確認を取り消すと、draft のまま匿名に出ない", async ({ page, api }, testInfo) => {
  const title = uniqueTitle(testInfo, "公開の取り消し");
  await openDraft(page, title, api);
  await expectShown(page, "draft");
  await expect(pill(page)).toHaveAccessibleName("公開範囲: 下書き");
  await expect(page.getByRole("button", { name: "URL をコピー" })).toHaveCount(0);

  await choose(page, "公開");
  await expect(menu(page)).toHaveCount(0);
  await expect(confirmDialog(page)).toContainText("一覧、検索、タグにも載ります");
  // 開いた直後の焦点は、確定でなく「やめる」に置く
  await expect(confirmDialog(page).getByRole("button", { name: "やめる" })).toBeFocused();
  // 確認の最中は、まだ何も変わっていない
  await expectShown(page, "draft");
  expect(await anonymousSees(title)).toBe(false);
  // 塗りの強調はヘッダーの新規作成の 1 つだけ。確定の操作も塗らない
  await expect(page.locator(".main .button-primary")).toHaveCount(0);

  // 焦点のある「やめる」を Enter で押すと閉じ、焦点を印に戻す。Enter を重ねても確定しない
  await page.keyboard.press("Enter");
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(pill(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expectShown(page, "draft");
  expect(await anonymousSees(title)).toBe(false);

  // Escape でも閉じる
  await choose(page, "公開");
  await expect(confirmDialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(pill(page)).toBeFocused();
  expect(await anonymousSees(title)).toBe(false);

  // 枠の外（backdrop）を押しても閉じる
  await choose(page, "公開");
  await expect(confirmDialog(page)).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(confirmDialog(page)).toHaveCount(0);
  await expectShown(page, "draft");
  expect(await anonymousSees(title)).toBe(false);
});

/*
 * dialog の close は、閉じた後の別のタスクで届く。届く時刻は負荷で揺れるので、手元では起きにくい順序を、
 * close を止めて決まった時点で届けることで作る。ページにあるすべての dialog の close を止める。
 */
async function holdDialogClose(page: Page) {
  await page.addInitScript(() => {
    const held: Element[] = [];
    const resend = new WeakSet<Event>();
    window.addEventListener(
      "close",
      (event) => {
        if (resend.has(event) || !(event.target instanceof HTMLDialogElement)) return;
        event.stopImmediatePropagation();
        held.push(event.target);
      },
      true,
    );
    (window as unknown as { releaseDialogClose: () => void }).releaseDialogClose = () => {
      for (const target of held.splice(0)) {
        const event = new Event("close");
        resend.add(event);
        target.dispatchEvent(event);
      }
    };
  });
}
const releaseDialogClose = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { releaseDialogClose: () => void }).releaseDialogClose(),
  );

test("確認の close が遅れて届いても、開き直した確認とメニューの焦点に触らない", async ({
  page,
  api,
}, testInfo) => {
  await holdDialogClose(page);
  const title = uniqueTitle(testInfo, "close の遅れ");
  await openDraft(page, title, api);

  // 閉じた直後にメニューを開いても、遅れて届いた close が焦点を印へ奪わず、Escape でメニューが閉じる
  await choose(page, "公開");
  await expect(confirmDialog(page).getByRole("button", { name: "やめる" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(pill(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menuItem(page, "下書き")).toBeFocused();
  await releaseDialogClose(page);
  await expect(menuItem(page, "下書き")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);

  // Escape で閉じた直後に選び直しても、遅れて届く close の前に確認が開き、その close で閉じない
  await choose(page, "公開");
  await expect(confirmDialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmDialog(page)).toHaveCount(0);
  await choose(page, "公開");
  await expect(confirmDialog(page)).toBeVisible();
  await releaseDialogClose(page);
  await expect(confirmDialog(page).getByRole("button", { name: "やめる" })).toBeFocused();
  expect(await anonymousSees(title)).toBe(false);
});

test("公開の応答を待つ間に閉じた確認が焦点を持っていても、公開が済んだら焦点を印に戻す", async ({
  page,
  api,
}, testInfo) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/pages/*/visibility", async (route) => {
    await held;
    return route.fallback();
  });
  const title = uniqueTitle(testInfo, "公開の応答待ちの焦点");
  await openDraft(page, title, api);

  await choose(page, "公開");
  await confirmDialog(page).getByRole("button", { name: "公開する" }).click();
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(pill(page)).toBeDisabled();
  // WebKit は押したボタンでなく dialog 自身に焦点を移し、閉じるときに戻し先の印が無効だと、次の描画まで
  // 閉じた dialog を activeElement に残す。応答がその間に届く順序は描画の時刻で揺れるので、どのエンジンでも
  // 同じ状態を作る。閉じた dialog はページを開いた時から DOM にあるので、ほかの判定に効かないよう押した後に入れる
  await page.evaluate(() => {
    const real = Object.getOwnPropertyDescriptor(Document.prototype, "activeElement")?.get;
    if (real === undefined) throw new Error("activeElement の getter が無い");
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get() {
        const active = real.call(document) as Element | null;
        const closed = document.querySelector("dialog.publish-dialog:not([open])");
        return closed !== null && (active === null || active === document.body) ? closed : active;
      },
    });
    // 無効な印は焦点を保てない
    (document.activeElement as HTMLElement | null)?.blur();
  });
  release();
  await expectShown(page, "public");
  await expect(pill(page)).toBeFocused();
});

test("公開範囲のメニューは、キーボードで選べ、Escape と外側の押下で何も変えずに閉じる", async ({
  page,
  api,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "公開範囲のメニュー");
  await openDraft(page, title, api);

  await pill(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu(page)).toBeVisible();
  await expect(pill(page)).toHaveAttribute("aria-expanded", "true");
  // 開いたら選択中の項目に焦点を置く
  await expect(menuItem(page, "下書き")).toBeFocused();
  await expect(menuItem(page, "下書き")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowDown");
  await expect(menuItem(page, "公開")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(pill(page)).toBeFocused();
  await expect(pill(page)).toHaveAttribute("aria-expanded", "false");

  await pill(page).click();
  await expect(menu(page)).toBeVisible();
  await page.locator(".body-editor").click();
  await expect(menu(page)).toHaveCount(0);
  await expect(bodyEditor(page)).toBeFocused();
  await expect(confirmDialog(page)).toHaveCount(0);
  await expectShown(page, "draft");

  // キーボードだけで公開の確認まで進む
  await pill(page).focus();
  await page.keyboard.press("Enter");
  await expect(menuItem(page, "下書き")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(confirmDialog(page).getByRole("button", { name: "やめる" })).toBeFocused();
  await page.keyboard.press("Escape");
  expect(await anonymousSees(title)).toBe(false);
});

// 外側を押したときの焦点は、mousedown の既定の動作と焦点が移る順序がエンジンごとに違う。
// 主の環境のほかに、Firefox とデスクトップの Safari でも @smoke で確かめる
test("公開範囲のメニューを外側で押して閉じると、焦点は押した先の入力欄に残り、焦点を持たない場所なら印へ戻る @smoke", async ({
  page,
  api,
  hasTouch,
}, testInfo) => {
  // 狭い幅ではメニューが本文の先頭の行に重なるので、メニューの下まで届く行数にする
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "外側の押下の焦点"),
    body: Array.from({ length: 30 }, (_, index) => `焦点の検査の ${index + 1} 行目`).join("\n\n"),
  });
  await page.goto(`/p/${created.id}`);
  await expect(pill(page)).toBeVisible();
  // 押す操作は端末に合わせる。タッチの端末ではタップから作られる event の順で届く
  const press = (target: ReturnType<Page["locator"]>, corner = false) => {
    const options = corner ? { position: { x: 2, y: 2 } } : {};
    return hasTouch ? target.tap(options) : target.click(options);
  };

  await pill(page).focus();
  await page.keyboard.press("Enter");
  await expect(menu(page)).toBeVisible();
  await press(bodyEditor(page).locator(".cm-line").last());
  await expect(menu(page)).toHaveCount(0);
  await expect(bodyEditor(page)).toBeFocused();

  // 焦点を持たない場所（ヘッダーの余白）を押す。本文の近くの余白は、Chromium が最も近い入力欄へ焦点を移す
  await pill(page).focus();
  await page.keyboard.press("Enter");
  await expect(menu(page)).toBeVisible();
  await press(page.locator(".header"), true);
  await expect(menu(page)).toHaveCount(0);
  await expect(pill(page)).toBeFocused();
  // 閉じた後も、キーボードで続けられる
  await page.keyboard.press("Enter");
  await expect(menu(page)).toBeVisible();
  await expect(menuItem(page, "下書き")).toBeFocused();
  await page.keyboard.press("Escape");
  await expectShown(page, "draft");
});

// Safari はボタンを押しても焦点を移さないので、開いたメニューを印で閉じると、焦点を持っていた項目が消える。
// デスクトップの Safari でも @smoke で確かめる
test("公開範囲のメニューを印を押して閉じると、焦点は印に戻り、続けてキーボードで操作できる @smoke", async ({
  page,
  api,
}, testInfo) => {
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "印を押して閉じる"),
    body: "印を押して閉じる検査の本文",
  });
  await page.goto(`/p/${created.id}`);
  await expect(pill(page)).toBeVisible();

  await pill(page).click();
  await expect(menuItem(page, "下書き")).toBeFocused();
  await pill(page).click();
  await expect(menu(page)).toHaveCount(0);
  await expect(pill(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menuItem(page, "下書き")).toBeFocused();
  await page.keyboard.press("Escape");
  await expectShown(page, "draft");
});

// Escape で閉じたときの焦点は、アプリが印へ戻すのが焦点の無いときだけで、通常はエンジンの既定
// （dialog を開いた時の焦点へ戻す）に任せている。確認を開く前に印へ焦点を置くので、既定の戻し先も印になる。
// どのエンジンでも印へ戻ることを確かめる
test("公開の確認を Escape で閉じると、焦点は印に戻り、続けてキーボードで操作できる @smoke", async ({
  page,
  api,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "確認を Escape で閉じる");
  await openDraft(page, title, api);

  await choose(page, "公開");
  await expect(confirmDialog(page).getByRole("button", { name: "やめる" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(pill(page)).toBeFocused();

  // 戻った印から、キーボードだけでもう一度開いて閉じられる
  await page.keyboard.press("Enter");
  await expect(menuItem(page, "下書き")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(confirmDialog(page).getByRole("button", { name: "やめる" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(pill(page)).toBeFocused();
  await expectShown(page, "draft");
  expect(await anonymousSees(title)).toBe(false);
});

test("確認を開いている間に他で内容が変わったら、確認を閉じる", async ({ page, api }, testInfo) => {
  const title = uniqueTitle(testInfo, "確認中の更新");
  const id = await openDraft(page, title, api);
  await choose(page, "公開");
  await expect(confirmDialog(page)).toBeVisible();
  await api.updatePage(await api.getPage(id), { body: "他で書き換えた本文" });
  // フォーカス復帰の確認は、最後の確認から 3 秒空ける
  await page.waitForTimeout(3_200);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(".body-editor")).toContainText("他で書き換えた本文");
  await expect(confirmDialog(page)).toHaveCount(0);
  expect(await anonymousSees(title)).toBe(false);
});

test("確認して公開すると匿名の一覧に出て、結果が知らされ、下書きに戻すと確認なしで消える @smoke", async ({
  page,
  api,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "公開と取り下げ");
  const id = await openDraft(page, title, api);
  expect(await anonymousListsTitle(title)).toBe(false);

  const pillColor = () => pill(page).evaluate((element) => getComputedStyle(element).color);
  const draftColor = await pillColor();

  await choose(page, "公開");
  await confirmDialog(page).getByRole("button", { name: "公開する" }).click();
  await expect(confirmDialog(page)).toHaveCount(0);
  await expectShown(page, "public");
  await expect(pill(page)).toHaveAccessibleName("公開範囲: 公開");
  // 差し色は公開中の印。draft は中立の色
  expect(await pillColor()).not.toBe(draftColor);
  await expect(notice(page)).toHaveText("公開しました。");
  // 確認を閉じて失った焦点を印に戻す
  await expect(pill(page)).toBeFocused();
  // 共有の URL はアドレスバーから取る。公開すると title の URL に置き換わる
  await expect.poll(() => new URL(page.url()).pathname).toBe(titlePath(title));
  expect(await anonymousListsTitle(title)).toBe(true);
  expect(await anonymousSees(title)).toBe(true);

  // 公開から draft へは確認を挟まない
  await choose(page, "下書き");
  await expect(confirmDialog(page)).toHaveCount(0);
  await expectShown(page, "draft");
  await expect(notice(page)).toHaveText("下書きに戻しました。");
  // draft は title の URL で開けないので、id の URL に戻る
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/p/${id}`);
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
  await choose(page, "公開");
  await confirmDialog(page).getByRole("button", { name: "公開する" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "公開範囲を変更できませんでした" }),
  ).toBeVisible();
  await expectShown(page, "draft");
  await expect(notice(page)).toHaveText("");
  expect(await anonymousSees(title)).toBe(false);

  await page.unroute("**/api/pages/*/visibility");
  await page.getByRole("button", { name: "もう一度公開にする" }).click();
  await expectShown(page, "public");
  await expect(notice(page)).toHaveText("公開しました。");
  expect(await anonymousSees(title)).toBe(true);
});

test("本文を編集した直後に「公開」を 1 回押すと、保存の間でも確認が開き、保存の後に公開する", async ({
  page,
  api,
  hasTouch,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "編集直後の公開");
  const id = await openDraft(page, title, api);
  // 保存を止め、押した時点で本文の blur が始めた保存が終わっていないようにする
  let releaseSaves: () => void = () => {};
  const saves = new Promise<void>((resolve) => {
    releaseSaves = resolve;
  });
  await page.route(`**/api/pages/${id}`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    await saves;
    return route.fallback();
  });

  let saveRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith(`/api/pages/${id}`)) saveRequests += 1;
  });

  await typeAtBodyEnd(page, "追記");
  // 保存は印を押す操作の途中の blur で始まる。押す前に始まっていれば、保存の間に選ぶ経路を通らない
  expect(saveRequests).toBe(0);
  // タッチの端末では、タップから作られる event の順でも届くことを見る
  await choose(page, "公開", hasTouch ? "tap" : "click");
  await expect(confirmDialog(page)).toBeVisible();
  // request の event は page の外から非同期に届くので、確認が開いた時点ではまだ数えていないことがある
  await expect.poll(() => saveRequests).toBe(1);
  await expect(saveState(page)).toHaveText("保存中…");

  await confirmDialog(page).getByRole("button", { name: "公開する" }).click();
  await expect(notice(page)).toHaveText("公開に変更中…");
  expect(await anonymousSees(title)).toBe(false);

  releaseSaves();
  await expectShown(page, "public");
  await expect(notice(page)).toHaveText("公開しました。");
  await expect(saveState(page)).toHaveText("保存済み");
  const saved = await api.getPage(id);
  expect(saved.body).toBe("公開の検査に使う本文追記");
  expect(saved.visibility).toBe("public");
  expect(await anonymousSees(title)).toBe(true);
});

test("自動保存が始まっている間にも、blur を伴わない「公開」の押下で確認が開き、保存の後に公開する", async ({
  page,
  api,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "自動保存中の公開");
  const id = await openDraft(page, title, api);
  let releaseSaves: () => void = () => {};
  const saves = new Promise<void>((resolve) => {
    releaseSaves = resolve;
  });
  await page.route(`**/api/pages/${id}`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    await saves;
    return route.fallback();
  });

  // ボタンを押しても本文の focus が外れない環境では、blur から保存が始まらない。
  // 入力が止まった後の自動保存が始まるのを待ち、click だけを送る
  const autosave = page.waitForRequest(
    (request) => request.method() === "PUT" && request.url().endsWith(`/api/pages/${id}`),
  );
  await typeAtBodyEnd(page, "追記");
  await autosave;
  await expect(saveState(page)).toHaveText("保存中…");
  await choose(page, "公開", "dispatch");
  await expect(confirmDialog(page)).toBeVisible();

  await confirmDialog(page).getByRole("button", { name: "公開する" }).click();
  await expect(notice(page)).toHaveText("公開に変更中…");
  expect(await anonymousSees(title)).toBe(false);

  releaseSaves();
  await expectShown(page, "public");
  await expect(notice(page)).toHaveText("公開しました。");
  const saved = await api.getPage(id);
  expect(saved.body).toBe("公開の検査に使う本文追記");
  expect(saved.visibility).toBe("public");
  expect(await anonymousSees(title)).toBe(true);
});

test("版の本文に戻している間も、ダイアログを閉じて「公開」を押せ、戻した後に公開する", async ({
  page,
  api,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "戻し中の公開");
  // draft の保存は 10 分のうちに 1 つの版へまとまるので、公開の版を先に作って区切る
  const created = await api.createPage({ title, body: "最初の本文", visibility: "public" });
  await api.updatePage(created, { body: "二つ目の本文" });
  await page.goto(`/p/${created.id}`);
  await choose(page, "下書き");
  await expect(notice(page)).toHaveText("下書きに戻しました。");
  const entries = page.locator(".rail-section-history .revision-entry");
  // 戻す前の保存を止め、戻している間（未保存の入力の保存が終わるまで）を作る
  let releaseSaves: () => void = () => {};
  const saves = new Promise<void>((resolve) => {
    releaseSaves = resolve;
  });
  await page.route(`**/api/pages/${created.id}`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    await saves;
    return route.fallback();
  });

  await typeAtBodyEnd(page, "を足した");
  await entries.last().click();
  const viewer = page.getByRole("dialog");
  await viewer.getByRole("button", { name: "全文" }).click();
  await expect(viewer.locator(".cm-content")).toHaveText("最初の本文");
  await viewer.getByRole("button", { name: "この版の本文に戻す" }).click();
  await expect(viewer.getByRole("button", { name: "戻し中…" })).toBeDisabled();
  await expect(saveState(page)).toHaveText("保存中…");
  await viewer.getByRole("button", { name: "閉じる" }).click();
  await expect(viewer).toHaveCount(0);

  await expect(pill(page)).toBeEnabled();
  await choose(page, "公開");
  await expect(confirmDialog(page)).toBeVisible();
  await confirmDialog(page).getByRole("button", { name: "公開する" }).click();
  await expect(notice(page)).toHaveText("公開に変更中…");
  expect(await anonymousSees(title)).toBe(false);

  releaseSaves();
  await expect(notice(page)).toHaveText("公開しました。");
  await expectShown(page, "public");
  await expect(page.locator(".body-editor")).toHaveText("最初の本文");
  const saved = await api.getPage(created.id);
  expect(saved.body).toBe("最初の本文");
  expect(saved.visibility).toBe("public");
  expect(await anonymousSees(title)).toBe(true);
});

test("作る前のページには、公開範囲の印を出さない", async ({ page }) => {
  await page.goto("/?new");
  await expect(page.locator(".title-input .cm-content")).toBeFocused();
  await expect(pill(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "URL をコピー" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "このページを削除" })).toHaveCount(0);
});

test.describe("公開範囲の印の配置 @widths", () => {
  for (const width of [375, 1280]) {
    test(`本文の上端は匿名の画面と同じ位置になる（幅 ${width}）`, async ({
      page,
      context,
      api,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      // 印の分だけ title の幅が狭いので、匿名の画面と同じ行数に収まる短い title で比べる。
      // 印の横で 1 行多く折り返す長さの title では、その 1 行の分だけ本文が下がる
      const title = `上端${Math.random().toString(36).slice(2, 8)}`;
      await api.createPage({ title, body: "上端をそろえる本文", visibility: "public" });
      const bodyTop = async () => {
        const line = page.locator(".body-editor .cm-line").first();
        await expect(line).toHaveText("上端をそろえる本文");
        return line.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
      };

      await page.goto(titlePath(title));
      await expect(pill(page)).toBeVisible();
      const ownerTop = await bodyTop();

      await context.clearCookies();
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(pill(page)).toHaveCount(0);
      expect(await bodyTop()).toBeCloseTo(ownerTop, 0);
    });
  }

  /**
   * 取得の間のスケルトンと読み込んだ後のページで、title の高さと本文の上端が同じかを確かめる。
   * 印の横では折り返し、印が無ければ 1 行に収まる title で測る。読み込んだ後に、この前提が崩れていないかも確かめる。
   * 取得（by-title）は `open` が始める前から止めておき、スケルトンを測ってから放す。
   */
  async function expectNoShiftWhileLoading(
    page: Page,
    title: string,
    open: () => Promise<void>,
  ): Promise<void> {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname === "/api/pages/by-title",
      async (route) => {
        await gate;
        await route.continue().catch(() => {});
      },
    );
    await open();
    // 起動時は owner か分からないので、ログインの状態が届いた後のスケルトンを測る
    await expect(page.getByRole("button", { name: "ログアウト" })).toBeVisible();
    await expect(page.locator(".note[aria-busy='true'] .note-title")).toHaveText(title);
    const skeleton = await page.evaluate(() => ({
      height: document.querySelector(".note-title")?.getBoundingClientRect().height ?? Number.NaN,
      body:
        (document.querySelector(".skeleton-body")?.getBoundingClientRect().top ?? Number.NaN) +
        window.scrollY,
    }));

    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await expect(pill(page)).toBeVisible();
    await expect(page.locator(".body-editor .cm-line").first()).toHaveText("上端をそろえる本文");
    const loaded = await page.evaluate(() => {
      const height = () =>
        document.querySelector(".title-input")?.getBoundingClientRect().height ?? Number.NaN;
      const visibility = document.querySelector<HTMLElement>(".visibility");
      const result = {
        height: height(),
        body:
          (document.querySelector(".body-editor")?.getBoundingClientRect().top ?? Number.NaN) +
          window.scrollY,
        withoutPill: Number.NaN,
      };
      if (visibility !== null) {
        visibility.style.display = "none";
        result.withoutPill = height();
        visibility.style.display = "";
      }
      return result;
    });
    expect(loaded.withoutPill, "印が無ければ 1 行に収まる title").toBeLessThan(loaded.height);
    expect(loaded.height).toBeCloseTo(skeleton.height, 0);
    expect(loaded.body).toBeCloseTo(skeleton.body, 0);
  }

  test("読み込みの間も印の幅を空けておき、読み込んだ後に title が折り返し直さない（幅 1280）", async ({
    page,
    api,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const title = `上端 chromium-desktop-${Math.random().toString(36).slice(2, 8)}の長い題`;
    // public を直接開くと HTML に入ったページで出て by-title を引かず、取得中のスケルトンが出ないので draft にする
    await api.createPage({ title, body: "上端をそろえる本文", visibility: "draft" });
    await expectNoShiftWhileLoading(page, title, async () => {
      await page.goto(titlePath(title));
    });
  });

  test("一覧から移って開く public のページも、読み込みの間に印の幅を空けておく（幅 1280）", async ({
    page,
    api,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const title = `上端 chromium-desktop-${Math.random().toString(36).slice(2, 8)}の長い題`;
    await api.createPage({ title, body: "上端をそろえる本文", visibility: "public" });
    await expectNoShiftWhileLoading(page, title, async () => {
      await page.goto("/");
      await page.locator(".entries .entry-title", { hasText: title }).click();
    });
  });

  for (const width of [320, 375, 1280]) {
    test(`長い title は印の左で折り返し、印は 1 行目の右端に残る（幅 ${width}）`, async ({
      page,
      api,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      const title = uniqueTitle(testInfo, "折り返す長い題".repeat(4));
      const created = await api.createPage({ title, body: "本文" });
      await page.goto(`/p/${created.id}`);
      await expect(page.locator(".title-input")).toHaveText(title);

      const boxes = await page.evaluate(() => {
        const rect = (selector: string) => {
          const found = document.querySelector(selector)?.getBoundingClientRect();
          if (found === undefined) throw new Error(`${selector} が無い`);
          return { top: found.top, bottom: found.bottom, right: found.right, height: found.height };
        };
        const pill = document.querySelector(".visibility-pill");
        if (pill === null) throw new Error("印が無い");
        // 見た目の枠は ::before に描き、タッチ端末では箱だけが上下に広がる
        const style = getComputedStyle(pill, "::before");
        const box = pill.getBoundingClientRect();
        return {
          title: rect(".title-input .cm-content"),
          // .cm-line は折り返した全体の箱なので、1 行の高さは line-height で取る
          lineHeight: Number.parseFloat(
            getComputedStyle(document.querySelector(".title-input .cm-line") as Element).lineHeight,
          ),
          face: {
            top: box.top + Number.parseFloat(style.top),
            bottom: box.bottom - Number.parseFloat(style.bottom),
            left: box.left,
            right: box.right,
          },
          save: rect(".save-state"),
          note: rect(".note"),
        };
      });
      // 折り返していて、title の文字は印に重ならない
      expect(boxes.title.height).toBeGreaterThan(boxes.lineHeight * 1.5);
      expect(boxes.title.right).toBeLessThanOrEqual(boxes.face.left);
      // 印の見た目は 1 行目の縦の中に収まり、本文の列の右端にそろう
      expect(boxes.face.top).toBeGreaterThanOrEqual(boxes.title.top);
      expect(boxes.face.bottom).toBeLessThanOrEqual(boxes.title.top + boxes.lineHeight);
      expect(boxes.face.right).toBeCloseTo(boxes.note.right, 0);
      // 右上の保存の状態とは重ならない
      expect(boxes.save.bottom).toBeLessThanOrEqual(boxes.face.top);
      await expectNoHorizontalScroll(page);
    });
  }

  test("開いたメニューは画面の中に収まり、本文の前に出る（幅 320）", async ({
    page,
    api,
  }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 640 });
    const title = uniqueTitle(testInfo, "メニューの幅");
    const created = await api.createPage({ title, body: "メニューの下の本文" });
    await page.goto(`/p/${created.id}`);
    await pill(page).click();
    await expect(menu(page)).toBeVisible();
    const box = await menu(page).boundingBox();
    expect(box).not.toBeNull();
    const { x, y, width, height } = box as NonNullable<typeof box>;
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x + width).toBeLessThanOrEqual(320);
    // 本文の行やカーソルの層がメニューの上に描かれない
    const onTop = await page.evaluate(
      ({ cx, cy }) => document.elementFromPoint(cx, cy)?.closest("[role='menu']") != null,
      { cx: x + width / 2, cy: y + height - 4 },
    );
    expect(onTop).toBe(true);
    await expectNoHorizontalScroll(page);
  });
});
