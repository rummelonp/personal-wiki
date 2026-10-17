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
 * 公開のページを `/p/<id>` で開く。開いた後に title の URL へ置き換わるので、その後の URL を戻り先として
 * 測る。置き換わる前の URL を測ると、戻った先の履歴が置き換え後の URL になっていて一致しない
 */
async function gotoCanonical(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page).not.toHaveURL(/\/p\//);
}

interface BodyLine {
  text: string;
  top: number;
}

/**
 * ヘッダーの下に見えている本文の最初の行の、文字と上端（viewport から）。本文は画面の外の行の高さが
 * 推定のまま残るので、同じスクロール量でも見える行が変わる。内容が同じ位置に見えるかは行で比べる。
 * ページの中で動かすので、外の変数や helper は参照しない（mousedown の listener にも文字列で渡す）。
 */
function measureFirstVisibleBodyLine(): BodyLine | null {
  const header = document.querySelector("header.header")?.getBoundingClientRect().bottom ?? 0;
  for (const line of document.querySelectorAll('.cm-content[aria-label="本文"] .cm-line')) {
    if ((line.textContent ?? "").trim() === "") continue;
    const range = document.createRange();
    range.selectNodeContents(line);
    const rect = range.getClientRects()[0];
    if (rect !== undefined && rect.bottom > header + 2) {
      return { text: (line.textContent ?? "").slice(0, 20), top: Math.round(rect.top) };
    }
  }
  return null;
}

const firstVisibleBodyLine = (page: Page) => page.evaluate(measureFirstVisibleBodyLine);

type WindowWithLine = Window & { lineAtMousedown?: BodyLine | null };

/** 次の mousedown の時点（クリックでスクロールや selection が動く前）の行を覚えておく */
const recordLineAtMousedown = (page: Page) =>
  page.evaluate(`(() => {
    const measure = ${measureFirstVisibleBodyLine.toString()};
    document.addEventListener(
      "mousedown",
      () => { window.lineAtMousedown = measure(); },
      { capture: true, once: true },
    );
  })()`);

const lineAtMousedown = (page: Page) =>
  page.evaluate(() => (window as WindowWithLine).lineAtMousedown ?? null);

/** 戻した後の合わせ直し（3 秒）の間と、終わった後の両方で、同じ行が同じ位置にあること */
async function expectSameLineAfterBack(page: Page, before: BodyLine | null): Promise<void> {
  expect(before, "本文の行が見えている").not.toBeNull();
  // 戻した後に、画面の外の行が測り直されて高さが変わることがあるので、落ち着いてから比べる
  await page.waitForTimeout(1000);
  for (const phase of ["合わせ直しの間", "合わせ直しの後"]) {
    const after = await firstVisibleBodyLine(page);
    expect(after?.text, phase).toBe(before?.text);
    expect(Math.abs((after?.top ?? 0) - (before?.top ?? 0)), phase).toBeLessThanOrEqual(3);
    if (phase === "合わせ直しの間") await page.waitForTimeout(3500);
  }
}

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

test("戻る、進む、戻ると続けたあとも、再読み込みのあとも、位置が戻る", async ({ page }) => {
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

test("再読み込みの起動中にスケルトンが出ても、位置が戻る", async ({ page }) => {
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

  // ログイン状態の確認を止め、一覧より先に起動中のスケルトンを描かせる
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
  // 負荷が高いとブラウザの復元がスケルトンの間に走り、スケルトンの高さに丸める。その時点を待たずに、同じ丸めを起こす。
  // スケルトンがスクロールできない幅（広い画面）では丸めが起きないので、検査にならない
  await page.evaluate((y) => window.scrollTo(0, y), SCROLL);
  const clamped = await scrollY(page);
  test.skip(clamped === 0, "この幅では起動中のスケルトンがスクロールできない");
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
  await gotoCanonical(page, `/p/${seedIds[SEED.welcome]}`);
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

test("長いページを途中までスクロールして本文の #tag を押し、戻ると同じ行が同じ位置に見える", async ({
  page,
  api,
}, testInfo) => {
  const lines = Array.from({ length: 120 }, (_, i) => `${i + 1} 行目の段落。`);
  lines.splice(60, 0, "途中にある #復元検査 のタグ。");
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "タグの復元"),
    body: lines.join("\n\n"),
  });
  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page).getByText("1 行目の段落。", { exact: true })).toBeVisible();

  // 先頭にはタグが無い。押せる位置まで途中までスクロールする。本文は画面の外の行を描かないので、
  // タグが描かれて、ヘッダーの下に見えるまで少しずつ送る
  const tag = bodyEditor(page).locator(".cm-tag", { hasText: "#復元検査" });
  const tagIsVisible = () =>
    tag.evaluateAll((elements) => {
      const header = document.querySelector("header.header")?.getBoundingClientRect().bottom ?? 0;
      return elements.some((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top > header && rect.bottom < window.innerHeight;
      });
    });
  for (let y = 600; !(await tagIsVisible()) && y < 20000; y += 400) {
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await page.waitForTimeout(150);
  }
  expect(await tagIsVisible(), "タグが画面に見えている").toBe(true);
  await page.waitForTimeout(500);
  expect(await scrollY(page), "ページの途中").toBeGreaterThan(1000);

  const pageUrl = page.url();
  await recordLineAtMousedown(page);
  await openVisibleEntry(page, ".cm-tag");
  const before = await lineAtMousedown(page);
  await expect(page).toHaveURL(`/?tag=${encodeURIComponent("復元検査")}`);
  await expect(page.locator(".entries .entry").first()).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(pageUrl);
  await expect(bodyEditor(page)).toBeVisible();
  await expectSameLineAfterBack(page, before);
});

