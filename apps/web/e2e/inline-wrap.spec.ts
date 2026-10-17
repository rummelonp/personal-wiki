import { bodyEditor, expect, test, uniqueTitle } from "./support/fixtures";

/*
 * 本文の markdown link と `==ハイライト==` の折り返し。wikilink（wikilink-wrap.spec.ts）と同じく、
 * 行に収まるものは字の間（「公｜開」）で折り返さず次の行へ丸ごと送り、行の幅より長いものは
 * はみ出さずに中で折り返す。幅を振る確かめは packages/editor の test（Chromium）が行う。
 * ここは iPhone の WebKit で効くことを確かめる。
 */

const TARGETS = [
  {
    name: "markdown link",
    selector: ".cm-md-link",
    wrap: (text: string) => `[${text}](https://example.com/)`,
  },
  { name: "ハイライト", selector: ".cm-lp-highlight", wrap: (text: string) => `==${text}==` },
];
const TEXT = "公開設定";
const LONG = "長い名前のページ".repeat(8);
const LEAD = "あ";
const COUNT = 40;

for (const { name, selector, wrap } of TARGETS) {
  test(`行に収まる${name}は、行末にかかっても字の間で折り返さない`, async ({
    page,
    api,
    isMobile,
  }, testInfo) => {
    test.skip(
      !isMobile,
      "行末にかかる位置は行の幅で決まる。字数を振った本文は iPhone の幅に合わせている",
    );
    // 1 つの段落に並べる。行（.cm-line）を分けると、画面の外の行が描かれず数えられない
    const body = Array.from(
      { length: COUNT },
      (_, index) => `${LEAD.repeat(index + 1)}${wrap(TEXT)}の記事`,
    ).join("");
    const created = await api.createPage({
      title: uniqueTitle(testInfo, `${name}の折り返し`),
      body,
    });
    await page.goto(`/p/${created.id}`);
    await expect(bodyEditor(page).locator(selector)).toHaveCount(COUNT);

    const result = await bodyEditor(page).evaluate((content, targetSelector) => {
      const line = content.querySelector(".cm-line") as HTMLElement;
      const left =
        line.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(line).paddingLeft);
      let split = 0;
      let atRowStart = 0;
      for (const target of content.querySelectorAll(targetSelector)) {
        const rects = target.getClientRects();
        if (rects.length > 1) split++;
        const first = rects[0];
        // 字の左端が行頭の端から 4px 以内なら、行頭に置かれたとみなす
        if (first && first.left - left < 4) atRowStart++;
      }
      return { split, atRowStart };
    }, selector);

    // 行頭に置かれたものが 1 つも無いと、行末にかかる位置を通っていない
    expect(result.split).toBe(0);
    expect(result.atRowStart).toBeGreaterThan(0);
  });

  test(`行の幅より長い${name}は、画面からはみ出さずに中で折り返す`, async ({
    page,
    api,
  }, testInfo) => {
    const created = await api.createPage({
      title: uniqueTitle(testInfo, `長い${name}の折り返し`),
      body: `前の文 ${wrap(LONG)} 後の文`,
    });
    await page.goto(`/p/${created.id}`);
    const target = bodyEditor(page).locator(selector);
    await expect(target).toHaveCount(1);

    await expect
      .poll(() => target.evaluate((element) => element.getClientRects().length))
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
}
