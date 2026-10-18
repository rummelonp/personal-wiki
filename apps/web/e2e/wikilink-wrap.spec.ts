import { bodyEditor, expect, test, uniqueTitle } from "./support/fixtures";
import { rowsPerItem } from "./support/wrap-rows";

/*
 * 本文の wikilink の折り返し。link は地の文と同じ禁則で、字の間（「公｜開」）でも折り返す。
 * 行の幅より長い link は、はみ出さずに link の中で折り返す。
 * 行末にかかる位置は、link の前に置く字数を振って必ず通らせる。幅を振る確かめは、
 * packages/editor の test（Chromium）が行う。ここは iPhone の WebKit で地の文と同じ位置になることを確かめる。
 */

const LINK = "公開設定";
const LONG = "長い名前のページ".repeat(8);
const LEAD = "あ";
const TRAIL = "の記事";
const COUNT = 40;

test("行末にかかった wikilink は、地の文と同じ位置で、字の間でも折り返す", async ({
  page,
  api,
  isMobile,
}, testInfo) => {
  test.skip(
    !isMobile,
    "行末にかかる位置は行の幅で決まる。字数を振った本文は iPhone の幅に合わせている",
  );
  // 1 つの段落に並べる。行（.cm-line）を分けると、画面の外の行が描かれず数えられない
  const item = (index: number, text: string) => `${LEAD.repeat(index + 1)}${text}${TRAIL}`;
  const bodyOf = (text: string) =>
    Array.from({ length: COUNT }, (_, index) => item(index, text)).join("");
  const options = { count: COUNT, lead: LEAD, text: LINK, trail: TRAIL };

  const linked = await api.createPage({
    title: uniqueTitle(testInfo, "wikilink の折り返し"),
    body: bodyOf(`[[${LINK}]]`),
  });
  await page.goto(`/p/${linked.id}`);
  await expect(bodyEditor(page).locator(".cm-wikilink")).toHaveCount(COUNT);
  const linkRows = await rowsPerItem(bodyEditor(page), { ...options, selector: ".cm-wikilink" });

  const plain = await api.createPage({
    title: uniqueTitle(testInfo, "wikilink の折り返しの比較"),
    body: bodyOf(LINK),
  });
  await page.goto(`/p/${plain.id}`);
  await expect(bodyEditor(page).locator(".cm-line")).toHaveCount(1);
  const plainRows = await rowsPerItem(bodyEditor(page), { ...options, selector: null });

  expect(linkRows).toEqual(plainRows);
  // 字の間で折り返された link が 1 つも無いと、link が行末にかかる位置を通っていない
  expect(linkRows.some((rows) => rows > 1)).toBe(true);
});

test("行の幅より長い wikilink は、画面からはみ出さずに link の中で折り返す", async ({
  page,
  api,
}, testInfo) => {
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "長い wikilink の折り返し"),
    body: `前の文 [[${LONG}]] 後の文`,
  });
  await page.goto(`/p/${created.id}`);
  const link = bodyEditor(page).locator(".cm-wikilink");
  await expect(link).toHaveCount(1);

  await expect
    .poll(() => link.evaluate((element) => element.getClientRects().length))
    .toBeGreaterThan(1);
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const scroller = document.querySelector(".cm-scroller");
    return {
      page: root.scrollWidth - root.clientWidth,
      scroller: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.scroller).toBeLessThanOrEqual(0);
});
