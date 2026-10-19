import type { Page } from "@playwright/test";
import {
  bodyEditor,
  expect,
  saveState,
  test,
  typeAtBodyEnd,
  uniqueTitle,
} from "./support/fixtures";
import {
  connectOAuthClient,
  issueApiToken,
  updatePageWithOAuth,
  updatePageWithToken,
} from "./support/principals";
import { E2E_ORIGIN } from "./support/stack";

/*
 * 右の列の履歴。owner の保存は 10 分ごとに 1 つの版にまとまり、公開範囲の切り替えがまとまりを区切る。
 * 版を開くダイアログは読み取り専用で、画面の本文の編集に影響しない。
 */

const history = (page: Page) => page.locator(".rail-section-history");
const entries = (page: Page) => history(page).locator(".revision-entry");
const viewer = (page: Page) => page.getByRole("dialog");

/** 版のダイアログは差分から始まる。全文は読み取り専用のエディタで、切り替えて見る */
async function showFull(page: Page) {
  await viewer(page).getByRole("button", { name: "全文" }).click();
}

/** 閉じた後も close の event が届くまでは、ダイアログの本文が画面の本文と同じ名前で DOM に残る */
async function closeViewer(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator(".revision-viewer .cm-content")).toHaveCount(0);
}

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
  await expect(entries(page).first()).toContainText("1分未満");
  await expect(entries(page).first()).toContainText("Web");
  // 版の番号は飛ぶので見せない
  await expect(history(page)).not.toContainText("版");

  // 絶対の時刻は本文に無いので、範囲選択（コピー）の文字列にも innerText（ページ内検索の対象）にも出ない。
  // 読み上げ（アクセシビリティツリー）には、相対の表記に続けて届く
  const copied = await history(page).evaluate((section) => {
    getSelection()?.selectAllChildren(section);
    return {
      selection: getSelection()?.toString() ?? "",
      text: (section as HTMLElement).innerText,
    };
  });
  expect(copied.selection).not.toMatch(/\d{4}\/\d{2}\/\d{2}/);
  expect(copied.text).not.toMatch(/\d{4}\/\d{2}\/\d{2}/);
  const time = entries(page).first().locator(".revision-time");
  const absolute = (await time.getAttribute("title")) ?? "";
  expect(absolute).toMatch(/\d{4}\/\d{2}\/\d{2}/);
  expect(await time.ariaSnapshot()).toBe(`- time: 1分未満 （${absolute}）`);

  // キーボードで開くと、閉じた後に焦点が押した行へ戻る
  await entries(page).nth(1).focus();
  await page.keyboard.press("Enter");
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page).getByRole("heading", { name: title })).toBeVisible();
  await expect(viewer(page)).toContainText("読み取り専用");
  await showFull(page);
  const oldBody = viewer(page).locator(".cm-content");
  await expect(oldBody).toHaveText("最初の本文");
  await oldBody.click();
  await page.keyboard.type("書き換え");
  await expect(oldBody).toHaveText("最初の本文");

  await closeViewer(page);
  await expect(viewer(page)).toHaveCount(0);
  await expect(entries(page).nth(1)).toBeFocused();
  await expect(bodyEditor(page)).toHaveText("二つ目の本文");
});

test("token と OAuth の接続が保存した版は、作成者を種類つきの名前で並べる", async ({
  page,
  api,
}, testInfo) => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const tokenName = `e2e-token-${suffix}`;
  const clientName = `e2e-client-${suffix}`;
  // owner の保存は直前の owner の版にまとまるが、AI の書き込みは毎回 1 件の版になる
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "作成者"),
    body: "owner の本文",
    visibility: "public",
  });
  const token = await issueApiToken(tokenName, "read,write");
  await updatePageWithToken(token, created, "token の本文");
  const afterToken = await api.getPage(created.id);
  await updatePageWithOAuth(await connectOAuthClient(clientName), afterToken, "OAuth の接続の本文");

  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page)).toContainText("OAuth の接続の本文");
  await expect(entries(page)).toHaveCount(3);
  await expect(entries(page).nth(0)).toContainText(clientName);
  await expect(entries(page).nth(1)).toContainText(tokenName);
  await expect(entries(page).nth(2)).toContainText("Web");

  await entries(page).nth(1).click();
  await expect(viewer(page)).toContainText(tokenName);
  await showFull(page);
  await expect(viewer(page).locator(".cm-content")).toHaveText("token の本文");
  await closeViewer(page);
  await entries(page).nth(0).click();
  await expect(viewer(page)).toContainText(clientName);
  await showFull(page);
  await expect(viewer(page).locator(".cm-content")).toHaveText("OAuth の接続の本文");
});

