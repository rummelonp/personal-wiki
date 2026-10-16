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
 * 匿名の読み取り: public のページを開いてリンクをたどれ、draft が title、一覧、検索、backlink の
 * どこにも出ない。draft は id の URL を知っていれば匿名にも読める仕様（docs/attachments.md）なので、
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

test("本文の #tag を押すとタグの一覧へ移り、戻るで元のページに戻る", async ({ page }) => {
  await page.goto(titlePath(SEED.welcome));
  await bodyEditor(page).locator(".cm-tag", { hasText: "#メモ" }).click();
  await expect(page).toHaveURL(`/?tag=${encodeURIComponent("メモ")}`);
  await expect(page.locator(".entries .entry").first()).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(titlePath(SEED.welcome));
  await expect(page.getByRole("heading", { level: 1, name: SEED.welcome })).toBeVisible();
});

test("トップの一覧とタグに draft が出ない @smoke", async ({ page, api }, testInfo) => {
  // 他のテストが公開ページを作り続けると seed のページが一覧の先頭から外れるので、見るページを自分で作る
  const title = uniqueTitle(testInfo, "匿名の一覧");
  await api.createPage({ title, body: "本文", visibility: "public" });
  // 公開ページの直後に作る draft は、一覧の 1 ページ目に入る位置にある。seed の世代が押し出されても、
  // 匿名の一覧とタグにこの draft の目印が出ないことを確かめられる
  const draftTitle = uniqueTitle(testInfo, "匿名に出ない下書き");
  const draftTag = `zqxdraft${Date.now().toString(36)}`;
  await api.createPage({ title: draftTitle, body: `本文 #${draftTag}` });
  await page.goto("/");
  await expect(
    page.locator(".entries").getByRole("link", { name: title, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("complementary", { name: "補助情報" })).toContainText("database");
  await expectNoDraftTrace(page);
  await expect(page.locator(".entries")).not.toContainText(draftTitle);
  await expect(page.getByRole("complementary", { name: "補助情報" })).not.toContainText(draftTag);
  await expect(page.locator(".entry-visibility")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test("公開範囲の絞り込みの欄を出さず、URL の visibility=draft でも公開ページの一覧を出す", async ({
  page,
  api,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "匿名の絞り込み");
  await api.createPage({ title, body: "本文", visibility: "public" });
  await page.goto("/?visibility=draft");
  await expect(page.getByRole("heading", { name: "最近の更新" })).toBeVisible();
  await expect(
    page.locator(".entries").getByRole("link", { name: title, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("complementary", { name: "補助情報" })).toContainText("database");
  await expect(page.getByRole("navigation", { name: "公開範囲で絞り込む" })).toHaveCount(0);
  await expect(page.locator(".rail")).not.toContainText("公開範囲");
  await expectNoDraftTrace(page);
});

test("draft の title の URL は存在しないページと同じ空のページになる", async ({ page }) => {
  const shown: string[] = [];
  for (const title of [SEED.draftSecret, "本当に存在しないページ"]) {
    // 匿名にはリンク元 0 件の節を出さないので、取得を終えたことは応答で待つ
    const backlinks = page.waitForResponse((res) =>
      res.url().includes("/api/pages/by-title/backlinks"),
    );
    await page.goto(titlePath(title));
    await backlinks;
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.locator(".rail")).toBeHidden();
    await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
    shown.push((await page.getByRole("main").innerText()).replaceAll(title, "<title>"));
  }
  expect(shown[1]).toBe(shown[0]);
  expect(shown[0]).not.toContain("下書き");
});

test("検索と quick switcher に draft が出ない", async ({ page }) => {
  await page.goto(`/?q=${DRAFT_MARKER}`);
  await expect(page.getByRole("heading", { name: "一致するページがありません" })).toBeVisible();
  await expect(page.locator(".entries")).toHaveCount(0);

  await page.getByRole("button", { name: "ページを検索" }).click();
  const switcher = page.getByRole("dialog", { name: "ページを検索" });
  // 未入力の行は取得した候補だけなので、行が出れば候補は届いている。匿名の title の取得は 1 回で
  // 終わる（ANONYMOUS_TITLE_INDEX_MAX_REQUESTS が 1）ことを前提にしている。続きを取るようになると、
  // 行が出た後に届く候補に draft が混ざっても、下の検査がその前に通ってしまう
  await expect(switcher.getByRole("option").first()).toBeVisible();
  await switcher.getByRole("combobox", { name: "検索語" }).fill(DRAFT_MARKER);
  // 一致する title が無いので、行は本文から検索するものだけになる
  await expect(
    switcher.getByRole("option", { name: `「${DRAFT_MARKER}」を本文から検索` }),
  ).toBeVisible();
  await expect(switcher.getByRole("option")).toHaveCount(1);
  await expect(switcher.getByRole("option", { name: SEED.draftSecret })).toHaveCount(0);
});

test("backlink に draft の参照元が出ない", async ({ page }) => {
  await page.goto(titlePath(SEED.database));
  const links = page.locator(".rail-section-links");
  await expect(links.getByRole("link", { name: SEED.server, exact: true })).toBeVisible();
  await expectNoDraftTrace(page);
});

test("ページの埋め込みは public を展開し、draft を存在しないページと同じに出す", async ({
  page,
  api,
}, testInfo) => {
  // 「draft の title の URL」のテストは、seed の draft と「本当に存在しないページ」にリンク元が無く
  // 右の列が隠れることを見る。それらを埋め込むとリンク元ができ、実行の順番しだいでそのテストが
  // 落ちるので、埋め込む draft と存在しないページはここで作る
  const title = uniqueTitle(testInfo, "匿名の埋め込み");
  const draft = uniqueTitle(testInfo, "埋め込まれる下書き");
  const draftBody = `埋め込みから漏れてはいけない ${DRAFT_MARKER}`;
  const missing = uniqueTitle(testInfo, "埋め込み先の無いページ");
  await api.createPage({ title: draft, body: draftBody });
  await api.createPage({
    title,
    body: `![[${SEED.database}]]\n\n![[${draft}]]\n\n![[${missing}]]`,
    visibility: "public",
  });
  await page.goto(titlePath(title));
  const embed = (target: string) =>
    bodyEditor(page).locator(`.cm-embed-page[data-embed-target="${target}"]`);

  await expect(embed(SEED.database)).toHaveAttribute("data-embed-state", "resolved");
  await expect(embed(SEED.database).locator(".cm-embed-page-body")).toContainText("読み取り行数");
  // 取得中は loading なので、unresolved になれば取得は 404 で終わっている
  for (const target of [draft, missing]) {
    await expect(embed(target)).toHaveAttribute("data-embed-state", "unresolved");
    await expect(embed(target).locator(".cm-embed-unresolved")).toHaveText(target);
  }
  await expect(bodyEditor(page)).not.toContainText(DRAFT_MARKER);
  await expectNoDraftTrace(page);
});

test("匿名の 2 文字では本文の検索を出さず、3 文字以上と案内する", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "ページを検索" }).click();
  const switcher = page.getByRole("dialog", { name: "ページを検索" });
  const input = switcher.getByRole("combobox", { name: "検索語" });
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

test("一覧、title、タグ、検索、backlink の API が draft を返さない", async ({ page, seedIds }) => {
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
