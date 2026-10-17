import type { Page, Route } from "@playwright/test";
import {
  bodyEditor,
  expect,
  expectNoHorizontalScroll,
  test,
  typeAtBodyEnd,
  uniqueTitle,
} from "./support/fixtures";
import { SEED } from "./support/seed";

/*
 * 画面ごとに本文の左端がそろうこと。ヘッダーのロゴを基準に、一覧の行、ページの title と本文、
 * 読み込み中、404、空の状態の文字の左端が、3 つの幅で同じ x になることを測る。
 * 左端は最初の文字の箱（Range）で測る。要素の箱で測ると、編集欄の内側の padding の分がずれて見える。
 * 文字の無い読み込み中のスケルトンだけは、要素の箱の左端で測る。
 */

const WIDTHS = [375, 768, 1280];
const TOLERANCE = 0.75;

/** selector に一致する最初の要素の、最初の文字の左端。 */
async function textLeft(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if ((node.textContent ?? "").trim() === "") continue;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 1);
        return range.getBoundingClientRect().left;
      }
      throw new Error("文字が無い");
    });
}

/** selector に一致する最初の要素の、箱の左端。文字の無いスケルトンを測る。 */
async function boxLeft(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => element.getBoundingClientRect().left);
}

// 既定のサイト名は幅で正式な名前と短い名前を出し分けるので、見えている方を測る
const brandLeft = (page: Page) => textLeft(page, ".brand .brand-text:visible");

/*
 * 測り直しを待つ。起動時のスケルトンは画面ごとのスケルトンに差し替わるので、
 * 要素を見つけてから測るまでの間に外れると、外れた要素の箱（0）を測ってしまう。
 */
async function expectAligned(
  page: Page,
  selector: string,
  label: string,
  left: (page: Page, selector: string) => Promise<number> = textLeft,
): Promise<void> {
  const width = page.viewportSize()?.width;
  await expect
    .poll(async () => Math.abs((await left(page, selector)) - (await brandLeft(page))), {
      message: `${width}px の ${label}がロゴとずれている（値はロゴとの差）`,
    })
    .toBeLessThan(TOLERANCE);
}

/** レスポンスを release が呼ばれるまで止める。読み込み中の画面を捉える。 */
async function holdResponses(
  page: Page,
  match: (url: URL) => boolean,
): Promise<{ release: () => void }> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => match(url),
    async (route: Route) => {
      await gate;
      await route.continue().catch(() => {});
    },
  );
  return { release };
}

test.describe("本文の左端 @widths", () => {
  test("owner の一覧、ページ、404、空の状態", async ({ page, seedIds }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });

      await page.goto("/");
      await expect(page.locator(".entries .entry").first()).toBeVisible();
      await expectAligned(page, ".list-title", "一覧の見出し");
      await expectAligned(page, ".entries .entry-title", "一覧の行");

      await page.goto(`/p/${seedIds[SEED.server]}`);
      await expect(page.locator(".title-input")).toHaveText(SEED.server);
      await expectAligned(page, ".title-input .cm-line", "ページの title（編集）");
      await expectAligned(
        page,
        '.body-editor .cm-line:has-text("無料枠の上限")',
        "ページの本文（編集）",
      );

      // 空の /?new には文字が無い（入力すると保存でページができて URL が移る）ので、
      // title 欄を focus して、文字の位置に出るキャレットの左端で測る
      await page.goto("/?new");
      await page.locator(".title-input .cm-content").click();
      const caret = page.locator(".title-input .cm-cursor").first();
      await expect(caret).toBeVisible();
      const caretLeft = (await caret.boundingBox())?.x ?? Number.NaN;
      const brand = await brandLeft(page);
      expect(
        Math.abs(caretLeft - brand),
        `${width}px の新規作成の title（${caretLeft}）がロゴ（${brand}）とずれている`,
      ).toBeLessThan(TOLERANCE);

      await page.goto("/p/00000000-0000-0000-0000-000000000000");
      await expect(page.getByRole("heading", { name: "ページが見つかりません" })).toBeVisible();
      await expectAligned(page, ".empty-title", "404");

      await page.goto(
        "/?q=%E3%81%A9%E3%81%93%E3%81%AB%E3%82%82%E7%84%A1%E3%81%84%E8%AA%9E%E5%8F%A5",
      );
      await expect(page.locator(".empty-title")).toBeVisible();
      await expectAligned(page, ".empty-title", "検索 0 件");
    }
  });

  test("owner の読み込み中", async ({ page, seedIds }) => {
    // スケルトンは遅れて描く。描かれるまで（visible になるまで）待ってから、最初のスケルトンの箱の左端を測る
    const firstBand = page.locator(".main .skeleton").first();
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });

      const me = await holdResponses(page, (url) => url.pathname === "/api/me");
      await page.goto("/", { waitUntil: "commit" });
      await expect(firstBand).toBeVisible();
      await expectAligned(page, ".main .skeleton", "起動時の読み込み中", boxLeft);
      me.release();
      await page.unrouteAll({ behavior: "ignoreErrors" });

      await page.goto("/");
      await expect(page.locator(".entries .entry").first()).toBeVisible();
      const list = await holdResponses(page, (url) => url.pathname === "/api/search");
      await page.goto("/?q=x", { waitUntil: "commit" });
      await expect(firstBand).toBeVisible();
      await expectAligned(page, ".main .skeleton", "一覧の読み込み中", boxLeft);
      list.release();
      await page.unrouteAll({ behavior: "ignoreErrors" });

      const target = await holdResponses(
        page,
        (url) => url.pathname === `/api/pages/${seedIds[SEED.server]}`,
      );
      await page.goto(`/p/${seedIds[SEED.server]}`, { waitUntil: "commit" });
      await expect(firstBand).toBeVisible();
      await expectAligned(page, ".main .skeleton", "ページの読み込み中", boxLeft);
      target.release();
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });
});

