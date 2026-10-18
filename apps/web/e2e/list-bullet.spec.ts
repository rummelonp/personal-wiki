import { bodyEditor, expect, test, uniqueTitle } from "./support/fixtures";

/*
 * 箇条書きの丸が、本文の文字より目で見て分かる大きさで行の中央にあり、背景と 3:1 以上の対比を
 * 保つこと。丸を大きくしても、折り返した行が本文の始まりにそろうことも測る。
 */

const LONG = "長い項目の本文".repeat(20);
const BODY = ["- 短い項目", `- ${LONG}`, "  - 入れ子の項目"].join("\n");

/** `rgb(r g b)` / `rgb(r, g, b)` / `rgba(...)` を相対輝度にする */
function luminance(css: string): number {
  const channels = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const [r = 0, g = 0, b = 0] = channels.map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => {
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

for (const colorScheme of ["light", "dark"] as const) {
  test(`箇条書きの丸は文字より大きく、行の中央にあり、背景と区別できる（${colorScheme}）`, async ({
    page,
    api,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme });
    const created = await api.createPage({
      title: uniqueTitle(testInfo, "箇条書きの丸"),
      body: BODY,
    });
    await page.goto(`/p/${created.id}`);
    await expect(bodyEditor(page).locator(".cm-lp-list-dot")).toHaveCount(3);

    const measured = await bodyEditor(page).evaluate((content) =>
      [...content.querySelectorAll(".cm-lp-list-dot")].map((dot) => {
        const line = dot.closest(".cm-line") as HTMLElement;
        const rect = dot.getBoundingClientRect();
        // 記号の後ろの空白の次から数えた本文の文字の箱。折り返した項目でも 1 行目の中央と比べられる
        const text = line.lastChild;
        const rects: DOMRect[] = [];
        if (text?.nodeType === Node.TEXT_NODE) {
          const range = document.createRange();
          range.setStart(text, 1);
          range.setEnd(text, (text.textContent ?? "").length);
          rects.push(...range.getClientRects());
        }
        const first = rects[0];
        return {
          size: rect.width,
          height: rect.height,
          fontSize: Number.parseFloat(getComputedStyle(line).fontSize),
          offsetY: rect.top + rect.height / 2 - ((first?.top ?? 0) + (first?.height ?? 0) / 2),
          color: getComputedStyle(dot).backgroundColor,
          background: getComputedStyle(document.body).backgroundColor,
          firstLeft: first?.left ?? 0,
          lastLeft: rects.at(-1)?.left ?? 0,
          lines: rects.length,
        };
      }),
    );

    for (const item of measured) {
      expect(item.size / item.fontSize).toBeGreaterThanOrEqual(0.35);
      expect(item.size / item.fontSize).toBeLessThanOrEqual(0.45);
      expect(item.height).toBeCloseTo(item.size, 1);
      expect(Math.abs(item.offsetY)).toBeLessThan(2);
      expect(contrast(item.color, item.background)).toBeGreaterThanOrEqual(3);
    }
    // 長い項目は折り返し、2 行目以降は本文の始まりにそろう
    const long = measured[1];
    expect(long?.lines).toBeGreaterThan(1);
    expect(Math.abs((long?.lastLeft ?? 0) - (long?.firstLeft ?? 99))).toBeLessThan(1);
  });
}
