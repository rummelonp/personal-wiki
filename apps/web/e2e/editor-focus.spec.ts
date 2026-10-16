import type { Page } from "@playwright/test";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";
import { SEED } from "./support/seed";

/*
 * 本文の欄は focus があっても外枠の outline を出さない。居場所は caret とカーソル行の地で分かる。
 * 別のタブから戻ったときはブラウザが元の要素へ focus を戻し、そのとき `:focus-visible` が付く。
 */

/** 外枠（.cm-editor）と、実際に focus を受ける .cm-content の outline の計算値。 */
async function outlines(page: Page): Promise<{ style: string; width: string }[]> {
  return page.evaluate(() =>
    [".cm-editor:has(.cm-content[aria-label='本文'])", ".cm-content[aria-label='本文']"].map(
      (selector) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`${selector} が無い`);
        const { outlineStyle, outlineWidth } = getComputedStyle(element);
        return { style: outlineStyle, width: outlineWidth };
      },
    ),
  );
}

async function expectNoOutline(page: Page): Promise<void> {
  for (const outline of await outlines(page)) {
    expect(outline.style === "none" || outline.width === "0px").toBe(true);
  }
}

/** caret は点滅で見え隠れするので、要素の有無で見る。title 欄の caret は数えない。 */
const bodyCursor = (page: Page) =>
  page.locator(".cm-editor:has(.cm-content[aria-label='本文']) .cm-cursor");

const bodyFrame = (page: Page) =>
  bodyEditor(page).locator("xpath=ancestor::*[contains(@class,'cm-editor')]");

/**
 * 別のタブから戻る状況。打鍵の後に focus が外れ、ブラウザが同じ要素へ focus を戻す。
 * CodeMirror は focus の変化を少し遅れて view に反映する。外れる側と戻る側のどちらも、
 * 反映（`cm-focused` の付け外し）を待たないと、枠が決まる前に測ってしまう。
 */
async function leaveAndReturn(page: Page): Promise<void> {
  await bodyEditor(page).evaluate((element) => element.blur());
  await expect(bodyFrame(page)).not.toHaveClass(/cm-focused/);
  await bodyEditor(page).evaluate((element) => element.focus());
  await expect(bodyFrame(page)).toHaveClass(/cm-focused/);
}

test("owner の本文は、クリックでも打鍵の後に戻っても outline を出さず、caret を残す", async ({
  page,
  api,
}, testInfo) => {
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "本文の枠"),
    body: "一行目\n二行目",
  });
  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page)).toContainText("一行目");
  await expect(saveState(page)).toHaveText("保存済み");

  await bodyEditor(page).locator(".cm-line").first().click();
  await expect(bodyEditor(page)).toBeFocused();
  await expectNoOutline(page);

  // 打鍵として数えられるよう、keydown の出るキーを押す
  await page.keyboard.press("End");
  await leaveAndReturn(page);
  expect(await bodyEditor(page).evaluate((element) => element.matches(":focus-visible"))).toBe(
    true,
  );
  await expectNoOutline(page);

  await expect(bodyCursor(page)).toHaveCount(1);
  await expect(bodyEditor(page).locator(".cm-active-line")).toHaveCount(1);
});

test.describe("匿名の読み取り", () => {
  test.use({ role: "anonymous" });

  test("読むだけの本文に focus が戻っても outline を出さない", async ({ page }) => {
    await page.goto(`/${encodeURIComponent(SEED.welcome)}`);
    await expect(bodyEditor(page)).toBeVisible();

    await bodyEditor(page).locator(".cm-line").first().click();
    await page.keyboard.press("ArrowDown");
    await leaveAndReturn(page);
    await expectNoOutline(page);
    // 読むだけでも caret とカーソル行の地は出るので、居場所は分かる
    await expect(bodyCursor(page)).toHaveCount(1);
    await expect(bodyEditor(page).locator(".cm-active-line")).toHaveCount(1);
  });
});
