import type { Page } from "@playwright/test";
import { bodyEditor, expect, test, uniqueTitle } from "./support/fixtures";
import { longPageBody } from "./support/seed";

/*
 * 見出しへのリンクで移るのは読むため。見出しの行が画面の上の方に見えるまでスクロールするだけで、
 * エディタに focus しない（iOS のキーボードが開かない、Live Preview で隠れた `## ` が現れない）。
 */

const HEADING = "見出し 25";

const headingLine = (page: Page) => bodyEditor(page).locator(".cm-line", { hasText: HEADING });

async function expectReadingAt(page: Page): Promise<void> {
  // 記号が現れていれば、行の文字は「## 見出し 25」になる
  await expect(bodyEditor(page).locator(".cm-line", { hasText: `## ${HEADING}` })).toHaveCount(0);
  const line = headingLine(page).filter({ hasText: /^見出し 25$/ });
  await expect(line).toHaveCount(1);
  await expect
    .poll(
      () =>
        page.evaluate((text) => {
          // 行の box には見出しの上の余白が含まれるので、文字の位置で測る
          const lines = [...document.querySelectorAll(".cm-content .cm-line")];
          const line = lines.find((el) => el.textContent === text);
          if (!line) return false;
          const range = document.createRange();
          range.selectNodeContents(line);
          const glyph = range.getBoundingClientRect();
          const header = document.querySelector("header.header")?.getBoundingClientRect();
          // ヘッダーの下に隠れず、画面の上の方（上から 4 割まで）にある
          return glyph.top >= (header?.bottom ?? 0) && glyph.top < window.innerHeight * 0.4;
        }, HEADING),
      { message: "見出しの文字が画面の上の方に見えていない" },
    )
    .toBe(true);
  expect(
    await page.evaluate(() => document.activeElement?.closest(".cm-editor") ?? null),
    "エディタに focus が残っている",
  ).toBeNull();
}

test("同じページの見出しリンクで、見出しが見える位置へ移り、エディタに focus しない @smoke", async ({
  page,
  api,
}, testInfo) => {
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "見出しリンク"),
    body: `[[#${HEADING}]]\n\n${longPageBody()}`,
  });
  await page.goto(`/p/${created.id}`);
  await bodyEditor(page)
    .locator(".cm-wikilink", { hasText: `#${HEADING}` })
    .click();
  await expectReadingAt(page);
});

test("本文に caret がある状態から見出しリンクで移っても、focus を外して記号を出さない", async ({
  page,
  api,
}, testInfo) => {
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "見出しリンクの focus"),
    body: `[[#${HEADING}]]\n\n編集中の段落\n\n${longPageBody()}`,
  });
  await page.goto(`/p/${created.id}`);
  await bodyEditor(page).locator(".cm-line", { hasText: "編集中の段落" }).click();
  await expect(bodyEditor(page)).toBeFocused();
  await bodyEditor(page)
    .locator(".cm-wikilink", { hasText: `#${HEADING}` })
    .click();
  await expectReadingAt(page);
});

test("別のページの見出しリンクで移っても、同じ扱いになる", async ({ page, api }, testInfo) => {
  const target = await api.createPage({
    title: uniqueTitle(testInfo, "見出しリンクの移動先"),
    body: longPageBody(),
  });
  const source = await api.createPage({
    title: uniqueTitle(testInfo, "見出しリンクの移動元"),
    body: `[[${target.title}#${HEADING}]]`,
  });
  await page.goto(`/p/${source.id}`);
  await bodyEditor(page).locator(".cm-wikilink").first().click();
  await expect(page).toHaveURL(new RegExp(`/p/${target.id}#`));
  await expectReadingAt(page);
});