test("名前の長い接続の版があっても、行は 1 行のままで作成者の左端がそろい、名前は title に残す", async ({
  page,
  api,
}, testInfo) => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const clientName = `Claude Code (personal-wiki) ${suffix} with a long name`;
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "長い名前"),
    body: "owner の本文",
    visibility: "public",
  });
  await updatePageWithOAuth(await connectOAuthClient(clientName), created, "接続の本文");

  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page)).toContainText("接続の本文");
  await expect(entries(page)).toHaveCount(2);

  const boxes = await entries(page).evaluateAll((rows) =>
    rows.map((row) => ({
      height: Math.round(row.getBoundingClientRect().height),
      authorLeft: Math.round(
        row.querySelector(".revision-author")?.getBoundingClientRect().left ?? Number.NaN,
      ),
    })),
  );
  expect(new Set(boxes.map((b) => b.height)).size).toBe(1);
  expect(new Set(boxes.map((b) => b.authorLeft)).size).toBe(1);
  await expect(entries(page).nth(0).locator(".revision-author")).toHaveAttribute(
    "title",
    clientName,
  );
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
  // 右の列が本文の下に回る狭い画面では、列が見えるまで取り直さない
  await history(page).scrollIntoViewIfNeeded();
  // まとめた版は番号が進むので、取り直した一覧の先頭は今の版の番号になる
  const json = (await (await refetched).json()) as { revisions: { version: number }[] };
  expect(json.revisions.map((r) => r.version)).toEqual([2]);
  await expect(entries(page)).toHaveCount(1);

  await entries(page).first().click();
  await showFull(page);
  await expect(viewer(page).locator(".cm-content")).toHaveText("本文を足す");
});

test("古い版に戻すと本文だけが戻り、title は今のまま、履歴の先頭に版が増える", async ({
  page,
  api,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "戻す");
  const created = await api.createPage({ title, body: "最初の本文", visibility: "public" });
  const renamed = `${title} 改`;
  await api.updatePage(created, { title: renamed, body: "二つ目の本文" });

  await page.goto(`/p/${created.id}`);
  await expect(entries(page)).toHaveCount(2);
  // 先頭の版は今の本文そのものなので、戻す操作を出さない
  await entries(page).first().click();
  await showFull(page);
  await expect(viewer(page).locator(".cm-content")).toHaveText("二つ目の本文");
  await expect(viewer(page).getByRole("button", { name: "この版の本文に戻す" })).toHaveCount(0);
  await closeViewer(page);

  await entries(page).nth(1).click();
  await showFull(page);
  await expect(viewer(page).locator(".cm-content")).toHaveText("最初の本文");
  await viewer(page).getByRole("button", { name: "この版の本文に戻す" }).click();
  await expect(viewer(page).locator(".revision-viewer-status")).toHaveText(
    "この版の本文に戻しました。戻す前の本文は履歴に残っているので、そこから戻し直せます。",
  );
  await expect(viewer(page).getByRole("button", { name: "この版の本文に戻す" })).toHaveCount(0);
  await closeViewer(page);

  await expect(bodyEditor(page)).toHaveText("最初の本文");
  await expect(page.locator(".title-input")).toHaveText(renamed);
  await expect(saveState(page)).toHaveText("保存済み");
  await expect(entries(page)).toHaveCount(3);
  const stored = await api.getPage(created.id);
  expect({ title: stored.title, body: stored.body }).toEqual({
    title: renamed,
    body: "最初の本文",
  });
});

