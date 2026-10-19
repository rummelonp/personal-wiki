import type { Locator, Page } from "@playwright/test";
import { expect, test, uniqueTitle } from "./support/fixtures";
import { lineTexts, midPhraseBreaks, misplacedWbrs, phraseSeams } from "./support/line-breaks";

/*
 * 一覧の見出し（.list-title）とページの title（.note-title）の折り返し。
 * word-break: auto-phrase を解釈しない描画（iPhone の WebKit）では、語の途中で折り返さないよう、
 * 見出しと title の文字列に <wbr> を置く（withPhraseBreaks）。解釈する描画は文節を自分で判定するので何も置かず、
 * 文節の切れ目を測るテストは走らせない。
 * 画面の幅を振るので、幅を自分で切り替える @widths は付けず、iPhone の WebKit で走らせる。
 */

const NARROWEST = 330;
const WIDEST = 393;
const STEP = 3;

// どの文節も 1 行に収まる幅だけを振る（1 行より長い文節は overflow-wrap: anywhere が切る）。助詞でつないだ片仮名交じりの語
const LONG_TEXT = [
  "ショートカットの",
  "キャンセルを",
  "ニュースの",
  "シャッターで",
  "フェッチした",
  "データを",
  "コーヒーで",
  "リフレッシュを",
  "確認ページで",
].join("");

const longText = (): string => `${LONG_TEXT}確認${Math.random().toString(36).slice(2, 6)}`;

const titlePath = (title: string) => `/${encodeURIComponent(title)}`;

const isAutoPhraseRendering = (page: Page): Promise<boolean> =>
  page.evaluate(() => CSS.supports("word-break", "auto-phrase"));

/**
 * 画面の幅を振り、見出しが語の途中で折り返さないこと、<wbr> が文節の切れ目だけにあることを測る。
 * 折り返す幅が 1 つも無ければ何も測れていないので、失敗にする。
 */
async function expectNoMidPhraseBreaks(page: Page, heading: Locator): Promise<void> {
  const height = page.viewportSize()?.height ?? 800;
  let wrapped = 0;
  for (let width = NARROWEST; width <= WIDEST; width += STEP) {
    await page.setViewportSize({ width, height });
    await expect(heading).toBeVisible();
    if ((await lineTexts(heading)).length > 1) wrapped++;
    expect(await midPhraseBreaks(heading), `${width}px で語の途中で折り返している`).toEqual([]);
  }
  expect(wrapped, "折り返す幅が無く、測れていない").toBeGreaterThan(0);
  expect((await phraseSeams(heading)).length, "<wbr> が無い").toBeGreaterThan(0);
  expect(await misplacedWbrs(heading), "<wbr> が文節の切れ目にない").toEqual([]);
}

/** 条件に合う API の応答を、release まで返さない。 */
async function holdResponses(page: Page, match: (url: URL) => boolean): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(match, async (route) => {
    await gate;
    await route.continue().catch(() => {});
  });
  return release;
}

test("長いタグで絞った一覧の見出しは、語の途中で折り返さない", async ({ page, api }, testInfo) => {
  const tag = longText();
  await api.createPage({ title: uniqueTitle(testInfo, "見出しの折り返し"), body: `#${tag}` });
  await page.goto(`/?tag=${encodeURIComponent(tag)}`);
  const heading = page.locator("h1.list-title");
  await expect(heading).toHaveText(`タグ「${tag}」`);
  test.skip(await isAutoPhraseRendering(page), "auto-phrase を解釈する描画は文節で切る");
  await expectNoMidPhraseBreaks(page, heading);
});

test("長い検索語の見出しは、語の途中で折り返さない", async ({ page }) => {
  const query = longText();
  await page.goto(`/?q=${encodeURIComponent(query)}`);
  const heading = page.locator("h1.list-title");
  await expect(heading).toHaveText(`「${query}」の検索結果`);
  test.skip(await isAutoPhraseRendering(page), "auto-phrase を解釈する描画は文節で切る");
  await expectNoMidPhraseBreaks(page, heading);
});

test.describe("匿名", () => {
  test.use({ role: "anonymous" });

  test("public のページの title は、語の途中で折り返さない", async ({ page, api }) => {
    const title = longText();
    const created = await api.createPage({ title, body: "本文", visibility: "public" });
    await page.goto(`/p/${created.id}`);
    const heading = page.locator("h1.note-title");
    await expect(heading).toHaveText(title);
    // <wbr> は文字列を変えないので、コピーや読み上げの名前は title のまま
    expect(await heading.evaluate((element) => element.textContent)).toBe(title);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    test.skip(await isAutoPhraseRendering(page), "auto-phrase を解釈する描画は文節で切る");
    await expectNoMidPhraseBreaks(page, heading);
  });

  test("title の URL で開いた、まだ無いページの title は、語の途中で折り返さない", async ({
    page,
  }) => {
    const title = longText();
    await page.goto(titlePath(title));
    const heading = page.locator("h1.note-title");
    await expect(heading).toHaveText(title);
    test.skip(await isAutoPhraseRendering(page), "auto-phrase を解釈する描画は文節で切る");
    await expectNoMidPhraseBreaks(page, heading);
  });

  test("読み込み中のスケルトンの title と一覧の見出しも、語の途中で折り返さない", async ({
    page,
    api,
  }) => {
    const title = longText();
    await api.createPage({ title, body: "本文", visibility: "public" });
    const release = await holdResponses(page, (url) => url.pathname === "/api/pages/by-title");
    await page.goto(titlePath(title));
    const heading = page.locator(".note[aria-busy='true'] .note-title");
    await expect(heading).toHaveText(title);
    test.skip(await isAutoPhraseRendering(page), "auto-phrase を解釈する描画は文節で切る");
    await expectNoMidPhraseBreaks(page, heading);
    release();

    const tag = longText();
    const releaseList = await holdResponses(
      page,
      (url) => url.pathname === "/api/pages/recent" || url.pathname === "/api/pages",
    );
    await page.goto(`/?tag=${encodeURIComponent(tag)}`);
    const listHeading = page.locator(".home[aria-busy='true'] .list-title");
    await expect(listHeading).toHaveText(`タグ「${tag}」`);
    await expectNoMidPhraseBreaks(page, listHeading);
    releaseList();
  });
});
