import type { Locator, Page } from "@playwright/test";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";
import { type NumberSplits, splitNumbers, splitNumbersAcrossWidths } from "./support/line-breaks";

/*
 * 画面の文言は数と単位を詰めて書く（「3文字以上」「2バイト」）。詰めると、文節で切らない描画（iPhone の WebKit）は
 * 数と漢字や仮名の間で折り返せるので、狭い画面で数と単位が別の行に分かれないことを測る。
 * 幅は 320 から 375 までを 1px ずつ振る。文言の長さや数の桁で折り返す位置はずれるので、
 * 2 つの幅だけでは、その間の幅で分かれることを見逃す。
 * iPhone の WebKit で走らせる必要があるので、デスクトップの Chromium だけで走る @widths は付けない。
 */

const NARROWEST = 320;
const WIDEST = 375;

/** 行が描かれるまで測り直す。描かれていれば、測るのは 1 回で済む。 */
async function drawnNumberSplits(target: Locator, width: number): Promise<string[]> {
  const measured: NumberSplits[] = [];
  await expect
    .poll(
      async () => {
        const result = await splitNumbers(target);
        measured.push(result);
        return result.drawn;
      },
      { message: `${width}px で文が描かれていない` },
    )
    .toBe(true);
  return (measured.at(-1) as NumberSplits).splits;
}

/**
 * 画面の幅を振り、数と単位が別の行に分かれた幅と位置を集める。
 * 幅ごとの往復は setViewportSize と 1 回の evaluate に抑える。負荷の高い runner（CI の macOS）では
 * 往復が秒単位で止まることがあり、幅の数（56）だけ往復すると 1 テストが 60 秒の時間切れになる。
 */
async function numberSplitsAcrossWidths(page: Page, target: Locator): Promise<string[]> {
  const height = page.viewportSize()?.height ?? 800;
  await expect(target).toBeVisible();
  const found: string[] = [];
  for (let width = NARROWEST; width <= WIDEST; width++) {
    await page.setViewportSize({ width, height });
    for (const split of await drawnNumberSplits(target, width)) found.push(`${width}px: ${split}`);
  }
  return found;
}

test("測る道具は、数と単位の間の折り返しを見つけ、WORD JOINER を挟むと見つけない", async ({
  page,
}) => {
  const probe = page.locator("#probe");
  // 文節で切らない描画の折り返しを、どのブラウザでも再現する
  const splitsOf = async (text: string): Promise<string[]> => {
    await page.setContent(
      `<div id="probe" lang="ja" style="font:16px sans-serif;word-break:normal">${text}</div>`,
    );
    // 「約20」は幅 2 字ほどまで狭めないと、その中で折り返さない
    const widths = Array.from({ length: 141 }, (_, index) => 20 + index * 2);
    return splitNumbersAcrossWidths(probe, widths);
  };

  const sentence = "一致するタイトルはありません。3文字以上で、本文からも検索できます。";
  expect(await splitsOf(sentence)).toContain("3|文");
  expect(await splitsOf("約20時間前に保存しました。")).toEqual(
    expect.arrayContaining(["約|2", "0|時"]),
  );
  expect(await splitsOf(sentence.replace("3文字", "3⁠文字"))).toEqual([]);
});

test.describe("匿名", () => {
  test.use({ role: "anonymous" });

  test("quick switcher の検索の文字数の案内", async ({ page }) => {
    // 候補の取得が済む前は、取得中の案内（.switcher-pending）が文字数の案内と並ぶ。負荷で取得が遅れた状態を、
    // 取得を止めて必ず作る
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/pages/titles*", async (route) => {
      await held;
      await route.continue();
    });
    await page.setViewportSize({ width: NARROWEST, height: 800 });
    await page.goto("/");
    await page.getByRole("button", { name: "ページを検索" }).click();
    const switcher = page.getByRole("dialog", { name: "ページを検索" });
    await switcher.getByRole("combobox", { name: "検索語" }).fill("ほげ");
    await expect(switcher.locator(".switcher-pending")).toHaveCount(1);
    const note = switcher.locator(".switcher-heading:not(.switcher-pending)");
    await expect(note).toContainText("文字以上で、本文からも検索できます。");
    expect(await numberSplitsAcrossWidths(page, note)).toEqual([]);
    release();
    await expect(switcher.locator(".switcher-pending")).toHaveCount(0);
    await expect(note).toContainText("文字以上で、本文からも検索できます。");
  });

  test("検索結果の、文字数が足りない案内", async ({ page }) => {
    await page.setViewportSize({ width: NARROWEST, height: 800 });
    await page.goto(`/?q=${encodeURIComponent("ほげ")}`);
    const title = page.locator(".empty-title");
    await expect(title).toContainText("文字以上で検索してください");
    expect(await numberSplitsAcrossWidths(page, title)).toEqual([]);
  });
});

test("検索語が長すぎるときの案内", async ({ page }) => {
  await page.setViewportSize({ width: NARROWEST, height: 800 });
  await page.goto(`/?q=${encodeURIComponent("あ".repeat(201))}`);
  const text = page.locator(".empty-text");
  await expect(text).toContainText("文字以内にしてください。");
  expect(await numberSplitsAcrossWidths(page, text)).toEqual([]);
});

test("知らせの文（本文が上限を超えた量）", async ({ page, api }, testInfo) => {
  const max = 65_536;
  const line = `${"a".repeat(99)}\n`;
  const fill = max - 4;
  const body = `${line.repeat(Math.floor(fill / line.length))}${"a".repeat(fill % line.length)}`;
  const created = await api.createPage({ title: uniqueTitle(testInfo, "上限の折り返し"), body });
  await page.setViewportSize({ width: NARROWEST, height: 800 });
  await page.goto(`/p/${created.id}`);
  await expect(saveState(page)).toHaveText("保存済み");
  await bodyEditor(page).locator(".cm-line").last().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("b".repeat(1_238));
  await bodyEditor(page).blur();
  const text = page
    .locator(".notice")
    .filter({ has: page.locator(".notice-title", { hasText: "本文が長すぎて保存できません" }) })
    .locator(".notice-text");
  await expect(text).toContainText("本文が上限を1,234バイト超えています。");
  expect(await numberSplitsAcrossWidths(page, text)).toEqual([]);
});
