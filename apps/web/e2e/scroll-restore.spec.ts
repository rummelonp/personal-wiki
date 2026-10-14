import type { Page } from "@playwright/test";
import { bodyEditor, expect, test, uniqueTitle } from "./support/fixtures";
import { SEED } from "./support/seed";

/*
 * 一覧（タグで絞った一覧を含む）を途中までスクロールしてページを開き、戻ったとき、スクロール位置が
 * 戻ること。戻るで一覧を取り直す間に画面が縮むと、ブラウザの復元が位置を 0 に丸めてしまう。
 */

const SCROLL = 500;
const TOLERANCE = 40;

const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));

/**
 * 画面内に見えている最初の行のタイトル（selector で変えられる）を、座標のクリックで開く
 * （クリックによるスクロールを避ける）。
 */
async function openVisibleEntry(page: Page, selector = ".entries .entry-title"): Promise<void> {
  const point = await page.evaluate((selector) => {
    const headerBottom =
      document.querySelector("header.header")?.getBoundingClientRect().bottom ?? 0;
    for (const link of document.querySelectorAll(selector)) {
      const rect = link.getBoundingClientRect();
      if (rect.top > headerBottom && rect.bottom < window.innerHeight) {
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    }
    return null;
  }, selector);
  expect(point, "画面内に見えている行がある").not.toBeNull();
  const { x, y } = point as { x: number; y: number };
  await page.mouse.click(x, y);
}

for (const [label, path] of [
  ["最近の更新", "/"],
  ["タグで絞った一覧", `/?tag=${encodeURIComponent("メモ")}`],
] as const) {
  test(`${label}をスクロールしてページを開き、戻ると位置が戻る`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    const scrollable = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(scrollable, "一覧がスクロールできる長さ").toBeGreaterThan(SCROLL);

    await page.evaluate((y) => window.scrollTo(0, y), SCROLL);
    await expect.poll(() => scrollY(page)).toBe(SCROLL);
    const listUrl = page.url();
    await openVisibleEntry(page);
    await expect(page.locator("h1.note-title, .title-input").first()).toBeVisible();
    expect(page.url()).not.toBe(listUrl);

    await page.goBack();
    await expect(page).toHaveURL(listUrl);
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await expect.poll(() => scrollY(page)).toBeGreaterThan(SCROLL - TOLERANCE);
    await expect.poll(() => scrollY(page)).toBeLessThan(SCROLL + TOLERANCE);
  });
}

test("「さらに表示」で読み足した位置まで、戻るで戻る", async ({ page }) => {
  await page.goto(`/?tag=${encodeURIComponent("メモ")}`);
  await expect(page.locator(".entries .entry").first()).toBeVisible();
  await page.getByRole("button", { name: "さらに表示" }).click();
  // 読み込み中もボタンは同じ名前で残る（disabled）ので、ボタンではなく件数で読み足しの完了を待つ
  await expect.poll(() => page.locator(".entries .entry").count()).toBeGreaterThan(20);
  const loaded = await page.locator(".entries .entry").count();

  // ページの末尾まで動かす。狭い画面では末尾がタグの一覧なので、戻った直後にタグが描かれるまで
  // 位置に届かない。そこで押せるのは行でもタグでもよい
  const target = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight - 100,
  );
  expect(target, "最初の 20 件だけでは届かない位置").toBeGreaterThan(SCROLL);
  await page.evaluate((y) => window.scrollTo(0, y), target);
  await expect.poll(() => scrollY(page)).toBe(target);
  const listUrl = page.url();
  await openVisibleEntry(page, ".entries .entry-title, .rail .chip-link:not([aria-current])");
  await expect(page).not.toHaveURL(listUrl);

  await page.goBack();
  await expect(page).toHaveURL(listUrl);
  await expect(page.locator(".entries .entry")).toHaveCount(loaded);
  await expect.poll(() => scrollY(page)).toBeGreaterThan(target - TOLERANCE);
  await expect.poll(() => scrollY(page)).toBeLessThan(target + TOLERANCE);
});

test("戻る・進む・戻るの連鎖と再読み込みのあとも、位置が戻る", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".entries .entry").first()).toBeVisible();
  await page.evaluate((y) => window.scrollTo(0, y), SCROLL);
  await expect.poll(() => scrollY(page)).toBe(SCROLL);
  const listUrl = page.url();
  await openVisibleEntry(page);
  await expect(page.locator("h1.note-title, .title-input").first()).toBeVisible();

  for (const _round of [1, 2]) {
    await page.goBack();
    await expect(page).toHaveURL(listUrl);
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await expect.poll(() => scrollY(page)).toBeGreaterThan(SCROLL - TOLERANCE);
    await page.goForward();
    await expect(page.locator("h1.note-title, .title-input").first()).toBeVisible();
  }

  await page.goBack();
  await expect(page.locator(".entries .entry").first()).toBeVisible();
  await expect.poll(() => scrollY(page)).toBeGreaterThan(SCROLL - TOLERANCE);
  await page.reload();
  await expect(page.locator(".entries .entry").first()).toBeVisible();
  await expect.poll(() => scrollY(page)).toBeGreaterThan(SCROLL - TOLERANCE);
  await expect.poll(() => scrollY(page)).toBeLessThan(SCROLL + TOLERANCE);
});

