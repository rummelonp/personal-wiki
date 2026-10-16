import type { Page } from "@playwright/test";
import type { ApiPage, OwnerApi } from "./support/api";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";

/*
 * 失敗の通知から衝突に移る流れと、title も違う衝突の差分の欄。
 */

const LINES = Array.from({ length: 60 }, (_, index) => `${index + 1} 行目の本文`);
const BODY = LINES.join("\n");

async function openLongPage(page: Page, api: OwnerApi, title: string): Promise<ApiPage> {
  const created = await api.createPage({ title, body: BODY });
  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page)).toContainText("1 行目の本文");
  await expect(saveState(page)).toHaveText("保存済み");
  return created;
}

async function typeAt(page: Page, lineIndex: number, text: string): Promise<void> {
  await bodyEditor(page).locator(".cm-line").nth(lineIndex).click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

const CONFLICT_HEADING = "別の場所でも更新されています";

test("失敗の通知からマウスで再試行して衝突になっても、見出しに focus の枠を出さない", async ({
  page,
  api,
}, testInfo) => {
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "枠なし"));
  const pagePath = `**/api/pages/${created.id}`;
  await page.route(pagePath, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"x"}' })
      : route.fallback(),
  );
  await typeAt(page, 0, "、手元の変更");
  const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
  await expect(alert).toBeVisible();
  await page.unroute(pagePath);
  await api.updatePage(created, { body: `${BODY}\n別の場所で足した行` });

  await alert.getByRole("button", { name: "もう一度保存する" }).click();
  const heading = page.getByRole("heading", { name: CONFLICT_HEADING });
  await expect(heading).toBeFocused();
  expect(await heading.evaluate((element) => element.matches(":focus-visible"))).toBe(false);
  expect(await heading.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
});

test("失敗の通知からキーボードで再試行して衝突になったときは、見出しに focus の枠で示す", async ({
  page,
  api,
  isMobile,
}, testInfo) => {
  // タッチ端末の WebKit は、keyboard で移した focus にも枠を付けない
  test.skip(isMobile, "デスクトップの keyboard の操作を測る");
  const created = await openLongPage(page, api, uniqueTitle(testInfo, "枠あり"));
  const pagePath = `**/api/pages/${created.id}`;
  await page.route(pagePath, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"x"}' })
      : route.fallback(),
  );
  await typeAt(page, 0, "、手元の変更");
  const alert = page.getByRole("alert").filter({ hasText: "保存できませんでした" });
  await expect(alert).toBeVisible();
  await page.unroute(pagePath);
  await api.updatePage(created, { body: `${BODY}\n別の場所で足した行` });

  await alert.getByRole("button", { name: "もう一度保存する" }).focus();
  await page.keyboard.press("Enter");
  const heading = page.getByRole("heading", { name: CONFLICT_HEADING });
  await expect(heading).toBeFocused();
  expect(await heading.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
});

const VIEWPORTS = [
  { name: "高さ 667", width: 375, height: 667, rows: 2 },
  // 低い画面は、title の知らせの分だけ欄が狭い。変更の行 1 行は見せる
  { name: "高さ 500", width: 375, height: 500, rows: 1 },
];

