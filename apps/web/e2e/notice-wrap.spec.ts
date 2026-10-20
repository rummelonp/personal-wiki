import type { Locator, Page, TestInfo } from "@playwright/test";
import type { OwnerApi } from "./support/api";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";
import {
  lineTexts,
  midPhraseBreaks,
  midPhraseBreaksAcrossWidths,
  misplacedWbrs,
  phraseSeams,
  wrapAcrossWidths,
} from "./support/line-breaks";

/*
 * 通知の見出しと本文の折り返し。小さい仮名（ゃ、っ）、長音（ー）、句読点を行頭に置かない。
 * 行頭に来る文字は文字ごとの Range の位置で測る。word-break: auto-phrase を解釈しない描画（iPhone の WebKit）では、
 * Notice が文節の切れ目に <wbr> を置いて折り返しを決めるので、<wbr> が文節の切れ目に置かれているかも測る。
 * 測る道具（support/line-breaks.ts）が語の途中の <wbr> を許さないことは、最初のテストで確かめる。
 */

const LINE_HEAD_PROHIBITED = "ゃゅょっぁぃぅぇぉゎャュョッァィゥェォヮー、。，．";

const isAutoPhraseRendering = (page: Page): Promise<boolean> =>
  page.evaluate(() => CSS.supports("word-break", "auto-phrase"));

test("測る道具は、語の途中の <wbr> と、閉じ括弧と助詞の間の折り返しを見つける", async ({
  page,
}) => {
  await page.goto("about:blank");
  const probe = page.locator("#probe");
  // 幅を振って、現れた折り返しの位置を集める（文字の幅は描画の font で変わるので、1 つの幅には頼らない）
  const breaksOf = async (html: string): Promise<{ breaks: string[]; misplaced: string[] }> => {
    await page.setContent(
      `<div id="probe" style="font:16px sans-serif;line-break:strict;word-break:keep-all">${html}</div>`,
    );
    const widths = Array.from({ length: 41 }, (_, index) => 40 + index * 4);
    return {
      breaks: await midPhraseBreaksAcrossWidths(probe, widths),
      misplaced: await misplacedWbrs(probe),
    };
  };

  const wellPlaced = await breaksOf("画像を<wbr>添付できませんでした");
  expect(wellPlaced.breaks, "文節の切れ目の <wbr> での折り返しを咎めている").toEqual([]);
  expect(wellPlaced.misplaced).toEqual([]);

  // 語の途中の <wbr> は、そこで折り返さない幅でも位置が誤りと分かる。折り返した幅では折り返しも咎める
  const compound = await breaksOf("書き<wbr>込めませんでした");
  expect(compound.misplaced).toEqual(["書き|込めま"]);
  expect(compound.breaks).toContain("き|込");
  expect((await breaksOf("届か<wbr>ないページ")).misplaced).toEqual(["届か|ないペ"]);
  expect((await breaksOf("読み込みを<wbr>ー覧にします")).misplaced).toEqual(["込みを|ー覧に"]);
  expect((await breaksOf("受け<wbr>付けました")).misplaced, "活用語尾で終わる語").toEqual([
    "受け|付けま",
  ]);
  expect((await breaksOf("変更　保存しました")).breaks, "全角の空白の後ろ").toEqual([]);
  expect((await breaksOf("開いたときは、<wbr>「保存」を押す")).misplaced, "開き括弧の手前").toEqual(
    [],
  );

  expect((await breaksOf("「公開設定」のページ")).breaks, "閉じ括弧と助詞の間").toContain("」|の");
  expect((await breaksOf("「公開設定」ページ")).breaks, "閉じ括弧の後ろの片仮名").not.toContain(
    "」|ペ",
  );
});

const NOTICE_PARTS = [".notice-title", ".notice-text"] as const;

/**
 * 通知の見出しと本文の <wbr> が、文節の切れ目だけにあるか。<wbr> が 1 つも無ければ、置いていないのか、
 * 置く必要が無い描画（auto-phrase を解釈する描画）なのか分からないので、解釈しない描画では wrapped に要る。
 */
async function expectWbrsAtPhraseSeams(
  notice: Locator,
  wrapped: (typeof NOTICE_PARTS)[number],
): Promise<void> {
  expect(
    (await phraseSeams(notice.locator(wrapped))).length,
    `${wrapped} に <wbr> が無い`,
  ).toBeGreaterThan(0);
  for (const selector of NOTICE_PARTS) {
    const part = notice.locator(selector);
    if ((await part.count()) === 0) continue;
    expect(await misplacedWbrs(part), `${selector} の <wbr> が文節の切れ目にない`).toEqual([]);
  }
}

/**
 * 本番の DOM の通知（Notice が <wbr> と .phrased を当てたもの）の見出しと本文が、幅を振っても行頭に禁則の文字が来ず、
 * 解釈しない描画では語の途中で折り返さず、<wbr> が文節の切れ目だけにあるか。
 * 1 行より長い文節は overflow-wrap: anywhere が禁則を無視して切るので、どの文節も 1 行に収まる幅だけを振る。
 */
