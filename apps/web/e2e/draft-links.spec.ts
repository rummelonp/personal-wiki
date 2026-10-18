import type { Page } from "@playwright/test";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";

/*
 * public のページから draft への link: 匿名には存在しないページへの link と同じ文字列に見えるので、
 * owner には公開のページの編集中に印を付け、公開の確認でリンク先の draft を並べる。
 * 匿名の側は、印が無いことに加えて、draft の id が応答とページのどこにも出ないことを確かめる。
 */

const pill = (page: Page) => page.locator(".visibility-pill");
const confirmDialog = (page: Page) => page.getByRole("dialog", { name: "公開の確認" });
/** title の右の印からメニューを開き、「公開」を選んで確認のダイアログを開く */
async function openPublishConfirm(page: Page) {
  await pill(page).click();
  await page.getByRole("menuitemradio", { name: "公開", exact: true }).click();
}
const link = (page: Page, text: string) =>
  bodyEditor(page).locator(".cm-wikilink", { hasText: text });
const badges = (page: Page) => bodyEditor(page).locator(".cm-wikilink-draft-badge");

test.describe("owner", () => {
  test("公開のページの編集中は、draft への link にだけ「下書き」の印が付く", async ({
    page,
    api,
  }, testInfo) => {
    const draft = await api.createPage({
      title: uniqueTitle(testInfo, "印の付く下書き"),
      body: "",
    });
    const published = await api.createPage({
      title: uniqueTitle(testInfo, "印の付かない公開"),
      body: "",
      visibility: "public",
    });
    const source = await api.createPage({
      title: uniqueTitle(testInfo, "下書きにリンクする公開"),
      // 先頭に文字を置き、開いた直後のカーソルが link の端に来ない（端なら記号を出して印を隠す）ようにする
      body: `前置き [[${draft.title}]] と [[${published.title}]] の後`,
      visibility: "public",
    });
    await page.goto(`/p/${source.id}`);

    await expect(link(page, draft.title)).toHaveAttribute("href", `/p/${draft.id}`);
    await expect(link(page, draft.title)).toHaveClass(/cm-wikilink-draft/);
    await expect(badges(page)).toHaveCount(1);
    await expect(badges(page)).toHaveText("下書き");
    // 印は色だけでなく文字で、link の直後に読まれる
    await expect(bodyEditor(page)).toContainText(`${draft.title}下書き と`);
    await expect(link(page, published.title)).not.toHaveClass(/cm-wikilink-draft/);
    // 本文は書き換えない
    expect((await api.getPage(source.id)).body).toBe(source.body);
  });

  test("draft のページでは印を付けず、公開の確認にリンク先の draft を並べ、公開すると印が付く", async ({
    page,
    api,
  }, testInfo) => {
    const first = await api.createPage({ title: uniqueTitle(testInfo, "先の下書き"), body: "" });
    const second = await api.createPage({ title: uniqueTitle(testInfo, "後の下書き"), body: "" });
    const published = await api.createPage({
      title: uniqueTitle(testInfo, "並ばない公開"),
      body: "",
      visibility: "public",
    });
    const self = await api.createPage({
      title: uniqueTitle(testInfo, "公開する下書き"),
      body: `前置き [[${first.title}]] と [[${published.title}]] と ![[${second.title}]] と [[${first.title}]]`,
    });
    await page.goto(`/p/${self.id}`);

    // href が付けば解決は済んでいるので、その後に印が無いことを見る
    await expect(link(page, first.title).first()).toHaveAttribute("href", `/p/${first.id}`);
    await expect(badges(page)).toHaveCount(0);

    await openPublishConfirm(page);
    const drafts = confirmDialog(page).locator(".publish-drafts");
    await expect(drafts).toContainText("本文から2件の下書きにリンクしています");
    const items = drafts.getByRole("link");
    await expect(items).toHaveText([first.title, second.title]);
    await expect(items.nth(0)).toHaveAttribute("href", `/p/${first.id}`);
    await expect(items.nth(1)).toHaveAttribute("href", `/p/${second.id}`);
    // 一覧は確定の操作を止めない
    const publish = confirmDialog(page).getByRole("button", { name: "公開する" });
    await expect(publish).toBeEnabled();

    await publish.click();
    await expect(pill(page)).toHaveAttribute("data-visibility", "public");
    // 本文の link は 2 つとも同じ draft を指すので、印も 2 つ。展開した embed のタイトルにも付く
    await expect(badges(page)).toHaveCount(3);
    const embed = bodyEditor(page).locator(`.cm-embed-page[data-embed-target="${second.title}"]`);
    await expect(embed).toHaveAttribute("data-embed-state", "resolved");
    await expect(embed.locator(".cm-embed-page-title .cm-wikilink-draft-badge")).toHaveText(
      "下書き",
    );
    await expect(embed.locator(".cm-wikilink-draft-badge")).toHaveCount(1);
    await expect(link(page, first.title)).toHaveCount(2);
    await expect(link(page, first.title).first()).toHaveClass(/cm-wikilink-draft/);
  });

  test("公開のページで展開した draft の embed のタイトルにも、「下書き」の印が付く", async ({
    page,
    api,
  }, testInfo) => {
    const draft = await api.createPage({
      title: uniqueTitle(testInfo, "展開される下書き"),
      body: "展開された本文",
    });
    const published = await api.createPage({
      title: uniqueTitle(testInfo, "展開される公開"),
      body: "公開の本文",
      visibility: "public",
    });
    const source = await api.createPage({
      title: uniqueTitle(testInfo, "下書きを展開する公開"),
      body: `前置き\n\n![[${draft.title}]]\n\n![[${published.title}]]\n\n後`,
      visibility: "public",
    });
    await page.goto(`/p/${source.id}`);

    const embedOf = (title: string) =>
      bodyEditor(page).locator(`.cm-embed-page[data-embed-target="${title}"]`);
    await expect(embedOf(draft.title)).toHaveAttribute("data-embed-state", "resolved");
    await expect(embedOf(published.title)).toHaveAttribute("data-embed-state", "resolved");
    const title = embedOf(draft.title).locator(".cm-embed-page-title");
    await expect(title.locator(".cm-wikilink-draft-badge")).toHaveText("下書き");
    await expect(title).toHaveText(`${draft.title}下書き`);
    await expect(embedOf(published.title).locator(".cm-wikilink-draft-badge")).toHaveCount(0);
    await expect(badges(page)).toHaveCount(1);
    // 本文は書き換えない
    expect((await api.getPage(source.id)).body).toBe(source.body);
  });

  test("公開の確認の一覧から、リンク先の draft を開ける", async ({ page, api }, testInfo) => {
    const draft = await api.createPage({
      title: uniqueTitle(testInfo, "一覧から開く下書き"),
      body: "",
    });
    const self = await api.createPage({
      title: uniqueTitle(testInfo, "一覧を出す下書き"),
      body: `前置き [[${draft.title}]]`,
    });
    await page.goto(`/p/${self.id}`);
    await expect(page.locator(".title-input")).toHaveText(self.title);

    await openPublishConfirm(page);
    await confirmDialog(page)
      .locator(".publish-drafts")
      .getByRole("link", { name: draft.title })
      .click();
    await expect(page).toHaveURL(`/p/${draft.id}`);
    await expect(page.locator(".title-input")).toHaveText(draft.title);
  });

  test("公開の確認の一覧は、行頭の記号と字下げを持たず、タッチ端末では行を 44px 以上にする", async ({
    page,
    api,
    isMobile,
  }, testInfo) => {
    const short = await api.createPage({ title: uniqueTitle(testInfo, "短い下書き"), body: "" });
    // 折り返す title。折り返した 1 件の中の行間と、件どうしの間を見分けられるかを見る
    const long = await api.createPage({
      title: uniqueTitle(
        testInfo,
        "とても長い名前の下書きページでスマートフォンの幅では折り返すことを確かめるための題名",
      ),
      body: "",
    });
    const self = await api.createPage({
      title: uniqueTitle(testInfo, "一覧の見た目を調べる下書き"),
      body: `前置き [[${long.title}]] と [[${short.title}]]`,
    });
    await page.goto(`/p/${self.id}`);
    await expect(page.locator(".title-input")).toHaveText(self.title);
    await openPublishConfirm(page);
    const drafts = confirmDialog(page).locator(".publish-drafts");
    await expect(drafts.getByRole("link")).toHaveCount(2);

    const rows = await drafts.locator("li").evaluateAll((items) => {
      const left = (element: Element) => element.getBoundingClientRect().left;
      const lead = document.querySelector(".publish-drafts > p");
      return items.map((item) => {
        const row = item.getBoundingClientRect();
        const anchor = item.querySelector("a");
        return {
          top: row.top,
          bottom: row.bottom,
          leadBottom: lead?.getBoundingClientRect().bottom ?? 0,
          lineHeight: Number.parseFloat(getComputedStyle(item).lineHeight),
          listStyleType: getComputedStyle(item).listStyleType,
          height: row.height,
          anchorHeight: anchor?.getBoundingClientRect().height ?? 0,
          // 説明の文と左端が揃う
          indent: left(item) - (lead === null ? 0 : left(lead)),
        };
      });
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.listStyleType).toBe("none");
      expect(row.indent).toBe(0);
    }
    if (!isMobile) {
      const [wrapped, next] = rows;
      if (wrapped === undefined || next === undefined) throw new Error("行が 2 つ無い");
      expect(wrapped.height, "折り返した件").toBeGreaterThan(wrapped.lineHeight * 1.5);
      // 件どうしの間は、説明の文と一覧の間より狭く、0 より広い（1 件の中の行間と同じだと別の件に見える）
      const between = next.top - wrapped.bottom;
      expect(between).toBeGreaterThan(0);
      expect(wrapped.top - wrapped.leadBottom).toBeGreaterThan(between);
    }
    if (isMobile) {
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      // 計算で 44px ちょうどにした箱の端数を許す
      for (const row of rows) {
        expect(row.height).toBeGreaterThanOrEqual(43.9);
        expect(row.anchorHeight).toBeGreaterThanOrEqual(43.9);
      }
      // 行の高さはリンクが決め、リンクの外に押せない余白が出ない
      expect(rows[0]?.height).toBeCloseTo(rows[0]?.anchorHeight ?? 0, 1);
      // 44px の行が件の間を作るので、余白は足さない
      expect((rows[1]?.top ?? 0) - (rows[0]?.bottom ?? 0)).toBeCloseTo(0, 1);
    }
  });

  test("draft へのリンクが無ければ、公開の確認に一覧を出さない", async ({
    page,
    api,
  }, testInfo) => {
    const published = await api.createPage({
      title: uniqueTitle(testInfo, "リンク先の公開"),
      body: "",
      visibility: "public",
    });
    const self = await api.createPage({
      title: uniqueTitle(testInfo, "一覧の無い下書き"),
      body: `前置き [[${published.title}]] と [[まだ無いページ]]`,
    });
    await page.goto(`/p/${self.id}`);
    await expect(link(page, published.title)).toHaveAttribute("href", /^\//);

    // 編集画面の分は解決済みなので、確認を開いた後の問い合わせは一覧のもの。その応答を待ってから空を見る
    const listed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/pages/resolve",
    );
    await openPublishConfirm(page);
    await listed;
    await expect(confirmDialog(page).locator(".publish-drafts")).toBeEmpty();
    await expect(confirmDialog(page)).not.toContainText("下書きにリンク");
  });

  test("保存前の本文に書いた draft への link も、公開の確認に並べる", async ({
    page,
    api,
  }, testInfo) => {
    const draft = await api.createPage({
      title: uniqueTitle(testInfo, "保存前にリンクした下書き"),
      body: "",
    });
    const self = await api.createPage({
      title: uniqueTitle(testInfo, "まだ保存していない下書き"),
      body: "前置き",
    });
    // 保存を止めておき、確認を開いた時点でサーバーの本文に link が無いようにする
    let releaseSaves: () => void = () => {};
    const saves = new Promise<void>((resolve) => {
      releaseSaves = resolve;
    });
    await page.route(`**/api/pages/${self.id}`, async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      await saves;
      return route.fallback();
    });
    await page.goto(`/p/${self.id}`);
    await expect(bodyEditor(page)).toHaveText("前置き");

    await bodyEditor(page).locator(".cm-line").last().click();
    await page.keyboard.press("End");
    // 1 字ずつ打つと括弧の補完と候補の窓が働くので、まとめて入れる
    await page.keyboard.insertText(` [[${draft.title}]]`);
    await openPublishConfirm(page);
    const drafts = confirmDialog(page).locator(".publish-drafts");
    await expect(drafts.getByRole("link")).toHaveText([draft.title]);
    expect((await api.getPage(self.id)).body).toBe("前置き");

    releaseSaves();
    await confirmDialog(page).getByRole("button", { name: "やめる" }).click();
    await expect(saveState(page)).toHaveText("保存済み");
    expect((await api.getPage(self.id)).body).toBe(`前置き [[${draft.title}]]`);
  });

  test("自分への link には、公開した直後も印を出さない", async ({ page, api }, testInfo) => {
    const title = uniqueTitle(testInfo, "自分にリンクする下書き");
    const self = await api.createPage({ title, body: `前置き [[${title}]] の後` });
    await page.goto(`/p/${self.id}`);
    await expect(link(page, title)).toHaveAttribute("href", `/p/${self.id}`);

    // 公開した後の取り直しが済むまでの間に一瞬だけ出る印も拾うため、件数ではなく DOM への追加を見張る
    await page.evaluate(() => {
      const flags = window as unknown as { badgeAppeared: boolean };
      flags.badgeAppeared = false;
      // title の欄も CodeMirror なので、本文の側を名前で選ぶ
      const content = document.querySelector('.cm-content[aria-label="本文"]');
      if (content === null) throw new Error("本文が無い");
      // 足して同じ task のうちに外した印は、callback の時点の DOM には残らないので、記録の側を見る
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (
              node instanceof Element &&
              (node.matches(".cm-wikilink-draft-badge") ||
                node.querySelector(".cm-wikilink-draft-badge") !== null)
            ) {
              flags.badgeAppeared = true;
            }
          }
        }
      }).observe(content, { childList: true, subtree: true });
    });
    await openPublishConfirm(page);
    await confirmDialog(page).getByRole("button", { name: "公開する" }).click();
    await expect(pill(page)).toHaveAttribute("data-visibility", "public");
    // href が title の URL に変われば、公開した後の取り直しは済んでいる
    await expect(link(page, title)).not.toHaveAttribute("href", /^\/p\//);
    await expect(link(page, title)).toHaveAttribute("href", /^\//);
    expect(
      await page.evaluate(() => (window as unknown as { badgeAppeared: boolean }).badgeAppeared),
    ).toBe(false);
  });
});