for (const viewport of VIEWPORTS) {
  test(`title も違う長い差分の衝突でも、${viewport.name} の最初の表示で差分の欄が ${viewport.rows} 行以上残り、title も違うと分かる`, async ({
    page,
    api,
    isMobile,
  }, testInfo) => {
    // モバイルの環境は端末の大きさが決まっているので、高さの違う変種は流さない
    test.skip(isMobile && viewport.height !== 667, "デスクトップの高さを変えて測る");
    if (!isMobile) await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const created = await openLongPage(page, api, uniqueTitle(testInfo, "title も違う"));
    const pagePath = `**/api/pages/${created.id}`;
    let external: Promise<ApiPage> | undefined;
    await page.route(pagePath, async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      external ??= api.updatePage(created, {
        // 2 行で切る欄に収まる長さにする。uniqueTitle の乱数で 1 行の幅が変わるので、境界の近くに置くと折り返しが揺れる
        title: `${created.title}を別で直した`,
        body: LINES.map((line, index) =>
          index % 7 === 3 ? `${line}を別の場所で直した` : line,
        ).join("\n"),
      });
      const updated = await external.then(
        () => true,
        () => false,
      );
      return updated ? route.fallback() : route.abort();
    });
    await typeAt(page, 30, "、手元の変更");
    await expect.poll(() => external, "保存が送られない").toBeDefined();
    await external;
    const conflict = page.getByRole("alert").filter({
      has: page.getByRole("heading", { name: CONFLICT_HEADING }),
    });
    await expect(conflict).toBeVisible();
    const notice = page.locator(".notice").filter({ has: conflict });
    await expect(notice.locator(".conflict-titles")).toBeAttached();

    const measured = await notice.evaluate((element) => {
      const details = element.querySelector(".notice-details") as HTMLElement;
      const pane = details.getBoundingClientRect();
      const inside = (target: Element | null, outer: DOMRect) => {
        if (target === null) return false;
        const box = target.getBoundingClientRect();
        return box.height > 0 && box.top >= outer.top - 0.5 && box.bottom <= outer.bottom + 0.5;
      };
      const rowHeight = (details.querySelector(".diff-row") as HTMLElement).getBoundingClientRect()
        .height;
      const outer = element.getBoundingClientRect();
      const hint = element.querySelector(".conflict-hint") as HTMLElement;
      const hintLine = Number.parseFloat(getComputedStyle(hint).lineHeight);
      // 省略や行の切り捨ては要素の大きさに現れないので、最後の文字そのものが見えているかを測る
      const title = hint.lastChild as Text;
      const lastChar = document.createRange();
      lastChar.setStart(title, title.length - 1);
      lastChar.setEnd(title, title.length);
      const end = lastChar.getBoundingClientRect();
      const box = hint.getBoundingClientRect();
      return {
        room: details.clientHeight,
        rowHeight,
        firstInPane: inside(details.querySelector(".diff-delete"), pane),
        titlesInPane: inside(details.querySelector(".conflict-titles"), pane),
        hintInNotice: inside(element.querySelector(".conflict-hint"), outer),
        hintOutsidePane: !details.contains(element.querySelector(".conflict-hint")),
        noticeInViewport: outer.top >= -0.5 && outer.bottom <= window.innerHeight + 0.5,
        noticeFitsWidth: element.scrollWidth <= element.clientWidth,
        hintWhole: end.right <= box.right + 0.5 && end.bottom <= box.bottom + 0.5,
        hintLines: Math.round(hint.clientHeight / hintLine),
      };
    });
    expect(measured.room, "差分の欄が足りない").toBeGreaterThanOrEqual(
      measured.rowHeight * viewport.rows,
    );
    expect(measured.firstInPane, "最初の変更の行が欄からはみ出している").toBe(true);
    expect(measured.noticeInViewport, "通知が画面からはみ出している").toBe(true);
    expect(measured.noticeFitsWidth, "長い title が通知の幅を押し広げている").toBe(true);
    // この長さの title は末尾まで読める。末尾だけ違う title を省略すると見分けられない
    expect(measured.hintWhole, "サーバーの title の末尾が切れている").toBe(true);
    expect(
      measured.hintLines,
      "サーバーの title が 2 行を超えて欄を狭めている",
    ).toBeLessThanOrEqual(2);
    // 比較が欄の先頭に見えていなくても、欄の外の手がかりで title が違うと分かる
    expect(
      measured.titlesInPane || (measured.hintInNotice && measured.hintOutsidePane),
      "title も違うと分かるものが最初の表示に見えていない",
    ).toBe(true);
  });
}
