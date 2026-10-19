import type { Page } from "@playwright/test";
import type { ApiPage } from "./support/api";
import {
  bodyEditor,
  expect,
  saveState,
  test,
  typeAtBodyEnd,
  uniqueTitle,
} from "./support/fixtures";

/*
 * 初回の表示: public のページを直接開いたときと再読み込みのときは、Worker が HTML に入れたページで出し、
 * ページの JSON を引かない。draft と、SPA の中の移動で開いたページは JSON を引く。
 */

const titlePath = (title: string) => `/${encodeURIComponent(title)}`;
/** public のページの正の URL。空白は `_` で書く。 */
const canonicalPath = (title: string) => `/${encodeURIComponent(title.replaceAll(" ", "_"))}`;

/** ページの JSON（`/api/pages/<id>` と `/api/pages/by-title`）。被リンクや一覧、resolve は含めない。 */
const PAGE_READ = /^\/api\/pages\/(?!recent$|titles$|resolve$)[^/]+$/;

/** 正の URL の title（空白は `_`）で引く、title の URL の画面が送る要求。 */
const byTitle = (title: string) =>
  `/api/pages/by-title?title=${encodeURIComponent(title.replaceAll(" ", "_"))}`;

/** ページの JSON を引いた GET のパスとクエリを、開く前から集める。 */
function recordPageReads(page: Page): string[] {
  const reads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && PAGE_READ.test(url.pathname)) {
      reads.push(`${url.pathname}${url.search}`);
    }
  });
  return reads;
}

async function expectShown(page: Page, title: string, body: string): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(bodyEditor(page)).toContainText(body);
}

test.describe("匿名", () => {
  test.use({ role: "anonymous" });

  test("public のページは、title でも id でも、再読み込みでもページの JSON を引かない", async ({
    page,
    api,
  }, testInfo) => {
    const title = uniqueTitle(testInfo, "直接開く");
    const created = await api.createPage({ title, body: "埋め込みの本文", visibility: "public" });
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const reads = recordPageReads(page);

    for (const path of [titlePath(title), `/p/${created.id}`]) {
      await page.goto(path);
      await expectShown(page, title, "埋め込みの本文");
      await expect(page).toHaveURL(canonicalPath(title));
      await page.reload();
      await expectShown(page, title, "埋め込みの本文");
    }
    expect(reads).toEqual([]);
    // 実行しない script の JSON は CSP の script-src に当たらない
    expect(
      errors.filter((text) => /Content Security Policy|Content-Security-Policy/i.test(text)),
    ).toEqual([]);
  });

  test("draft のページは、直接開いても再読み込みでもページの JSON を引く", async ({
    page,
    api,
  }, testInfo) => {
    const title = uniqueTitle(testInfo, "下書きを開く");
    const created = await api.createPage({ title, body: "下書きの本文" });
    const reads = recordPageReads(page);
    await page.goto(`/p/${created.id}`);
    await expectShown(page, title, "下書きの本文");
    expect(reads).toEqual([`/api/pages/${created.id}`]);
    await page.reload();
    await expectShown(page, title, "下書きの本文");
    expect(reads).toEqual([`/api/pages/${created.id}`, `/api/pages/${created.id}`]);
  });

  test("SPA の中の移動で開いたページと、戻った最初のページはページの JSON を引く", async ({
    page,
    api,
  }, testInfo) => {
    const target = await api.createPage({
      title: uniqueTitle(testInfo, "リンク先"),
      body: "リンク先の本文",
      visibility: "public",
    });
    const start = await api.createPage({
      title: uniqueTitle(testInfo, "リンク元"),
      body: `[[${target.title}]]`,
      visibility: "public",
    });
    const reads = recordPageReads(page);
    await page.goto(titlePath(start.title));
    await expect(page.getByRole("heading", { level: 1, name: start.title })).toBeVisible();
    expect(reads).toEqual([]);

    await bodyEditor(page).getByText(target.title, { exact: true }).click();
    await expectShown(page, target.title, "リンク先の本文");
    // wikilink は title の URL へ移るので、title で引く
    await expect.poll(() => reads).toEqual([byTitle(target.title)]);

    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: start.title })).toBeVisible();
    await expect.poll(() => reads).toEqual([byTitle(target.title), byTitle(start.title)]);
  });
});

test("owner が public のページを直接開いて書いても、別の場所の保存との衝突を見逃さない", async ({
  page,
  api,
}, testInfo) => {
  const firstLine = "最初からある行";
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "直接開いて衝突"),
    body: firstLine,
    visibility: "public",
  });
  const reads = recordPageReads(page);
  await page.goto(titlePath(created.title));
  await expect(bodyEditor(page)).toHaveText(firstLine);
  await expect(saveState(page)).toHaveText("保存済み");
  // HTML に入っていた版で開いたことを確かめる。JSON を引いていれば、この試験は JSON の経路を見ている
  expect(reads).toEqual([]);

  const pagePath = `**/api/pages/${created.id}`;
  // 最初の保存を送る直前に、別の場所で書き換える（failures.spec.ts の衝突と同じ起こし方）
  let external: Promise<ApiPage> | undefined;
  await page.route(pagePath, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    external ??= api.updatePage(created, { body: `${firstLine}を別の場所で書き換えた` });
    const updated = await external.then(
      () => true,
      () => false,
    );
    return updated ? route.fallback() : route.abort();
  });
  await typeAtBodyEnd(page, "を手元で書き換えた");
  await expect.poll(() => external, "保存が送られない").toBeDefined();
  await external;
  const conflict = page.getByRole("alert").filter({
    has: page.getByRole("heading", { name: "別の場所でも更新されています" }),
  });
  await expect(conflict).toBeVisible();
  await expect(saveState(page)).toHaveText("別の場所でも更新あり");
  expect((await api.getPage(created.id)).body).toBe(`${firstLine}を別の場所で書き換えた`);
});