test.describe("anonymous", () => {
  test.use({ role: "anonymous" });

  test("public のページの draft への link は文字列のままで、draft の id が応答とページに出ない", async ({
    page,
    api,
  }, testInfo) => {
    const draft = await api.createPage({
      title: uniqueTitle(testInfo, "匿名に見せない下書き"),
      body: "",
    });
    const self = await api.createPage({
      title: uniqueTitle(testInfo, "匿名が読む公開"),
      body: `前置き [[${draft.title}]] の後`,
      visibility: "public",
    });

    const bodies: Promise<string>[] = [];
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.startsWith("/api/")) {
        bodies.push(response.text().catch(() => ""));
      }
    });
    const resolved = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/pages/resolve",
    );
    await page.goto(`/p/${self.id}`);
    await expect(page.getByRole("heading", { level: 1, name: self.title })).toBeVisible();
    await resolved;

    const target = link(page, draft.title);
    await expect(target).toHaveClass(/cm-wikilink-unresolved/);
    await expect(target).not.toHaveAttribute("href");
    await expect(bodyEditor(page).locator("a.cm-wikilink")).toHaveCount(0);
    await expect(badges(page)).toHaveCount(0);

    const responses = await Promise.all(bodies);
    expect(responses.length).toBeGreaterThan(0);
    for (const body of responses) expect(body).not.toContain(draft.id);
    expect(await page.content()).not.toContain(draft.id);
  });
});
