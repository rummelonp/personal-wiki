import { expect, test, uniqueTitle } from "./support/fixtures";
import { lineTexts } from "./support/line-breaks";

/*
 * 長いタグで絞った一覧の見出しの折り返し。見出しの幅を振っても、語の途中で折り返さない。
 * word-break: auto-phrase は WebKit に無いので、測るのはデスクトップの Chromium だけにする（@widths）。
 */

// 折り返しの途中で切れてはいけない語。タグの中で 1 度ずつ使う
const WORDS = ["並び順", "ボタン", "見出し", "狭めた", "折り返し", "確かめる", "さらに"];
const TAG = `${WORDS.join("と")}のタグ`;

test("長いタグの見出しは、どの幅でも語の途中で折り返さない @widths", async ({
  page,
  api,
}, testInfo) => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const tag = `${TAG}${suffix}`;
  await api.createPage({ title: uniqueTitle(testInfo, "見出しの折り返し"), body: `#${tag}` });
  await page.goto(`/?tag=${encodeURIComponent(tag)}`);
  const heading = page.locator(".list-title");
  await expect(heading).toHaveText(`タグ「${tag}」`);

  const head = page.locator(".list-head");
  const sort = page.getByRole("button", { name: /^並び順：/ });
  // 見出しの 1 行に収まる語（4 字）が収まらない幅は振らない。1 行より長い語は、折り返しが語の中に入る
  for (let width = 220; width <= 640; width += 7) {
    await head.evaluate((element, w) => {
      element.style.width = `${w}px`;
    }, width);
    const rows = await lineTexts(heading);
    expect(rows.length, `${width}px で折り返している`).toBeGreaterThan(1);
    const text = rows.join("");
    let offset = 0;
    const breaks = rows.slice(0, -1).map((row) => {
      offset += row.length;
      return offset;
    });
    for (const word of WORDS) {
      const at = text.indexOf(word);
      expect(at, `「${word}」が見出しに無い`).toBeGreaterThanOrEqual(0);
      const inside = breaks.filter((b) => b > at && b < at + word.length);
      expect(inside, `${width}px で「${word}」が折れる: ${rows.join(" | ")}`).toEqual([]);
    }
    // 折り返しても、並び順のボタンは見出しの 1 行目の右に残る
    const top = (await heading.boundingBox())?.y ?? Number.NaN;
    const buttonTop = (await sort.boundingBox())?.y ?? Number.NaN;
    expect(Math.abs(buttonTop - top), `${width}px でボタンが 1 行目から離れている`).toBeLessThan(4);
  }
});
