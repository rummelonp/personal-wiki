import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalScroll, test } from "./support/fixtures";
import { SEED } from "./support/seed";

/*
 * 画面ごとに幅を切り替え、どの幅でも横スクロールが出ないことを確かめる。
 * iPhone 幅の WebKit そのものでの確認は、匿名のジャーニー（anonymous.spec.ts）が受け持つ。
 */

const WIDTHS = [320, 375, 768, 1280, 1440];
async function sweepWidths(page: Page, widths = WIDTHS): Promise<void> {
  for (const width of widths) {
    await test.step(`${width}px`, async () => {
      await page.setViewportSize({ width, height: 800 });
      await expectNoHorizontalScroll(page);
    });
  }
}

test.describe("owner @widths", () => {
  test("トップの一覧", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await sweepWidths(page);
  });

  test("検索の結果", async ({ page }) => {
    await page.goto(`/?q=${encodeURIComponent("メモ")}`);
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await sweepWidths(page);
  });

  for (const title of [SEED.server, SEED.database, SEED.longTitle, SEED.manyTags, SEED.longPage]) {
    test(`ページの編集: ${title}`, async ({ page, seedIds }) => {
      await page.goto(`/p/${seedIds[title]}`);
      await expect(page.locator(".title-input")).toHaveText(title);
      await sweepWidths(page);
    });
  }

  test("0 件の検索結果の「作成」は、長い検索語でも画面の幅に収まる", async ({ page }) => {
    const query = "どこにも無い語句をとても長く書いた検索語".repeat(3);
    await page.goto(`/?q=${encodeURIComponent(query)}`);
    const create = page.getByRole("button", { name: `「${query}」を作成` });
    await expect(create).toBeVisible();
    for (const width of [320, 375, 768, 1280]) {
      await test.step(`${width}px`, async () => {
        await page.setViewportSize({ width, height: 800 });
        const box = await create.boundingBox();
        expect(box?.x).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
        await expectNoHorizontalScroll(page);
      });
    }
  });

  test("新規作成の画面", async ({ page }) => {
    await page.goto("/?new");
    await expect(page.locator(".title-input .cm-content")).toBeVisible();
    await sweepWidths(page);
  });

  test("quick switcher を開いた画面", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "ページを検索" }).click();
    await page
      .getByRole("dialog", { name: "ページを検索" })
      .getByRole("combobox", { name: "検索語" })
      .fill("メモ");
    await expect(page.getByRole("option").first()).toBeVisible();
    await sweepWidths(page);
  });
});

test.describe("匿名 @widths", () => {
  test.use({ role: "anonymous" });

  for (const title of [SEED.welcome, SEED.longTitle, SEED.manyTags, SEED.longPage]) {
    test(`public のページ: ${title}`, async ({ page }) => {
      await page.goto(`/${encodeURIComponent(title)}`);
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await sweepWidths(page);
    });
  }

  test("長い検索語が header のボタンに出ても、header は 1 行のまま", async ({ page }) => {
    const longQuery = "とても長い検索語".repeat(8);
    await page.goto("/");
    const header = page.locator("header.header");
    await expect(header).toBeVisible();
    for (const width of [320, 375, 768, 1280]) {
      await test.step(`${width}px`, async () => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto("/");
        await expect(page.getByRole("button", { name: "ページを検索" })).toBeVisible();
        const plain = (await header.boundingBox())?.height;
        await page.goto(`/?q=${encodeURIComponent(longQuery)}`);
        const search = page.getByRole("button", {
          name: `ページを検索: ${longQuery}`,
          exact: true,
        });
        await expect(search).toBeVisible();
        expect((await header.boundingBox())?.height).toBe(plain);
        // 語は省略され、ボタンの外へ出ない
        const truncated = await search.evaluate((el) => {
          const text = el.querySelector<HTMLElement>(".header-search-text");
          return text !== null && text.clientWidth > 0 && text.scrollWidth > text.clientWidth;
        });
        expect(truncated).toBe(true);
        await expectNoHorizontalScroll(page);
      });
    }
  });

  test("存在しないページ", async ({ page }) => {
    // 匿名にはリンク元 0 件の節を出さないので、取得を終えたことはレスポンスで待つ
    const backlinks = page.waitForResponse((res) =>
      res.url().includes("/api/pages/by-title/backlinks"),
    );
    await page.goto(`/${encodeURIComponent("本当に存在しないページ")}`);
    await backlinks;
    await expect(
      page.getByRole("heading", { level: 1, name: "本当に存在しないページ" }),
    ).toBeVisible();
    await expect(page.locator(".rail")).toBeHidden();
    await sweepWidths(page);
  });
});

test.describe("owner", () => {
  /*
   * 開き括弧は字の左半分が空いている。1 行目の先頭に残ると、中央寄せの文字が右に寄って見える。
   * text-spacing-trim に対応する描画は空きを詰め、対応しない描画（Firefox など）は text-indent で戻す。
   * 描画によって通る側が違うので、詰め方ではなく、1 行目のインクの左右の余白がそろうことを測る。
   * 幅を指定するので iPhone の WebKit でも走る。
   */
  test("0 件の検索結果の「作成」は、折り返しても開き括弧の空きで右に寄らない", async ({ page }) => {
    const query = "どこにも無い語句をとても長く書いた検索語".repeat(3);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`/?q=${encodeURIComponent(query)}`);
    const create = page.getByRole("button", { name: `「${query}」を作成` });
    await expect(create).toBeVisible();
    // 結果が届くと描き直される。外れた要素を測ると計算済みの style が空で NaN になるので、測り直す
    await expect
      .poll(() =>
        create.evaluate((element) => {
          const text = element.firstChild as Text;
          const range = document.createRange();
          const rectOf = (index: number) => {
            range.setStart(text, index);
            range.setEnd(text, index + 1);
            return range.getBoundingClientRect();
          };
          const first = rectOf(0);
          let last = first;
          let lines = 1;
          for (let index = 1; index < (text.textContent ?? "").length; index += 1) {
            const rect = rectOf(index);
            if (rect.top > first.top + first.height / 2) {
              lines = 2;
              break;
            }
            last = rect;
          }
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          // 開き括弧のインクは字の右半分にあり、右端は送り幅の終わりと一致する。左端はそこから 0.5em 戻った位置
          const em = Number.parseFloat(style.fontSize);
          const inkLeft = first.left + first.width - 0.5 * em;
          // 折り返さないと 1 行目の最後の字が文末になり測りが変わるので、失敗する値に倒す。
          // 差は、直した描画で 0.05em 以下（字の送り幅の丸め）、直さないと 0.5em になる
          return lines === 2 ? Math.abs(inkLeft - box.left - (box.right - last.right)) / em : 99;
        }),
      )
      .toBeLessThan(0.15);
  });
});