test("未保存の入力は先に保存してから戻し、戻す前の内容として履歴に残す", async ({
  page,
  api,
}, testInfo) => {
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "戻す前の入力"),
    body: "最初の本文",
    visibility: "public",
  });
  await api.updatePage(created, { body: "二つ目の本文" });

  await page.goto(`/p/${created.id}`);
  await expect(entries(page)).toHaveCount(2);
  // 保存のリクエストを止め、戻す操作を押す時点で入力が保存されていない状態にする
  let releaseSave: () => void = () => {};
  const saveHeld = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route(`**/api/pages/${created.id}`, async (route) => {
    if (route.request().method() === "PUT") await saveHeld;
    await route.continue();
  });
  await typeAtBodyEnd(page, "を足した");
  await entries(page).nth(1).click();
  await showFull(page);
  await expect(viewer(page).locator(".cm-content")).toHaveText("最初の本文");
  await viewer(page).getByRole("button", { name: "この版の本文に戻す" }).click();
  await expect(viewer(page).getByRole("button", { name: "戻し中…" })).toBeDisabled();
  releaseSave();
  await expect(viewer(page).locator(".revision-viewer-status")).toHaveText(
    /この版の本文に戻しました/,
  );
  await closeViewer(page);
  await page.unroute(`**/api/pages/${created.id}`);

  await expect(bodyEditor(page)).toHaveText("最初の本文");
  await expect(saveState(page)).toHaveText("保存済み");
  // owner の保存は直前の owner の版にまとまり、戻した版はまとめずに先頭に積む
  await expect(entries(page)).toHaveCount(3);
  await entries(page).nth(1).click();
  await showFull(page);
  await expect(viewer(page).locator(".cm-content")).toHaveText("二つ目の本文を足した");
});

test("版を開くと 1 つ古い版との差分を出し、title の変化も添え、全文と切り替えられる", async ({
  page,
  api,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "差分");
  const created = await api.createPage({
    title,
    body: "共通の行\n消える行\n末尾",
    visibility: "public",
  });
  const renamed = `${title} 改`;
  await api.updatePage(created, { title: renamed, body: "共通の行\n加わる行\n末尾" });

  await page.goto(`/p/${created.id}`);
  await expect(entries(page)).toHaveCount(2);

  await entries(page).first().click();
  const rows = viewer(page).locator(".diff-row .diff-text");
  await expect(rows).toHaveText(["共通の行", "消える行", "加わる行", "末尾"]);
  await expect(viewer(page).locator(".diff-delete .diff-text")).toHaveText("消える行");
  await expect(viewer(page).locator(".diff-insert .diff-text")).toHaveText("加わる行");
  await expect(viewer(page).locator(".revision-diff-titles")).toContainText(title);
  await expect(viewer(page).locator(".revision-diff-titles")).toContainText(renamed);
  await expect(viewer(page).locator(".cm-content")).toHaveCount(0);

  await showFull(page);
  await expect(viewer(page).locator(".cm-content")).toHaveText("共通の行加わる行末尾");
  await expect(viewer(page).locator(".revision-diff")).toBeHidden();
  await viewer(page).getByRole("button", { name: "差分" }).click();
  await expect(rows).toHaveCount(4);
  await closeViewer(page);

  // 最初の版は前が無いので、本文の全行を加わった行として出す
  await entries(page).nth(1).click();
  await expect(viewer(page)).toContainText("最初の版です");
  await expect(viewer(page).locator(".diff-insert .diff-text")).toHaveText([
    "共通の行",
    "消える行",
    "末尾",
  ]);
  await expect(viewer(page).locator(".diff-delete")).toHaveCount(0);
});

