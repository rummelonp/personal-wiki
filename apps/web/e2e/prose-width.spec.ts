import type { Page } from "@playwright/test";
import {
  bodyEditor,
  expect,
  expectNoHorizontalScroll,
  test,
  uniqueTitle,
} from "./support/fixtures";

/*
 * 本文の幅と行間。本文はエディタの 16px で、全角 44 字（704px）に行の左右の padding（8px）を足した
 * 712px の箱に収まり、行間は 1.8（28.8px）になる。広い幅では本文と右の欄が並んで画面に収まり、
 * 狭い幅では本文の幅が右の欄と余白の残りに縮む。
 */

const NOTE_WIDTH = 712;
const LINE_HEIGHT = 28.8;
const FULLWIDTH = "あ";

interface Geometry {
  noteWidth: number;
  noteRight: number;
  railLeft: number;
  railRight: number;
  clientWidth: number;
  lineHeight: number;
}

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const note = (document.querySelector(".note") as HTMLElement).getBoundingClientRect();
    const rail = (document.querySelector(".rail") as HTMLElement).getBoundingClientRect();
    const content = document.querySelector('.cm-content[aria-label="本文"]') as HTMLElement;
    return {
      noteWidth: note.width,
      noteRight: note.right,
      railLeft: rail.left,
      railRight: rail.right,
      clientWidth: document.documentElement.clientWidth,
      lineHeight: Number.parseFloat(getComputedStyle(content).lineHeight),
    };
  });
}

/** 1 つの行（.cm-line）が何行に折り返されたか。 */
async function rowsOf(page: Page, text: string): Promise<number> {
  return bodyEditor(page)
    .locator(".cm-line", { hasText: text })
    .evaluate((line) => {
      const tops: number[] = [];
      const range = document.createRange();
      range.selectNodeContents(line);
      for (const rect of range.getClientRects()) {
        if (!tops.some((top) => Math.abs(top - rect.top) <= 2)) tops.push(rect.top);
      }
      return tops.length;
    });
}

test("広い幅では、本文が 712px で全角 44 字、行間 1.8 で、右の欄と並んで画面に収まる @widths", async ({
  page,
  api,
}, testInfo) => {
  // 先頭の字を変えて、2 つの行を hasText で見分ける
  const fits = `ア${FULLWIDTH.repeat(43)}`;
  const wraps = `イ${FULLWIDTH.repeat(44)}`;
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "本文の幅"),
    body: `${fits}\n\n${wraps}`,
  });
  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page).locator(".cm-line").first()).toHaveText(fits);

  for (const width of [1024, 1280, 1600]) {
    await test.step(`${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      const box = await geometry(page);
      expect(box.noteWidth).toBeCloseTo(NOTE_WIDTH, 0);
      expect(box.lineHeight).toBeCloseTo(LINE_HEIGHT, 1);
      expect(box.noteRight, "本文が右の欄に重ならない").toBeLessThanOrEqual(box.railLeft + 0.5);
      expect(box.railRight, "右の欄が画面に収まる").toBeLessThanOrEqual(box.clientWidth + 0.5);
      await expectNoHorizontalScroll(page);
      // 44 字目までは 1 行に収まり、45 字目で折り返す
      expect(await rowsOf(page, fits.slice(0, 3)), "44 字").toBe(1);
      expect(await rowsOf(page, wraps.slice(0, 3)), "45 字").toBe(2);
    });
  }
});

test("狭い幅では、本文が余白と右の欄の残りに縮む @widths", async ({ page, api }, testInfo) => {
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "狭い幅の本文"),
    body: FULLWIDTH.repeat(30),
  });
  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page).locator(".cm-line").first()).toHaveText(FULLWIDTH.repeat(30));

  // 375 は右の欄が本文の下に回る。余白は 5vw（下限 16px）
  await page.setViewportSize({ width: 375, height: 800 });
  let box = await geometry(page);
  expect(box.noteWidth).toBeCloseTo(375 - 2 * 18.75, 0);
  expect(box.lineHeight).toBeCloseTo(LINE_HEIGHT, 1);
  await expectNoHorizontalScroll(page);

  // 768 は右の欄（230px）の分だけ縮み、余白は 5vw
  await page.setViewportSize({ width: 768, height: 900 });
  box = await geometry(page);
  expect(box.noteWidth).toBeCloseTo(768 - 230 - 2 * 38.4, 0);
  expect(box.noteRight).toBeLessThanOrEqual(box.railLeft + 0.5);
  await expectNoHorizontalScroll(page);
});

test("版のダイアログの全文は、画面の本文と同じ 44 字で折り返し、欄の中に収まる @widths", async ({
  page,
  api,
}, testInfo) => {
  const fits = `ア${FULLWIDTH.repeat(43)}`;
  const wraps = `イ${FULLWIDTH.repeat(44)}`;
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "版の本文の幅"),
    body: "最初",
    visibility: "public",
  });
  await api.updatePage(created, { body: `${fits}\n\n${wraps}` });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/p/${created.id}`);
  const entries = page.locator(".rail-section-history .revision-entry");
  await expect(entries).toHaveCount(2);
  await entries.nth(0).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "全文" }).click();
  const content = dialog.locator(".cm-content");
  await expect(content).toContainText(fits);

  const sizes = await dialog.locator(".revision-viewer-body").evaluate((body) => ({
    clientWidth: body.clientWidth,
    scrollWidth: body.scrollWidth,
    prose: (body.querySelector(".revision-viewer-prose") as HTMLElement).getBoundingClientRect()
      .width,
  }));
  expect(sizes.scrollWidth, "欄が横にあふれない").toBeLessThanOrEqual(sizes.clientWidth);
  expect(sizes.prose).toBeCloseTo(NOTE_WIDTH, 0);
  const rows = (text: string) =>
    content.locator(".cm-line", { hasText: text }).evaluate((line) => {
      const range = document.createRange();
      range.selectNodeContents(line);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top / 4))).size;
    });
  expect(await rows(fits.slice(0, 3)), "44 字").toBe(1);
  expect(await rows(wraps.slice(0, 3)), "45 字").toBe(2);
});
