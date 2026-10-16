import type { Locator, Page, Route } from "@playwright/test";
import {
  bodyEditor,
  expect,
  expectNoHorizontalScroll,
  saveState,
  test,
  uniqueTitle,
} from "./support/fixtures";
import { SEED } from "./support/seed";

/*
 * 新規作成の画面（`/?new`）: title を決めた時点で作り、作る前後で編集の画面を作り直さない。
 * 作成の失敗（title の重複、401、オフライン）では、打った内容が残り、直し方が出て、直せば作れる。
 * 401 は作成の POST だけを page.route で差し替える。重複は seed の title で実際に起こす。
 */

const CREATE = "**/api/pages";
const isCreate = (route: Route) => route.request().method() === "POST";
const titleEditor = (page: Page) => page.locator(".title-input .cm-content");

async function openFromPlus(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".entries .entry").first()).toBeVisible();
  await page.getByRole("button", { name: "新規作成" }).click();
  await expect(page).toHaveURL(/\/\?new$/);
  await expect(titleEditor(page)).toBeFocused();
}

/** title 欄で打って Enter し、続けて本文を打つ。 */
async function typeTitleThenBody(page: Page, title: string, body: string): Promise<void> {
  await page.keyboard.type(title);
  await page.keyboard.press("Enter");
  await page.keyboard.type(body);
}

async function expectCreatedAndKept(page: Page, title: string, body: string): Promise<void> {
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  await expect(bodyEditor(page)).toHaveText(body);
  await expect(saveState(page)).toHaveText("保存済み");
  await page.reload();
  await expect(page.locator(".title-input")).toHaveText(title);
  await expect(bodyEditor(page)).toHaveText(body);
}

test("作る POST が遅くても、待つ間に打った本文は残り、本文のエディタは同じ要素のまま", async ({
  page,
}, testInfo) => {
  await page.route(CREATE, async (route) => {
    if (!isCreate(route)) return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return route.fallback();
  });
  const title = uniqueTitle(testInfo, "遅い作成");
  const body = "作成を待つ間に打った本文";
  await openFromPlus(page);
  await bodyEditor(page).evaluate((element) => element.setAttribute("data-e2e-mark", "before"));
  await typeTitleThenBody(page, title, body);
  await expect(saveState(page)).toHaveText("作成中…");
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  await expect(bodyEditor(page)).toHaveAttribute("data-e2e-mark", "before");
  await expect(bodyEditor(page)).toHaveText(body);
  await expectCreatedAndKept(page, title, body);
});

test("title の URL にできないリンクの「作成して開く」から、すぐ打った最初の文字から残る", async ({
  page,
  api,
}, testInfo) => {
  // title の URL にできる title は空のページへ移るので、予約語で始まる title で通知を出す
  const missing = `p/${uniqueTitle(testInfo, "リンク先")}`;
  const source = await api.createPage({
    title: uniqueTitle(testInfo, "リンク元"),
    body: `[[${missing}]]`,
  });
  await page.goto(`/p/${source.id}`);
  await expect(saveState(page)).toHaveText("保存済み");
  await bodyEditor(page).locator(".cm-wikilink", { hasText: missing }).click();
  const notice = page
    .getByRole("alert")
    .filter({ hasText: `「${missing}」のページはまだありません` });
  await notice.getByRole("button", { name: "作成して開く" }).click();
  const body = "リンクから作ったページの本文";
  await page.keyboard.type(body);
  await expectCreatedAndKept(page, missing, body);
});

test("存在しない title の画面の「このタイトルで作成」から、すぐ打った最初の文字から残る", async ({
  page,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "まだ無い");
  await page.goto(`/${encodeURIComponent(title)}`);
  await page.getByRole("button", { name: "このタイトルで作成" }).click();
  const body = "まだ無いページの画面から作った本文";
  await page.keyboard.type(body);
  await expectCreatedAndKept(page, title, body);
});