test("長い行は折り返して全部を読め、ダイアログも画面も横にあふれない", async ({
  page,
  api,
}, testInfo) => {
  const longWord = `https://example.com/${"a".repeat(240)}`;
  const longText = "長い日本語の行が画面の幅を超えても、折り返して最後まで読めること。".repeat(6);
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "長い行の差分"),
    body: `共通\n${longText}\n末尾`,
    visibility: "public",
  });
  await api.updatePage(created, { body: `共通\n${longWord} ${longText}\n末尾` });

  await page.goto(`/p/${created.id}`);
  await expect(entries(page)).toHaveCount(2);
  await entries(page).first().click();
  await expect(viewer(page).locator(".diff-insert .diff-text")).toContainText("長い日本語の行");

  const fit = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>(".revision-viewer");
    const body = document.querySelector<HTMLElement>(".revision-viewer-body");
    if (!dialog || !body) throw new Error("ダイアログが無い");
    const frame = dialog.getBoundingClientRect();
    const rows = [...dialog.querySelectorAll(".diff-row")].map((row) =>
      row.getBoundingClientRect(),
    );
    return {
      pageOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      bodyOverflows: body.scrollWidth > body.clientWidth,
      rowsInside: rows.every((box) => box.left >= frame.left && box.right <= frame.right),
      insertHeight: document.querySelector(".diff-insert")?.getBoundingClientRect().height ?? 0,
      lineHeight: Number.parseFloat(
        getComputedStyle(document.querySelector(".diff-insert") as Element).lineHeight,
      ),
    };
  });
  expect(fit.pageOverflows).toBe(false);
  expect(fit.bodyOverflows).toBe(false);
  expect(fit.rowsInside).toBe(true);
  expect(fit.insertHeight).toBeGreaterThan(fit.lineHeight * 2);
});