test("長いページから wikilink で別のページへ移って戻ると、元のページの同じ行が同じ位置に見える", async ({
  page,
  seedIds,
}) => {
  await gotoCanonical(page, `/p/${seedIds[SEED.longPage]}`);
  await expect(bodyEditor(page).getByText("見出し 1", { exact: true })).toBeVisible();
  await page.evaluate((y) => window.scrollTo(0, y), 3000);
  await expect.poll(() => scrollY(page)).toBe(3000);
  // 動かした直後は、描かれた行が測られて高さが変わっていく。落ち着いてから測る
  await page.waitForTimeout(500);
  expect(await scrollY(page), "ページの途中").toBeGreaterThan(1000);

  const pageUrl = page.url();
  await recordLineAtMousedown(page);
  await openVisibleEntry(page, ".cm-wikilink");
  const before = await lineAtMousedown(page);
  await expect(page).not.toHaveURL(pageUrl);
  await expect(page.locator("h1.note-title, .title-input").first()).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(pageUrl);
  await expect(bodyEditor(page)).toBeVisible();
  // スクロール量ではなく、見える行で比べる。本文は画面の外の行の高さが推定のままなので、
  // 同じ量でも別の行が見える
  await expectSameLineAfterBack(page, before);
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

test.describe("狭い画面で目次から見出しへ移ったページ", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    if (testInfo.project.name === "chromium-desktop") {
      await page.setViewportSize({ width: 375, height: 812 });
    }
  });

  for (const tocOpen of [false, true]) {
    test(`wikilink で別のページへ移って戻ると、同じ行が同じ位置に見える（離れるとき目次は${tocOpen ? "開いている" : "閉じている"}）`, async ({
      page,
      seedIds,
    }) => {
      await gotoCanonical(page, `/p/${seedIds[SEED.longPage]}`);
      await expect(bodyEditor(page).getByText("見出し 1", { exact: true })).toBeVisible();
      const toc = page.locator("details.toc");
      await toc.locator("summary").click();
      await toc.getByRole("button", { name: "見出し 30", exact: true }).click();
      await expect(bodyEditor(page).getByText("見出し 30", { exact: true })).toBeInViewport();
      const jumpedTo = await scrollY(page);

      if (tocOpen) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await toc.locator("summary").click();
        await expect(toc).toHaveJSProperty("open", true);
        await page.evaluate((y) => window.scrollTo(0, y), jumpedTo);
      }
      // 移動の後に行の高さが測り直されて落ち着くまで待つ
      await page.waitForTimeout(500);

      const pageUrl = page.url();
      await recordLineAtMousedown(page);
      await openVisibleEntry(page, ".cm-wikilink");
      const before = await lineAtMousedown(page);
      await expect(page).not.toHaveURL(pageUrl);
      await expect(page.locator("h1.note-title, .title-input").first()).toBeVisible();

      await page.goBack();
      await expect(page).toHaveURL(pageUrl);
      await expect(bodyEditor(page)).toBeVisible();
      await expectSameLineAfterBack(page, before);
    });
  }
});