test("title が空のままでは Enter でも作らず、本文を打っても /?new に留まる", async ({ page }) => {
  let creates = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/pages") creates++;
  });
  await openFromPlus(page);
  // 空の title の Enter は打ち終えたとみなさず、欄にとどまる
  await page.keyboard.press("Enter");
  await expect(titleEditor(page)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(bodyEditor(page)).toBeFocused();
  await page.keyboard.type("title の無い本文");
  // 自動保存は入力が止まって 2 秒後に走る。それを過ぎても作らないことを見る
  await page.waitForTimeout(3_000);
  expect(creates).toBe(0);
  await expect(page).toHaveURL(/\/\?new$/);
  await expect(saveState(page)).toHaveText("タイトルを入れて欄を離れると作成します");
  await expect(bodyEditor(page)).toHaveText("title の無い本文");
});

test("内容のある /?new の + は title 欄へ移るだけで、離れた後の + は復元を尋ねる", async ({
  page,
}) => {
  await openFromPlus(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("打ちかけの本文");
  await page.getByRole("button", { name: "新規作成" }).click();
  await expect(titleEditor(page)).toBeFocused();
  await expect(page).toHaveURL(/\/\?new$/);
  await expect(bodyEditor(page)).toHaveText("打ちかけの本文");

  await page.getByRole("link", { name: "personal-wiki" }).click();
  await expect(page.locator(".entries .entry").first()).toBeVisible();
  await page.getByRole("button", { name: "新規作成" }).click();
  await expect(page.getByText("この端末に残っています", { exact: false })).toBeVisible();
});

test("title が重複して作れないと、打った内容を残して直し方を出し、title を直すと作れる", async ({
  page,
}, testInfo) => {
  const body = "重複した title で打った本文";
  await openFromPlus(page);
  await typeTitleThenBody(page, SEED.server, body);
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "同じタイトルのページがあるため、作成できません" });
  await expect(alert).toContainText("タイトルを変えて欄を離れると、作成します。");
  await expect(alert.getByRole("link", { name: "そのページを開く" })).toBeVisible();
  await expect(alert.getByRole("button", { name: "もう一度作成する" })).toHaveCount(0);
  await expect(saveState(page)).toHaveText("作成に失敗");
  await expect(page).toHaveURL(/\/\?new$/);
  await expect(bodyEditor(page)).toHaveText(body);

  const suffix = ` ${uniqueTitle(testInfo, "直した")}`;
  await titleEditor(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(suffix);
  await page.keyboard.press("Enter");
  await expect(alert).toBeHidden();
  await expectCreatedAndKept(page, `${SEED.server}${suffix}`, body);
});

test("作成が 401 になるとログインし直す案内が出て、打った内容が残り、再試行で作れる", async ({
  page,
}, testInfo) => {
  await page.route(CREATE, (route) =>
    isCreate(route)
      ? route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "unauthorized" }),
        })
      : route.fallback(),
  );
  const title = uniqueTitle(testInfo, "作成で 401");
  const body = "ログインが切れても残る本文";
  await openFromPlus(page);
  await typeTitleThenBody(page, title, body);
  const alert = page.getByRole("alert").filter({ hasText: "ログインの期限が切れました" });
  await expect(alert).toContainText("未保存の内容はこの端末に退避してあります。");
  await expect(saveState(page)).toHaveText("ログインの期限切れ");
  await expect(bodyEditor(page)).toHaveText(body);

  await page.unroute(CREATE);
  await alert.getByRole("button", { name: "ログインし直したので再試行" }).click();
  await expect(alert).toBeHidden();
  await expectCreatedAndKept(page, title, body);
});