test("狭い幅の版のダイアログは、見出しに幅いっぱいを渡し、ボタンを次の 1 行に並べる", async ({
  page,
  api,
}, testInfo) => {
  // iPhone の WebKit は自分の幅で測り、デスクトップは iPhone の幅（375）に縮めて測る
  if (testInfo.project.name === "chromium-desktop") {
    await page.setViewportSize({ width: 375, height: 667 });
  }
  const created = await api.createPage({
    title: uniqueTitle(testInfo, `履歴の見出し ${"長い title ".repeat(6)}`),
    body: "最初の本文",
    visibility: "public",
  });
  await api.updatePage(created, { body: "二つ目の本文" });
  await page.goto(`/p/${created.id}`);
  await expect(entries(page)).toHaveCount(2);

  const measure = () =>
    viewer(page).evaluate((dialog) => {
      const box = (selector: string) => {
        const element = dialog.querySelector(selector);
        if (!element) throw new Error(`${selector} が無い`);
        return element.getBoundingClientRect();
      };
      const header = dialog.querySelector(".revision-viewer-header") as HTMLElement;
      const style = getComputedStyle(header);
      const inner = header.getBoundingClientRect();
      return {
        heading: box(".revision-viewer-heading"),
        actions: box(".revision-viewer-actions"),
        buttons: [...dialog.querySelectorAll(".revision-viewer-actions button")].map((button) =>
          button.getBoundingClientRect(),
        ),
        innerWidth:
          inner.width -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight),
        pageOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
  const expectOneRowBelowHeading = (m: Awaited<ReturnType<typeof measure>>, count: number) => {
    expect(m.buttons).toHaveLength(count);
    // ボタンは同じ行に並び、見出しの下に置く
    const tops = m.buttons.map((button) => Math.round(button.top));
    expect(new Set(tops).size).toBe(1);
    for (const button of m.buttons) expect(button.top).toBeGreaterThanOrEqual(m.heading.bottom);
    // 見出しは、ボタンの欄に押されず、ヘッダーの内側の幅いっぱいを使う
    expect(m.heading.width).toBeCloseTo(m.innerWidth, 0);
    expect(m.pageOverflows).toBe(false);
  };

  // 戻す操作が出ない先頭の版は、閉じるだけの 1 つ
  await entries(page).first().click();
  await expect(viewer(page).locator(".diff-row").first()).toBeVisible();
  expectOneRowBelowHeading(await measure(), 1);
  await closeViewer(page);

  await entries(page).nth(1).click();
  await expect(viewer(page).locator(".diff-row").first()).toBeVisible();
  expectOneRowBelowHeading(await measure(), 2);

  // 戻している間も、ラベルが変わるだけで行は崩れない
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/pages/${created.id}/revisions/*/restore`, async (route) => {
    await gate;
    await route.fallback();
  });
  await viewer(page).getByRole("button", { name: "この版の本文に戻す" }).click();
  await expect(viewer(page).getByRole("button", { name: "戻し中…" })).toBeVisible();
  expectOneRowBelowHeading(await measure(), 2);
  release();
  await expect(viewer(page).locator(".revision-viewer-status")).toContainText(
    "この版の本文に戻しました。",
  );
});

test("広い幅の版のダイアログは、見出しの右にボタンを 1 行で並べる", async ({
  page,
  api,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "デスクトップの幅で測る");
  const created = await api.createPage({
    title: uniqueTitle(testInfo, `履歴の見出し ${"長い title ".repeat(6)}`),
    body: "最初の本文",
    visibility: "public",
  });
  await api.updatePage(created, { body: "二つ目の本文" });
  await page.goto(`/p/${created.id}`);
  await expect(entries(page)).toHaveCount(2);
  await entries(page).nth(1).click();
  await expect(viewer(page).locator(".diff-row").first()).toBeVisible();

  const boxes = await viewer(page).evaluate((dialog) => ({
    headingBottom: dialog.querySelector(".revision-viewer-heading")?.getBoundingClientRect().bottom,
    buttonTops: [...dialog.querySelectorAll(".revision-viewer-actions button")].map((button) =>
      Math.round(button.getBoundingClientRect().top),
    ),
  }));
  expect(boxes.buttonTops).toHaveLength(2);
  expect(new Set(boxes.buttonTops).size).toBe(1);
  expect(boxes.buttonTops[0] ?? Number.NaN).toBeLessThan(boxes.headingBottom ?? 0);
});

test("差分と全文で高さが違っても切り替えの位置は動かず、全文を末尾までスクロールしても押せる", async ({
  page,
  api,
}, testInfo) => {
  const lines = Array.from({ length: 150 }, (_, i) => `行${i}`);
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "切り替えの位置"),
    body: lines.join("\n"),
    visibility: "public",
  });
  await api.updatePage(created, {
    body: lines.map((l, i) => (i === 75 ? "変えた行" : l)).join("\n"),
  });

  await page.goto(`/p/${created.id}`);
  await expect(entries(page)).toHaveCount(2);
  await entries(page).first().click();
  await expect(viewer(page).locator(".diff-insert .diff-text")).toHaveText("変えた行");

  const switchTop = async () =>
    viewer(page)
      .getByRole("button", { name: "全文" })
      .evaluate((button) => button.getBoundingClientRect().top);
  const dialogTop = () => viewer(page).evaluate((d) => d.getBoundingClientRect().top);
  const diffTops = { switch: await switchTop(), dialog: await dialogTop() };

  await showFull(page);
  await expect(viewer(page).locator(".cm-content")).toContainText("行0行1行2");
  expect({ switch: await switchTop(), dialog: await dialogTop() }).toEqual(diffTops);

  await viewer(page)
    .locator(".revision-viewer-body")
    .evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  await expect(viewer(page).getByRole("button", { name: "差分" })).toBeInViewport();
  await expect(viewer(page).getByRole("button", { name: "全文" })).toBeInViewport();

  await viewer(page).getByRole("button", { name: "差分" }).click();
  await expect(viewer(page).locator(".diff-insert .diff-text")).toHaveText("変えた行");
  expect({ switch: await switchTop(), dialog: await dialogTop() }).toEqual(diffTops);
});

test("前の版の取得に失敗したら理由を出し、再試行で差分を出す。全文は読める", async ({
  page,
  api,
}, testInfo) => {
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "差分の失敗"),
    body: "古い本文",
    visibility: "public",
  });
  await api.updatePage(created, { body: "新しい本文" });

  await page.goto(`/p/${created.id}`);
  await expect(entries(page)).toHaveCount(2);
  const previous = `**/api/pages/${created.id}/revisions/1`;
  await page.route(previous, (route) => route.abort());
  await entries(page).first().click();
  await expect(viewer(page)).toContainText("前の版を取得できませんでした。");
  await expect(viewer(page).locator(".diff-row")).toHaveCount(0);
  await showFull(page);
  await expect(viewer(page).locator(".cm-content")).toHaveText("新しい本文");
  await viewer(page).getByRole("button", { name: "差分" }).click();

  await page.unroute(previous);
  await viewer(page).getByRole("button", { name: "再試行" }).click();
  await expect(viewer(page).locator(".diff-delete .diff-text")).toHaveText("古い本文");
  await expect(viewer(page).locator(".diff-insert .diff-text")).toHaveText("新しい本文");
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