test("再読み込みの起動中に帯が出ても、位置が戻る", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".entries .entry").first()).toBeVisible();
  await page.evaluate((y) => window.scrollTo(0, y), SCROLL);
  await expect.poll(() => scrollY(page)).toBe(SCROLL);
  // 位置はスクロールが止まってから履歴に書く。書く前の再読み込みは、このテストの対象ではない
  await expect
    .poll(() =>
      page.evaluate(() => (history.state as { scroll?: { y: number } } | null)?.scroll?.y),
    )
    .toBe(SCROLL);

  // ログイン状態の確認を止め、一覧より先に起動中の帯を描かせる
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/me", async (route) => {
    await gate;
    await route.continue().catch(() => {});
  });
  await page.reload();
  await expect(page.locator(".skeleton-painted").first()).toBeVisible();
  // 負荷が高いとブラウザの復元が帯の間に走り、帯の高さに丸める。その時点を待たずに、同じ丸めを起こす。
  // 帯がスクロールできない幅（広い画面）では丸めが起きないので、検査にならない
  await page.evaluate((y) => window.scrollTo(0, y), SCROLL);
  const clamped = await scrollY(page);
  test.skip(clamped === 0, "この幅では起動中の帯がスクロールできない");
  expect(clamped).toBeLessThan(SCROLL - TOLERANCE);
  release();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await expect(page.locator(".entries .entry").first()).toBeVisible();
  await expect.poll(() => scrollY(page)).toBeGreaterThan(SCROLL - TOLERANCE);
  await expect.poll(() => scrollY(page)).toBeLessThan(SCROLL + TOLERANCE);
});

test("一覧からタグで別の一覧へ移って戻ると、元の一覧の位置が戻る", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".entries .entry").first()).toBeVisible();
  await page.evaluate((y) => window.scrollTo(0, y), SCROLL);
  await expect.poll(() => scrollY(page)).toBe(SCROLL);

  // 狭い画面ではタグが一覧の下に在るので、押す位置まで動かしたあとの位置を戻り先として測る
  const chip = page.locator(".rail .chip-link:not([aria-current])").first();
  await chip.scrollIntoViewIfNeeded();
  const before = await scrollY(page);
  await chip.click();
  await expect(page).toHaveURL(/\?tag=/);
  await expect(page.locator(".entries .entry").first()).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".entries .entry").first()).toBeVisible();
  await expect.poll(() => scrollY(page)).toBeGreaterThan(before - TOLERANCE);
  await expect.poll(() => scrollY(page)).toBeLessThan(before + TOLERANCE);
});

test("owner の編集画面で本文の #tag を押すと、タグの一覧へ移り、戻ると元のページに戻る", async ({
  page,
  seedIds,
}) => {
  await page.goto(`/p/${seedIds[SEED.welcome]}`);
  const tag = bodyEditor(page).locator(".cm-tag", { hasText: "#メモ" });
  await expect(tag).toBeVisible();
  const pageUrl = page.url();
  await tag.click();
  await expect(page).toHaveURL(`/?tag=${encodeURIComponent("メモ")}`);
  await expect(page.locator(".entries .entry").first()).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(pageUrl);
  await expect(bodyEditor(page)).toBeVisible();
});

test("長いページから wikilink で別のページへ移って戻ると、元のページの位置が戻る", async ({
  page,
  seedIds,
}) => {
  await page.goto(`/p/${seedIds[SEED.longPage]}`);
  await expect(bodyEditor(page).getByText("見出し 1", { exact: true })).toBeVisible();
  await page.evaluate((y) => window.scrollTo(0, y), 3000);
  await expect.poll(() => scrollY(page)).toBe(3000);

  // CodeMirror は画面の近くの行だけを描き、動かすたびに描く行が変わる。Playwright が押す前にもう一度
  // 動かすことがあるので、戻り先は押した瞬間の位置を測る
  const clickedAt = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        document.addEventListener("mousedown", () => resolve(Math.round(window.scrollY)), {
          capture: true,
          once: true,
        });
      }),
  );
  const pageUrl = page.url();
  await page.locator(".cm-wikilink").first().click();
  const before = await clickedAt;
  expect(before, "ページの途中").toBeGreaterThan(1000);
  await expect(page).not.toHaveURL(pageUrl);
  await expect(page.locator("h1.note-title, .title-input").first()).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(pageUrl);
  await expect(bodyEditor(page)).toBeVisible();
  await expect.poll(() => scrollY(page)).toBeGreaterThan(before - TOLERANCE);
  await expect.poll(() => scrollY(page)).toBeLessThan(before + TOLERANCE);
});

test("空のページのリンク元からページを開いて戻ると、リンク元が届いてから位置が戻る", async ({
  page,
  api,
}, testInfo) => {
  // リンク元は狭い画面で本文の下に並ぶ。最初の 1 回で取れる 20 件で、スクロールできる高さにする
  await page.setViewportSize({ width: 375, height: 500 });
  const missing = uniqueTitle(testInfo, "まだ無い題");
  for (let i = 0; i < 20; i++) {
    await api.createPage({ title: uniqueTitle(testInfo, `リンク元 ${i}`), body: `[[${missing}]]` });
  }
  const links = page.locator(".rail-section-links .rail-list a");
  await page.goto(`/${encodeURIComponent(missing)}`);
  await expect(links).toHaveCount(20);
  const target = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight - 50,
  );
  expect(target, "リンク元でスクロールできる長さ").toBeGreaterThan(200);
  await page.evaluate((y) => window.scrollTo(0, y), target);
  await expect.poll(() => scrollY(page)).toBe(target);
  const missingUrl = page.url();
  await openVisibleEntry(page, ".rail-section-links .rail-list a");
  await expect(page.locator(".title-input")).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(missingUrl);
  await expect(links).toHaveCount(20);
  await expect.poll(() => scrollY(page)).toBeGreaterThan(target - TOLERANCE);
  await expect.poll(() => scrollY(page)).toBeLessThan(target + TOLERANCE);
});
