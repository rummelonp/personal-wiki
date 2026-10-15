import type { Page } from "@playwright/test";
import { expect, test, uniqueTitle } from "./support/fixtures";
import { SEED } from "./support/seed";

/* 探して開く流れ: 一覧、quick switcher、検索、タグ、backlink。 */

const entryLink = (title: string) => ({ name: title, exact: true });

test("トップの一覧から開ける @smoke", async ({ page, api }, testInfo) => {
  // 他のテストが draft を作り続けると seed の公開ページが先頭から外れるので、公開の行を自分で作る
  await api.createPage({
    title: uniqueTitle(testInfo, "公開の印"),
    body: "本文",
    visibility: "public",
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "最近の更新" })).toBeVisible();
  // 並列に走る他のテストがページを作り、先頭に来るページが変わるので、どのページかは決め打ちしない。
  // owner の一覧では公開の行にだけ印が付き、draft（作られたばかりのページ）には付かない。
  await expect(page.locator(".entries .chip-public").first()).toBeVisible();
  await expect(page.locator(".entries .entry:not(:has(.chip-public))").first()).toBeVisible();
  const first = page.locator(".entries .entry-title").first();
  const title = (await first.textContent()) ?? "";
  expect(title).not.toBe("");
  await first.click();
  await expect(page.locator(".title-input")).toHaveText(title);
});

test("quick switcher で title の一部から開ける", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "ページを検索" }).click();
  const switcher = page.getByRole("dialog", { name: "ページを検索" });
  await switcher.getByRole("combobox", { name: "ページを検索" }).fill("データベース");
  await switcher.getByRole("option", { name: SEED.database }).click();
  await expect(switcher).toBeHidden();
  await expect(page.locator(".title-input")).toHaveText(SEED.database);
});

test("quick switcher から本文を検索し、結果から開ける", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "ページを検索" }).click();
  const switcher = page.getByRole("dialog", { name: "ページを検索" });
  await switcher.getByRole("combobox", { name: "ページを検索" }).fill("無料枠");
  await switcher.getByRole("option", { name: "「無料枠」を本文から検索" }).click();
  await expect(page).toHaveURL(/\/\?q=/);
  await expect(page.getByRole("heading", { name: "「無料枠」の検索結果" })).toBeVisible();
  await page.locator(".entries").getByRole("link", entryLink(SEED.server)).click();
  await expect(page.locator(".title-input")).toHaveText(SEED.server);
});

/** title がこのとおりのページがあるか。 */
async function pageExists(page: Page, title: string): Promise<boolean> {
  const res = await page.request.get(`/api/pages/by-title?title=${encodeURIComponent(title)}`);
  return res.status() === 200;
}

async function openSwitcherAndType(page: Page, text: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "ページを検索" }).click();
  const switcher = page.getByRole("dialog", { name: "ページを検索" });
  const input = switcher.getByRole("combobox", { name: "ページを検索" });
  await input.fill(text);
  return { switcher, input };
}

test("quick switcher で語を打って Enter しても、ページは作られず本文の検索になる @smoke", async ({
  page,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "Enter で作らない");
  const { switcher, input } = await openSwitcherAndType(page, title);
  // 既定の行は「本文から検索」。作成は選ばれていない
  await expect(switcher.getByRole("option", { selected: true })).toHaveText(
    `「${title}」を本文から検索`,
  );
  await input.press("Enter");
  await expect(page).toHaveURL(/\/\?q=/);
  await expect(page.getByRole("heading", { name: `「${title}」の検索結果` })).toBeVisible();
  expect(await pageExists(page, title)).toBe(false);
});

test("0 件の検索結果から、検索語の title で作れる", async ({ page }, testInfo) => {
  const title = uniqueTitle(testInfo, "0 件から作る");
  await page.goto(`/?q=${encodeURIComponent(title)}`);
  await expect(page.getByRole("heading", { name: "一致するページがありません" })).toBeVisible();
  expect(await pageExists(page, title)).toBe(false);
  await page.getByRole("button", { name: `「${title}」を作成` }).click();
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  await expect(page.locator(".title-input")).toHaveText(title);
  expect(await pageExists(page, title)).toBe(true);
});

test("title が完全に一致する語で Enter すると、そのページを開く", async ({ page }) => {
  const { switcher, input } = await openSwitcherAndType(page, SEED.database);
  // title の一覧を取り終える前の Enter は、完全一致を知らないので本文の検索になる
  await expect(switcher.getByRole("option", { name: SEED.database, exact: true })).toBeVisible();
  await input.press("Enter");
  await expect(page.locator(".title-input")).toHaveText(SEED.database);
});

test("quick switcher で ↓ を押して「作成」を選べば、キーボードだけで作れる", async ({
  page,
}, testInfo) => {
  const title = uniqueTitle(testInfo, "矢印で作る");
  const { switcher, input } = await openSwitcherAndType(page, title);
  // 「作成」は title の一覧を取り終えてから並ぶ。その前に ↓ を押すと選択が動かない
  await expect(switcher.getByRole("option", { name: `「${title}」を作成` })).toBeVisible();
  await input.press("ArrowDown");
  await expect(switcher.getByRole("option", { selected: true })).toHaveText(`「${title}」を作成`);
  await input.press("Enter");
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  await expect(page.locator(".title-input")).toHaveText(title);
  expect(await pageExists(page, title)).toBe(true);
});