test("オフラインで作れないと失敗の案内が出て、打った内容が残り、戻ってからもう一度作れる", async ({
  page,
  context,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "作成でオフライン");
  const body = "オフラインでも残る本文";
  await openFromPlus(page);
  await context.setOffline(true);
  await typeTitleThenBody(page, title, body);
  const alert = page.getByRole("alert").filter({ hasText: "作成できませんでした" });
  await expect(alert).toContainText("サーバーに接続できません");
  await expect(saveState(page)).toHaveText("作成に失敗");
  await expect(bodyEditor(page)).toHaveText(body);

  await context.setOffline(false);
  await alert.getByRole("button", { name: "もう一度作成する" }).click();
  await expect(alert).toBeHidden();
  await expectCreatedAndKept(page, title, body);
});

test("/?new に横スクロールが出ない", async ({ page }) => {
  await page.goto("/?new");
  await expect(titleEditor(page)).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("新規ページの 1 行目で [[ を打つと、補完の窓がヘッダーの下に見える", async ({
  page,
}, testInfo) => {
  await openFromPlus(page);
  await typeTitleThenBody(page, uniqueTitle(testInfo, "補完"), `[[${SEED.welcome.slice(0, 2)}`);
  const popup = page.locator(".cm-tooltip-autocomplete");
  await expect(popup).toBeVisible();
  await expect(popup.getByText(SEED.welcome).first()).toBeVisible();
  const header = await page.locator("header.header").boundingBox();
  const box = await popup.boundingBox();
  const viewport = page.viewportSize();
  expect(header).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box?.y ?? 0).toBeGreaterThanOrEqual((header?.y ?? 0) + (header?.height ?? 0));
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport?.height ?? 0);
});

test("title の一覧を取れなかったときの [[ の補完は失敗を案内し、取れるようになった後の入力で候補が出る", async ({
  page,
}, testInfo) => {
  const titles = "**/api/pages/titles*";
  // 取り直しの間隔を実時間で待たずに進める
  await page.clock.install();
  await page.route(titles, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "internal" }),
    }),
  );
  await openFromPlus(page);
  await typeTitleThenBody(
    page,
    uniqueTitle(testInfo, "補完の失敗"),
    `[[${SEED.welcome.slice(0, 2)}`,
  );
  const popup = page.locator(".cm-tooltip-autocomplete");
  // 失敗なのか一致なしなのか区別できるよう、案内の行を出す。「まだ無いページ」への行は出さない
  const notice = popup.getByText("候補を取得できません");
  await expect(notice).toBeVisible();
  await expect(popup.getByText(/へリンク（まだ無いページ）$/)).toHaveCount(0);
  // 待つか打ち直すかを案内し、窓の幅（iOS 幅を含む）に収まって 2 行までで読める。選べる候補としては伝えない
  await expect(notice).toContainText("打ち直してください");
  const row = popup.locator("li");
  await expect(row).not.toHaveAttribute("aria-selected", /.*/);
  const fit = await row.evaluate((element) => {
    const style = getComputedStyle(element);
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    return {
      overflowX: element.scrollWidth - element.clientWidth,
      lines:
        (element.getBoundingClientRect().height - padding) / Number.parseFloat(style.lineHeight),
    };
  });
  expect(fit.overflowX).toBeLessThanOrEqual(0);
  expect(fit.lines).toBeLessThanOrEqual(2);

  // 取り直しは失敗の直後を避けて間隔を空けるので、API が戻った後、間隔が過ぎてから打つ
  await page.unroute(titles);
  await page.clock.fastForward(5_100);
  await page.keyboard.type(SEED.welcome.slice(2, 3));
  await expect(popup.getByText(SEED.welcome).first()).toBeVisible();
  await expect(popup.getByText("候補を取得できません")).toHaveCount(0);
});

