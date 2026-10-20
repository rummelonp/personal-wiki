import type { Page, TestInfo } from "@playwright/test";
import type { OwnerApi } from "./support/api";
import { expect, test, uniqueTitle } from "./support/fixtures";

/*
 * 一覧の並び順のメニュー。更新日時、作成日時、title の順がどれも違う 3 ページを同じタグで作り、
 * 並びを選び直すと一覧と見出しが変わること、選んだ並びが別の一覧、ノートから戻った後、再読み込みにも
 * 残ること、URL に載らないこと、検索中はメニューを出さないことを確かめる。
 */

const ACTIVITY_GAP_MS = 20;

/** 更新日時、作成日時、title の順がどれも違う 3 ページを、実行ごとに違うタグで作る。 */
async function seedSorted(api: OwnerApi, testInfo: TestInfo, visibility: "draft" | "public") {
  const run = uniqueTitle(testInfo, "並び順");
  const tag = `listsort${Math.random().toString(36).slice(2, 8)}`;
  const titles = { apple: `Apple ${run}`, mango: `Mango ${run}`, zebra: `Zebra ${run}` };
  // 作成日時と更新日時がミリ秒で並ぶよう、間を空けて作る（同じ時刻だと id の順になり、期待の並びが揺れる）
  const pause = () => new Promise((resolve) => setTimeout(resolve, ACTIVITY_GAP_MS));
  const mango = await api.createPage({ title: titles.mango, body: `#${tag}`, visibility });
  await pause();
  await api.createPage({ title: titles.apple, body: `#${tag}`, visibility });
  await pause();
  await api.createPage({ title: titles.zebra, body: `#${tag}`, visibility });
  await pause();
  await api.updatePage(mango, { body: `#${tag} 更新` });
  return {
    run,
    tag,
    titles,
    byUpdated: [titles.mango, titles.zebra, titles.apple],
    byCreated: [titles.zebra, titles.apple, titles.mango],
    byTitle: [titles.apple, titles.mango, titles.zebra],
  };
}

function listSortControls(page: Page) {
  const sortButton = page.getByRole("button", { name: /^並び順: / });
  return {
    rows: page.locator(".entries .entry-title"),
    sortButton,
    choose: async (label: string) => {
      await sortButton.click();
      await page.getByRole("menuitemradio", { name: label }).click();
    },
  };
}

test("並びを選び直すと一覧と見出しが変わり、選んだ並びは別の一覧、ノートから戻った後、再読み込みにも残る", async ({
  page,
  api,
}, testInfo) => {
  const { run, tag, titles, byUpdated, byCreated, byTitle } = await seedSorted(
    api,
    testInfo,
    "draft",
  );
  const { rows, sortButton, choose } = listSortControls(page);

  await page.goto(`/?tag=${tag}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`タグ「${tag}」`);
  await expect(rows).toHaveText(byUpdated);
  await expect(sortButton).toHaveAccessibleName("並び順: 更新日時");

  await choose("作成日時");
  await expect(rows).toHaveText(byCreated);
  await expect(sortButton).toHaveAccessibleName("並び順: 作成日時");
  await expect(sortButton).toBeFocused();
  expect(new URL(page.url()).search).toBe(`?tag=${tag}`);

  // 公開範囲で絞った一覧にも同じ並びを使う（作ったページはどれも下書き）
  await page.goto(`/?tag=${tag}&visibility=draft`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`タグ「${tag}」の下書き`);
  await expect(rows).toHaveText(byCreated);

  // ノートを開いて戻っても並びを保つ
  await rows.filter({ hasText: titles.apple }).click();
  await expect(page).toHaveURL(/\/p\//);
  await page.goBack();
  await expect(rows).toHaveText(byCreated);
  await expect(sortButton).toHaveAccessibleName("並び順: 作成日時");

  await choose("タイトル");
  await expect(rows).toHaveText(byTitle);
  await page.reload();
  await expect(rows).toHaveText(byTitle);
  await expect(sortButton).toHaveAccessibleName("並び順: タイトル");

  // 絞らない一覧は、更新日時の順でなければ「すべてのページ」と呼ぶ
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("すべてのページ");

  // 検索中は関連度の順のままで、メニューを出さない
  await page.goto(`/?q=${encodeURIComponent(run)}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`「${run}」の検索結果`);
  await expect(page.locator(".home")).not.toHaveAttribute("aria-busy", "true");
  await expect(sortButton).toHaveCount(0);

  await page.goto(`/?tag=${tag}`);
  await choose("更新日時");
  await expect(rows).toHaveText(byUpdated);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("最近の更新");
});

test("並び順のボタンは見出しの 1 行目の右に収まり、見出しの行の高さを変えない", async ({
  page,
  api,
}, testInfo) => {
  await api.createPage({ title: uniqueTitle(testInfo, "並び順のボタン"), body: "" });
  await page.goto("/");
  // /api/me を待つ間は、同じ見出しのスケルトン（別の .home と h1）が出る。測っている途中で一覧に
  // 差し替わらないよう、一覧が読み終わるのを待ち、位置は 1 回の evaluate でまとめて測る
  await expect(page.locator(".entries .entry-title").first()).toBeVisible();
  await expect(page.locator(".home")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("最近の更新");
  const box = await page.evaluate(() => {
    const elementOf = (selector: string) => {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(`${selector} が無い`);
      return element;
    };
    const rectOf = (selector: string) => {
      const { top, bottom, right } = elementOf(selector).getBoundingClientRect();
      return { top, bottom, right };
    };
    const button = elementOf(".home button.list-sort-button");
    const rect = button.getBoundingClientRect();
    const inset = Number.parseFloat(getComputedStyle(button, "::before").top);
    return {
      head: rectOf(".home h1"),
      face: { right: rect.right, top: rect.top + inset, bottom: rect.bottom - inset },
      hit: rect.height,
      list: rectOf(".home"),
      firstRow: rectOf(".home .entries"),
      coarse: matchMedia("(pointer: coarse)").matches,
    };
  });
  const { head, face, list, firstRow } = box;
  // 見た目の地は見出しの 1 行に収まり、右端は一覧の右端にそろう
  expect(face.top).toBeGreaterThanOrEqual(head.top - 1);
  expect(face.bottom).toBeLessThanOrEqual(head.bottom + 1);
  expect(Math.abs(face.right - list.right)).toBeLessThanOrEqual(1);
  // 指で押す端末では当たり判定を 44px に広げる
  if (box.coarse) expect(box.hit).toBeGreaterThanOrEqual(44);
  // 箱が広がっても、一覧の 1 行目は見出しのすぐ下から始まる
  expect(firstRow.top - head.bottom).toBeLessThanOrEqual(20);
});

test.describe("匿名", () => {
  test.use({ role: "anonymous" });

  test("匿名の一覧でも並びを選び直せ、公開ページを選んだ並びで出す", async ({
    page,
    api,
  }, testInfo) => {
    const { tag, byUpdated, byTitle } = await seedSorted(api, testInfo, "public");
    const { rows, choose } = listSortControls(page);

    await page.goto(`/?tag=${tag}`);
    await expect(rows).toHaveText(byUpdated);
    await choose("タイトル");
    await expect(rows).toHaveText(byTitle);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("すべてのページ");
  });
});