test("title の一覧を取れないときの quick switcher は、「作成」を出さず失敗を案内し、取れたら戻る", async ({
  page,
}) => {
  const titles = "**/api/pages/titles*";
  await page.route(titles, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "internal" }),
    }),
  );
  // 既にあるページの title を打つ。取れていないだけなのに「作成」を勧めてはならない
  const { switcher, input } = await openSwitcherAndType(page, SEED.database);
  await expect(switcher.getByRole("status")).toContainText("候補を取得できません。");
  await expect(switcher.getByRole("option", { name: /を作成$/ })).toHaveCount(0);
  await expect(switcher.getByRole("option", { selected: true })).toHaveText(
    `「${SEED.database}」を本文から検索`,
  );

  await page.unroute(titles);
  await input.press("Escape");
  await expect(switcher).toBeHidden();
  await page.getByRole("button", { name: "ページを検索" }).click();
  await input.fill(SEED.database);
  await expect(switcher.getByRole("option", { name: SEED.database, exact: true })).toBeVisible();
  await expect(switcher.getByText("候補を取得できません。")).toHaveCount(0);
});

test("quick switcher の失敗の案内は、幅 375 でも 1 行に収まり、下の余白が上より広がらない", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.route("**/api/pages/titles*", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "internal" }),
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "ページを検索" }).click();
  const switcher = page.getByRole("dialog", { name: "ページを検索" });
  const note = switcher.getByText("候補を取得できません。");
  await expect(note).toBeVisible();
  const metrics = await switcher.evaluate((dialog) => {
    const note = dialog.querySelector(".switcher-alert") as HTMLElement;
    const input = dialog.querySelector(".switcher-input") as HTMLElement;
    const body = dialog.querySelector(".switcher-body") as HTMLElement;
    // 1 文字だけの同じ要素の高さが 1 行の高さ
    const probe = note.cloneNode(false) as HTMLElement;
    probe.textContent = "あ";
    note.after(probe);
    const lineHeight = probe.getBoundingClientRect().height;
    probe.remove();
    const noteBox = note.getBoundingClientRect();
    return {
      lines: Math.round(noteBox.height / lineHeight),
      above: noteBox.top - input.getBoundingClientRect().bottom,
      below: dialog.getBoundingClientRect().bottom - noteBox.bottom,
      // dialog の枠の下の線も、下の余白に入る
      padding:
        Number.parseFloat(getComputedStyle(body).paddingBottom) +
        Number.parseFloat(getComputedStyle(dialog).borderBottomWidth),
    };
  });
  expect(metrics.lines).toBe(1);
  // 下は body の padding だけ。空の listbox の gap を足さない
  expect(metrics.below).toBeCloseTo(metrics.padding, 0);
  expect(metrics.below).toBeLessThanOrEqual(metrics.above + metrics.padding);
});

test("一致しない検索は 0 件の案内を出す", async ({ page }) => {
  await page.goto(`/?q=${encodeURIComponent("どこにも無い語句")}`);
  await expect(page.getByRole("heading", { name: "一致するページがありません" })).toBeVisible();
});

test("検索結果の見出しは、開き括弧の行頭の空きを詰める", async ({ page }) => {
  await page.goto(`/?q=${encodeURIComponent("メモ")}`);
  const heading = page.getByRole("heading", { level: 1, name: "「メモ」の検索結果" });
  await expect(heading).toBeVisible();
  const { next, size } = await heading.evaluate((element) => {
    const text = element.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const style = getComputedStyle(element);
    const contentLeft = element.getBoundingClientRect().left + Number.parseFloat(style.paddingLeft);
    return {
      // 2 字目が始まる位置。text-spacing-trim で詰めても、字下げを戻しても、ここが半角分になる
      next: range.getBoundingClientRect().right - contentLeft,
      size: Number.parseFloat(style.fontSize),
    };
  });
  // 詰めないと全角の 1 字分（字の大きさ）の幅を取る
  expect(next).toBeLessThan(size * 0.75);
});

test("検索結果の title と抜粋で、一致箇所に同じ規則の強調が付く", async ({
  page,
  api,
}, testInfo) => {
  const word = uniqueTitle(testInfo, "強調");
  await api.createPage({ title: word, body: `前の文 ${word} 後の文` });
  await page.goto(`/?q=${encodeURIComponent(word)}`);
  const row = page.locator(".entries .entry", { hasText: word }).first();
  const titleMark = row.locator(".entry-title mark");
  const excerptMark = row.locator(".entry-excerpt mark");
  await expect(titleMark).toHaveText(word);
  await expect(excerptMark).toHaveText(word);
  const styleOf = (mark: typeof titleMark) =>
    mark.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        color: style.color,
        background: style.backgroundColor,
        radius: style.borderRadius,
        // 周りの文字より太くしない（最初から太い title だけ強調が弱く見えるため）
        weightChanged:
          style.fontWeight !== getComputedStyle(element.parentElement as Element).fontWeight,
      };
    });
  const title = await styleOf(titleMark);
  expect(title).toEqual(await styleOf(excerptMark));
  expect(title.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(title.weightChanged).toBe(false);
});

test("タグで絞り込める", async ({ page }) => {
  await page.goto("/");
  await page
    .locator(".rail .chip-link")
    .filter({ hasText: /^database\d+$/ })
    .click();
  await expect(page.getByRole("heading", { name: "タグ「database」" })).toBeVisible();
  const entries = page.locator(".entries .entry");
  await expect(entries).toHaveCount(1);
  await expect(entries.getByRole("link", entryLink(SEED.database))).toBeVisible();
});

test("backlink から参照元へ移れる", async ({ page, seedIds }) => {
  await page.goto(`/p/${seedIds[SEED.database]}`);
  const links = page.locator(".rail-section-links");
  // owner には draft の参照元も出る
  await expect(links.getByRole("link", entryLink(SEED.draftSecret))).toBeVisible();
  await links.getByRole("link", entryLink(SEED.server)).click();
  await expect(page.locator(".title-input")).toHaveText(SEED.server);
});