test("補完の窓は画面の右端に接せず、指で押す端末では縁と行の余白を広げる", async ({
  page,
  isMobile,
}, testInfo) => {
  await openFromPlus(page);
  // caret を行の中ほどまで進め、窓が画面の右端へ寄せられる位置で開く（幅の狭い端末の場合）
  await typeTitleThenBody(
    page,
    uniqueTitle(testInfo, "補完の余白"),
    `あいうえおかきくけこ[[${SEED.welcome.slice(0, 2)}`,
  );
  const frame = page.locator(".cm-tooltip-autocomplete > ul");
  await expect(frame.getByText(SEED.welcome).first()).toBeVisible();
  const box = await frame.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  const right = (box?.x ?? 0) + (box?.width ?? 0);
  expect(right).toBeLessThanOrEqual((viewport?.width ?? 0) - 12);
  const columnRight = await bodyEditor(page).evaluate(
    (element) => element.getBoundingClientRect().right,
  );
  expect(right).toBeLessThanOrEqual(columnRight + 0.5);
  expect(box?.x ?? 0).toBeGreaterThanOrEqual(12);
  if (!isMobile) return;
  // 幅の狭い端末では右端へ寄せられたことを確かめる（でないと余白の検査が空振りする）
  expect(right).toBeGreaterThanOrEqual((viewport?.width ?? 0) - 24);
  const padding = await frame.evaluate((list) => {
    const option = list.querySelector("li");
    return {
      list: Number.parseFloat(getComputedStyle(list).paddingLeft),
      option: option ? Number.parseFloat(getComputedStyle(option).paddingLeft) : 0,
    };
  });
  expect(padding.list).toBeGreaterThanOrEqual(8);
  expect(padding.option).toBeGreaterThanOrEqual(12);
});

test.describe("補完の窓の右端 @widths", () => {
  // 768 では列が右の欄に押されて最大幅より狭く、1280 では列と右の欄が中央に寄る
  for (const width of [768, 1280]) {
    test(`列の右端の近くで開く窓は、列の右端を越えない（幅 ${width}）`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      await openFromPlus(page);
      await page.keyboard.type(uniqueTitle(testInfo, "補完の右端"));
      await page.keyboard.press("Enter");
      const caretRight = () =>
        page.evaluate(
          () => window.getSelection()?.getRangeAt(0).getBoundingClientRect().right ?? 0,
        );
      const columnRightNow = () =>
        bodyEditor(page).evaluate((element) => element.getBoundingClientRect().right);
      // 最初の字で列の配置が定まってから測る
      await page.keyboard.type("あ");
      const columnRight = await columnRightNow();
      // 窓の幅より内側で、`[[` と 2 字がまだ折り返さない位置まで進める
      for (let typed = 0; typed < 200 && (await caretRight()) < columnRight - 100; typed++) {
        await page.keyboard.type("あ");
      }
      expect(await caretRight()).toBeGreaterThan(columnRight - 130);
      await page.keyboard.type(`[[${SEED.welcome.slice(0, 2)}`);

      const popup = page.locator(".cm-tooltip-autocomplete");
      const frame = popup.locator("> ul");
      await expect(frame.getByText(SEED.welcome).first()).toBeVisible();
      const rightOf = async (target: Locator) => {
        const box = await target.boundingBox();
        return (box?.x ?? 0) + (box?.width ?? 0);
      };
      // 窓は置かれる前に左上に出るので、列の右端の近くまで寄せられるのを待ってから測る。
      // 寄せられなければ、窓が列に収まる位置で開いていて、検査が空振りする
      await expect.poll(() => rightOf(frame)).toBeGreaterThanOrEqual(columnRight - 8);
      const edgeGap = await popup.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).paddingRight),
      );
      const columnRightAtOpen = await columnRightNow();
      expect(await rightOf(frame)).toBeLessThanOrEqual(columnRightAtOpen + 0.5);
      expect(await rightOf(popup)).toBeLessThanOrEqual(columnRightAtOpen + edgeGap + 0.5);
    });
  }
});

test.describe("匿名", () => {
  test.use({ role: "anonymous" });

  test("/?new を開くと、作成の画面を出さずにログインを案内する", async ({ page }) => {
    await page.goto("/?new");
    await expect(page.getByRole("heading", { name: "ログインが必要です" })).toBeVisible();
    await expect(page.locator(".cm-editor")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "新規作成" })).toHaveCount(0);
  });
});