async function expectWellWrappedAcrossWidths(
  page: Page,
  notice: Locator,
  widths: readonly number[],
  wrapped: (typeof NOTICE_PARTS)[number],
): Promise<void> {
  await expect(notice).toBeVisible();
  const section = page.locator(".notice").filter({ has: notice });
  const autoPhrase = await isAutoPhraseRendering(page);
  // 幅を変える（通知の枠）のは、中身を作り直さず折り返しだけを振るため。幅ごとに往復せず、1 回の evaluate で振る
  const results = await wrapAcrossWidths(section, NOTICE_PARTS, widths);
  let wrappedOnce = false;
  results.forEach((result, step) => {
    const width = widths[step] as number;
    expect(result.appliedWidth, `${width}px に変えられていない`).toBeCloseTo(width, 0);
    NOTICE_PARTS.forEach((selector, index) => {
      const part = result.parts[index];
      if (part === null || part === undefined) return;
      if (selector === wrapped) wrappedOnce ||= part.lineTexts.length > 1;
      const heads = part.lineTexts
        .map((line) => line.slice(0, 1))
        .filter((head) => `${LINE_HEAD_PROHIBITED}」』）】`.includes(head));
      expect(heads, `${selector} ${width}px で行頭に来た文字`).toEqual([]);
      if (!autoPhrase) {
        expect(part.midPhraseBreaks, `${selector} ${width}px で語の途中で折り返している`).toEqual(
          [],
        );
      }
    });
  });
  expect(wrappedOnce, `${wrapped} が折り返していないので測れていない`).toBe(true);
  if (!autoPhrase) await expectWbrsAtPhraseSeams(notice, wrapped);
}

/**
 * 通知の見出し（と、あれば本文）が、句読点、空白、文節の切れ目でだけ折り返すか。
 * auto-phrase を解釈する描画は文節を自分で判定して切るので、この判定は解釈しない描画にだけ当てる。
 * wrapped の要素が実際に折り返していることも確かめる（折り返さない幅では何も測れていない）。
 */
async function expectBreaksOnlyAtPhrases(
  page: Page,
  notice: Locator,
  wrapped: (typeof NOTICE_PARTS)[number],
): Promise<void> {
  test.skip(await isAutoPhraseRendering(page), "auto-phrase を解釈する描画は文節で切る");
  await expect(notice).toBeVisible();
  expect(
    (await lineTexts(notice.locator(wrapped))).length,
    `${wrapped} が折り返していないので測れていない`,
  ).toBeGreaterThan(1);
  for (const selector of NOTICE_PARTS) {
    const part = notice.locator(selector);
    if ((await part.count()) === 0) continue;
    expect(await midPhraseBreaks(part), `${selector} が語の途中で折り返している`).toEqual([]);
  }
  await expectWbrsAtPhraseSeams(notice, wrapped);
}

/** 保存が 401 で止まった通知（ログインの期限が切れました）を出す。 */
async function openAuthLostNotice(page: Page, api: OwnerApi, testInfo: TestInfo): Promise<Locator> {
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
  return page.getByRole("alert").filter({ hasText: "ログインの期限が切れました" });
}

/**
 * 本文の wikilink を押して、title の URL にできない title の「まだありません」の通知を出す。
 * title の URL にできる title は空のページへ移るので、予約語（p/）で始まる title を使う。
 */
async function openMissingLinkNotice(
  page: Page,
  api: OwnerApi,
  testInfo: TestInfo,
  userTitle: string,
): Promise<Locator> {
  const missing = `p/${userTitle}`;
  const source = await api.createPage({
    title: uniqueTitle(testInfo, "リンク元の折り返し"),
    body: `[[${missing}]]`,
  });
  await page.goto(`/p/${source.id}`);
  await expect(saveState(page)).toHaveText("保存済み");
  await bodyEditor(page).locator(".cm-wikilink", { hasText: missing }).click();
  return page.getByRole("alert").filter({ hasText: `「${missing}」のページはまだありません` });
}

test("固定の文言の通知は、語の途中で折り返さない", async ({ page, api }, testInfo) => {
  const notice = await openAuthLostNotice(page, api, testInfo);
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
  const notice = await openMissingLinkNotice(
    page,
    api,
    testInfo,
    uniqueTitle(testInfo, "公開設定の見直しを進めるための下書き"),
  );
  await expectBreaksOnlyAtPhrases(page, notice, ".notice-title");
});

// どの文節も 1 行に収まる幅。見出しは 16px で、最も長い文節（11 字ほど）に左右の余白と先頭の点を足した幅から
const WIDTHS = Array.from({ length: 36 }, (_, index) => 260 + index * 4);

test("利用者の入力を含む見出しは、本番の DOM でどの幅でも禁則を守り、文節の切れ目だけで折り返す", async ({
  page,
  api,
}, testInfo) => {
  // 小さい仮名と長音を含む片仮名の語を、助詞でつないだ title。閉じ括弧の直後の助詞は、行頭に離れてはならない
  const notice = await openMissingLinkNotice(
    page,
    api,
    testInfo,
    "ショートカットのキャンセルをニュースのシャッターでフェッチしたデータをコーヒーでリフレッシュ",
  );
  await expectWellWrappedAcrossWidths(page, notice, WIDTHS, ".notice-title");
  test.skip(await isAutoPhraseRendering(page), "auto-phrase を解釈する描画は <wbr> を置かない");
  const seams = await phraseSeams(notice.locator(".notice-title"));
  expect([(seams[0] as { before: string }).before, ...seams.map((seam) => seam.after)]).toEqual([
    "「p/ショートカットの",
    "キャンセルを",
    "ニュースの",
    "シャッターで",
    "フェッチしたデータを",
    "コーヒーで",
    "リフレッシュ」の",
    "ページはまだありません",
  ]);
});

test("固定の文言の本文は、本番の DOM でどの幅でも禁則を守り、文節の切れ目だけで折り返す", async ({
  page,
  api,
}, testInfo) => {
  const notice = await openAuthLostNotice(page, api, testInfo);
  await expectWellWrappedAcrossWidths(page, notice, WIDTHS, ".notice-text");
});
