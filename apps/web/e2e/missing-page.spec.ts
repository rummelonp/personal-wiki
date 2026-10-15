import type { Page } from "@playwright/test";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";

/*
 * まだ無いページへのリンクを押すと title の URL の空のページへ移り、そこへリンクしているページを並べる。
 */

const titlePath = (title: string) => `/${encodeURIComponent(title)}`;

const backlinkTitles = (page: Page) =>
  page.locator(".rail-section-links .rail-list a").allTextContents();

test.describe("owner", () => {
  test("無いページへのリンクから空のページへ移り、draft を含むリンク元を出す", async ({
    page,
    api,
  }, testInfo) => {
    const missing = uniqueTitle(testInfo, "まだ無いリンク先");
    const first = await api.createPage({
      title: uniqueTitle(testInfo, "リンク元 1"),
      body: `[[${missing}]]`,
    });
    const second = await api.createPage({
      title: uniqueTitle(testInfo, "リンク元 2"),
      body: `前置き [[${missing}]]`,
      visibility: "public",
    });
    await page.goto(`/p/${first.id}`);
    await expect(saveState(page)).toHaveText("保存済み");
    await bodyEditor(page).locator(".cm-wikilink", { hasText: missing }).click();

    await expect(page).toHaveURL(titlePath(missing));
    await expect(page.getByRole("heading", { level: 1, name: missing })).toBeVisible();
    await expect(page.locator(".rail-section-links .rail-list a")).toHaveCount(2);
    expect((await backlinkTitles(page)).sort()).toEqual([first.title, second.title].sort());
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "このタイトルで作成" })).toBeVisible();

    await page.locator(".rail-section-links").getByRole("link", { name: second.title }).click();
    await expect(page.locator(".title-input")).toHaveText(second.title);
  });
});

test.describe("匿名", () => {
  test.use({ role: "anonymous" });

  test("無いページへのリンクから空のページへ移り、public のリンク元だけを出す", async ({
    page,
    api,
  }, testInfo) => {
    const missing = uniqueTitle(testInfo, "まだ無いリンク先");
    const open = await api.createPage({
      title: uniqueTitle(testInfo, "公開のリンク元"),
      body: `[[${missing}]]`,
      visibility: "public",
    });
    const hidden = await api.createPage({
      title: uniqueTitle(testInfo, "下書きのリンク元"),
      body: `[[${missing}]]`,
    });
    await page.goto(titlePath(open.title));
    await expect(page.getByRole("heading", { level: 1, name: open.title })).toBeVisible();
    await bodyEditor(page).locator(".cm-wikilink", { hasText: missing }).click();

    await expect(page).toHaveURL(titlePath(missing));
    await expect(page.getByRole("heading", { level: 1, name: missing })).toBeVisible();
    await expect(page.locator(".rail-section-links .rail-list a")).toHaveCount(1);
    expect(await backlinkTitles(page)).toEqual([open.title]);
    await expect(page.locator(".rail-section-links")).not.toContainText(hidden.title);
    await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
  });

  test("public のリンク元が無ければ、リンク元の節も右の欄も出さない", async ({
    page,
    api,
  }, testInfo) => {
    const missing = uniqueTitle(testInfo, "まだ無いリンク先");
    await api.createPage({
      title: uniqueTitle(testInfo, "下書きのリンク元"),
      body: `[[${missing}]]`,
    });
    // 取得中も欄は隠れるので、応答を待たないと取得前の状態で通ってしまう
    const backlinks = page.waitForResponse((res) =>
      res.url().includes("/api/pages/by-title/backlinks"),
    );
    await page.goto(titlePath(missing));
    await backlinks;

    await expect(page.getByRole("heading", { level: 1, name: missing })).toBeVisible();
    await expect(
      page.getByText("まだ作られていないか、公開されていないページです。"),
    ).toBeVisible();
    await expect(page.locator(".rail-section-links")).toHaveCount(0);
    await expect(page.locator(".rail")).toBeHidden();
  });
});
