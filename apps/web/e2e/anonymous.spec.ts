import type { Page } from "@playwright/test";
import {
  bodyEditor,
  expect,
  expectNoHorizontalScroll,
  test,
  uniqueTitle,
} from "./support/fixtures";
import { DRAFT_MARKER, SEED } from "./support/seed";

/*
 * ジャーニー #9 匿名: public のページを開いてリンクをたどれ、draft が title・一覧・検索・backlink の
 * どこにも出ない。draft は id の URL を知っていれば匿名にも読める仕様（AGENTS.md）なので、
 * `/p/<id>` が読めることは漏れとして扱わない。
 */

test.use({ role: "anonymous" });

const titlePath = (title: string) => `/${encodeURIComponent(title)}`;

/**
 * 右の列（タグ、backlink）と、あれば一覧に draft の印が無いこと。
 * 検索語の見出しは検索語を映すので見ない。
 */
async function expectNoDraftTrace(page: Page): Promise<void> {
  const regions = [page.locator(".rail")];
  if ((await page.locator(".entries").count()) > 0) regions.push(page.locator(".entries"));
  for (const region of regions) {
    for (const text of [DRAFT_MARKER, SEED.todo]) {
      await expect(region).not.toContainText(text);
    }
  }
}

test("public のページを title の URL で開き、リンクをたどれる @smoke", async ({ page }) => {
  await page.goto(titlePath(SEED.welcome));
  await expect(page.getByRole("heading", { level: 1, name: SEED.welcome })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await bodyEditor(page).getByText(SEED.server, { exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: SEED.server })).toBeVisible();
  await expect(page).toHaveURL(titlePath(SEED.server));
  await expectNoHorizontalScroll(page);
});

test("トップの一覧とタグに draft が出ない @smoke", async ({ page, api }, testInfo) => {
  // 他のテストが公開ページを作り続けると seed のページが一覧の先頭から外れるので、見るページを自分で作る
  const title = uniqueTitle(testInfo, "匿名の一覧");
  await api.createPage({ title, body: "本文", visibility: "public" });
  await page.goto("/");
  await expect(
    page.locator(".entries").getByRole("link", { name: title, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("complementary", { name: "補助情報" })).toContainText("database");
  await expectNoDraftTrace(page);
  await expect(page.locator(".chip-public")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test("draft の title の URL は存在しないページと同じ表示になる", async ({ page }) => {
  await page.goto(titlePath(SEED.draftSecret));
  await expect(page.getByRole("heading", { name: "ページが見つかりません" })).toBeVisible();
  await page.goto(titlePath("本当に存在しないページ"));
  await expect(page.getByRole("heading", { name: "ページが見つかりません" })).toBeVisible();
});

test("検索と quick switcher に draft が出ない", async ({ page }) => {
  await page.goto(`/?q=${DRAFT_MARKER}`);
  await expect(page.getByRole("heading", { name: "一致するページがありません" })).toBeVisible();
  await expect(page.locator(".entries")).toHaveCount(0);

  await page.getByRole("button", { name: "ページを検索" }).click();
  const switcher = page.getByRole("dialog", { name: "ページを検索" });
  await switcher.getByRole("combobox", { name: "ページを検索" }).fill(DRAFT_MARKER);
  await expect(switcher.getByText("タイトルが一致するページはありません。")).toBeVisible();
  await expect(switcher.getByRole("option", { name: SEED.draftSecret })).toHaveCount(0);
});

test("backlink に draft の参照元が出ない", async ({ page }) => {
  await page.goto(titlePath(SEED.database));
  const links = page.locator(".rail-section-links");
  await expect(links.getByRole("link", { name: SEED.server, exact: true })).toBeVisible();
  await expectNoDraftTrace(page);
});

test("匿名の 2 文字では本文の検索を出さず、3 文字以上と案内する", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "ページを検索" }).click();
  const switcher = page.getByRole("dialog", { name: "ページを検索" });
  const input = switcher.getByRole("combobox", { name: "ページを検索" });
  await input.fill("ほげ");
  await expect(switcher.getByRole("status")).toContainText("3 文字以上");
  await expect(switcher.getByRole("option", { name: /本文から検索/ })).toHaveCount(0);
  await input.press("Enter");
  await expect(page).toHaveURL("/");
  await expect(switcher).toBeVisible();
  await input.fill("ほげふ");
  await expect(switcher.getByRole("option", { name: "「ほげふ」を本文から検索" })).toBeVisible();
});

test("匿名の 0 件の検索結果には作成の導線が出ない", async ({ page }) => {
  await page.goto(`/?q=${encodeURIComponent("どこにも無い語句")}`);
  await expect(page.getByRole("heading", { name: "一致するページがありません" })).toBeVisible();
  await expect(page.getByRole("button", { name: /を作成/ })).toHaveCount(0);
});

test("一覧・title・タグ・検索・backlink の API が draft を返さない", async ({ page, seedIds }) => {
  await page.goto("/");
  const welcomeId = seedIds[SEED.welcome];
  const bodies = await page.evaluate(
    async ({ marker, welcomeId }) => {
      const paths = [
        "/api/pages/recent?limit=100",
        "/api/pages/titles?limit=100",
        "/api/tags",
        `/api/search?q=${marker}`,
        `/api/pages/${welcomeId}/backlinks`,
      ];
      return Promise.all(
        paths.map(async (path) => {
          const res = await fetch(path);
          return { path, status: res.status, text: await res.text() };
        }),
      );
    },
    { marker: DRAFT_MARKER, welcomeId },
  );
  for (const { path, status, text } of bodies) {
    expect(status, path).toBe(200);
    expect(text, path).not.toContain(DRAFT_MARKER);
    expect(text, path).not.toContain(seedIds[SEED.draftSecret]);
  }
  // 空の応答でも上の検査は通るので、public のページが返ることも確かめる
  for (const { path, text } of bodies.slice(0, 2)) {
    expect(text, path).toContain(welcomeId);
  }
});