test("短いページに通知のドックが出ても、横スクロールは出ず、欄の線はドックの上端まで引かれる", async ({
  page,
  api,
}, testInfo) => {
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "短いページ"),
    body: "短い本文",
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page)).toHaveText("短い本文");
  await page.route(`**/api/pages/${created.id}`, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "internal" }),
        })
      : route.fallback(),
  );
  await typeAtBodyEnd(page, "、打った");
  await expect(page.locator(".notice-dock").getByRole("alert")).toBeVisible();
  await expectNoHorizontalScroll(page);
  // ドックの高さの分だけ文書の末尾に余白が付くので縦には少しスクロールできるが、それ以上は伸びない。
  // ドックの高さの余白は .app の最低の高さに含まれるので、欄の線（rail）はドックの上端まで引かれる
  await page.evaluate(() => window.scrollTo(0, 0));
  const { overflow, railBottom, dockHeight } = await page.evaluate(() => {
    const root = document.documentElement;
    return {
      overflow: root.scrollHeight - root.clientHeight,
      railBottom: document.querySelector(".rail")?.getBoundingClientRect().bottom ?? 0,
      dockHeight: document.querySelector(".notice-dock")?.getBoundingClientRect().height ?? 0,
    };
  });
  expect(overflow, "ドックの高さより多く縦にスクロールできる").toBeLessThanOrEqual(dockHeight + 1);
  expect(railBottom, "欄の線がドックの上端まで届かない").toBeGreaterThanOrEqual(
    800 - dockHeight - 1,
  );
});

test.describe("匿名の本文の左端 @widths", () => {
  test.use({ role: "anonymous" });

  test("一覧、ページ、404、案内", async ({ page }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });

      await page.goto("/");
      await expect(page.locator(".entries .entry").first()).toBeVisible();
      await expectAligned(page, ".entries .entry-title", "一覧の行");

      await page.goto(`/${encodeURIComponent(SEED.welcome)}`);
      await expect(page.getByRole("heading", { level: 1, name: SEED.welcome })).toBeVisible();
      await expectAligned(page, ".note-title", "ページの title（閲覧）");
      await expectAligned(
        page,
        '.body-editor .cm-line:has-text("個人用のメモ置き場")',
        "ページの本文（閲覧）",
      );

      await page.goto(`/${encodeURIComponent("本当に存在しないページ")}`);
      await expect(
        page.getByRole("heading", { level: 1, name: "本当に存在しないページ" }),
      ).toBeVisible();
      await expectAligned(page, ".note-title", "空のページの title");

      await page.goto("/p/00000000-0000-0000-0000-000000000000");
      await expect(page.getByRole("heading", { name: "ページが見つかりません" })).toBeVisible();
      await expectAligned(page, ".empty-title", "404");

      await page.goto("/?q=ab");
      await expect(page.locator(".empty-title")).toBeVisible();
      await expectAligned(page, ".empty-title", "検索語が短いときの案内");
    }
  });
});
