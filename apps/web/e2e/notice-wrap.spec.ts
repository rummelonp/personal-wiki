import type { Locator, Page } from "@playwright/test";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";
import { lineTexts, midPhraseBreaks } from "./support/line-breaks";

/*
 * 通知の見出しと本文の折り返し。小さい仮名（ゃ、っ）、長音（ー）、句読点を行頭に置かない。
 * 行頭に来る文字は文字ごとの Range の位置で測る。幅を 150〜360px で振ると、WebKit の既定の禁則
 * （line-break: auto）では小さい仮名が行頭に来る幅が現れる。
 * 最初のテストは Notice を通さない HTML で禁則だけを測る。語の途中で折り返すかは、実際の通知を出す
 * 後ろのテストで測る。word-break: auto-phrase を解釈しない描画（iPhone の WebKit）では、Notice が
 * 文節の切れ目に <wbr> を置いて折り返しを決める。
 */

const TITLE = "ショートカットのキャンセルができませんでした";
const TEXT =
  "ちょっとしたシャッターを切ってください。ニュースのキャンセルはじゅうぶんにっこりしゃべりながら、きっちりぎゅっとゆっくりフェッチしたデータをコーヒーのようにリフレッシュします。";
const LINE_HEAD_PROHIBITED = "ゃゅょっぁぃぅぇぉゎャュョッァィゥェォヮー、。，．";

test("通知の見出しと本文は、どの幅でも小さい仮名、長音、句読点が行頭に来ない", async ({ page }) => {
  await page.goto("/");
  const violations = await page.evaluate(
    ({ title, text, prohibited }) => {
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;top:0;left:0;visibility:hidden";
      host.innerHTML = `<section class="notice notice-info"><h2 class="notice-title"><span class="dot"></span>${title}</h2><div class="notice-text"><p>${text}</p></div></section>`;
      document.body.append(host);
      const section = host.firstElementChild as HTMLElement;

      const lineHeads = (root: Element): string[] => {
        const heads: string[] = [];
        let top: number | null = null;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const data = (node as Text).data;
          for (let index = 0; index < data.length; index++) {
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            const rect = range.getBoundingClientRect();
            if (rect.width === 0) continue;
            const lineTop = Math.round(rect.top);
            if (top !== null && lineTop !== top) heads.push(data[index] as string);
            top = lineTop;
          }
        }
        return heads;
      };

      const found: string[] = [];
      for (let width = 150; width <= 360; width += 3) {
        section.style.width = `${width}px`;
        for (const selector of [".notice-title", ".notice-text"]) {
          const root = section.querySelector(selector) as Element;
          for (const head of lineHeads(root)) {
            if (prohibited.includes(head)) found.push(`${selector} ${width}px 「${head}」`);
          }
        }
      }
      host.remove();
      return found;
    },
    { title: TITLE, text: TEXT, prohibited: LINE_HEAD_PROHIBITED },
  );
  expect(violations).toEqual([]);
});

/**
 * 通知の見出し（と、あれば本文）が、句読点、空白、文節の切れ目でだけ折り返すか。
 * auto-phrase を解釈する描画は文節を自分で判定して切るので、この判定は解釈しない描画にだけ当てる。
 * wrapped の要素が実際に折り返していることも確かめる（折り返さない幅では何も測れていない）。
 */
async function expectBreaksOnlyAtPhrases(
  page: Page,
  notice: Locator,
  wrapped: ".notice-title" | ".notice-text",
): Promise<void> {
  test.skip(
    await page.evaluate(() => CSS.supports("word-break", "auto-phrase")),
    "auto-phrase を解釈する描画は文節で切る",
  );
  await expect(notice).toBeVisible();
  expect(
    (await lineTexts(notice.locator(wrapped))).length,
    `${wrapped} が折り返していないので測れていない`,
  ).toBeGreaterThan(1);
  for (const selector of [".notice-title", ".notice-text"]) {
    const part = notice.locator(selector);
    if ((await part.count()) === 0) continue;
    expect(await midPhraseBreaks(part), `${selector} が語の途中で折り返している`).toEqual([]);
  }
}

test("固定の文言の通知は、語の途中で折り返さない", async ({ page, api }, testInfo) => {
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "401 の折り返し"),
    body: "本文",
  });
  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page)).toContainText("本文");
  await expect(saveState(page)).toHaveText("保存済み");
  await page.route(`**/api/pages/${created.id}`, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "unauthorized" }),
        })
      : route.fallback(),
  );
  await bodyEditor(page).click();
  await page.keyboard.type("あ");
  const notice = page.getByRole("alert").filter({ hasText: "ログインの期限が切れました" });
  await expectBreaksOnlyAtPhrases(page, notice, ".notice-text");
});

test("部品の中の長い title は、幅を振っても行頭に禁則の文字が来ず、通知からあふれない", async ({
  page,
  api,
}, testInfo) => {
  // 区切りのない 25 字ほどの title。<wbr> を置けない部品（TakenGuide）の中で、keep-all を継ぐと切れ目が無くなる。
  // 大文字を含めるのは、小文字にした title で重複を起こすため
  const label = `キャンセルショートカットシャッタースキャナーABC${Math.random().toString(36).slice(2, 6)}`;
  const existing = await api.createPage({ title: label, body: "先" });
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "後から"),
    body: "後",
  });
  await page.goto(`/p/${created.id}`);
  await expect(saveState(page)).toHaveText("保存済み");
  await page.locator(".title-input .cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(existing.title.toLowerCase());
  await page.keyboard.press("Enter");
  const notice = page
    .getByRole("alert")
    .filter({ hasText: "同じタイトルのページがあるため、保存できません" });
  const text = notice.locator(".notice-text");
  await expect(text).toContainText(`「${existing.title}」と同じタイトルとみなします。`);

  const prohibited = `${LINE_HEAD_PROHIBITED}」』）】`;
  let wrapped = false;
  for (let width = 320; width <= 420; width += 10) {
    await page.setViewportSize({ width, height: 800 });
    const lines = await lineTexts(text);
    wrapped ||= lines.length > 1;
    const heads = lines.map((line) => line.slice(0, 1)).filter((head) => prohibited.includes(head));
    expect(heads, `${width}px で行頭に来た文字`).toEqual([]);
    const overflow = await notice.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow, `${width}px で通知の幅からあふれた量`).toBeLessThanOrEqual(0);
  }
  expect(wrapped, "本文が折り返していないので測れていない").toBe(true);
});

test("利用者の入力を含む通知も、語の途中で折り返さない", async ({ page, api }, testInfo) => {
  // title の URL にできる title は空のページへ移るので、予約語で始まる title で通知を出す
  const missing = `p/${uniqueTitle(testInfo, "公開設定の見直しを進めるための下書き")}`;
  const source = await api.createPage({
    title: uniqueTitle(testInfo, "リンク元の折り返し"),
    body: `[[${missing}]]`,
  });
  await page.goto(`/p/${source.id}`);
  await expect(saveState(page)).toHaveText("保存済み");
  await bodyEditor(page).locator(".cm-wikilink", { hasText: missing }).click();
  const notice = page
    .getByRole("alert")
    .filter({ hasText: `「${missing}」のページはまだありません` });
  await expectBreaksOnlyAtPhrases(page, notice, ".notice-title");
});
