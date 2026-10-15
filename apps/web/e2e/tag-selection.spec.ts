import { bodyEditor, expect, test, uniqueTitle } from "./support/fixtures";

/*
 * 本文の tag の上の選択。選択範囲は tag の地の下の層に描かれるので、tag の地は半透明にして透かす。
 * 実際の token（明暗）で、選択した tag の地が選択していない tag の地と見分けられ（地の文の選択に近い比）、
 * tag の文字が地の上で 4.5:1 を保つことを確かめる。色は描画後の computed style を canvas で合成して測る。
 */

test.skip(
  ({ isMobile }) => isMobile,
  "選択は物理キーボードの全選択で作るので、デスクトップだけで測る",
);

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: 選択した tag の地は、選択していない tag の地と見分けられ、文字は 4.5:1 を保つ`, async ({
    page,
    api,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme });
    const created = await api.createPage({
      title: uniqueTitle(testInfo, "tag の選択"),
      body: "本文と #タグ と続き #別のタグ です",
    });
    await page.goto(`/p/${created.id}`);
    await expect(bodyEditor(page)).toContainText("タグ");
    await bodyEditor(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await expect(page.locator(".cm-selectionBackground").first()).toBeVisible();

    const ratios = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("canvas 2d context is unavailable");
      type Rgb = [number, number, number];
      const over = (css: string, under: Rgb): Rgb => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = `rgb(${under.join(" ")})`;
        context.fillRect(0, 0, 1, 1);
        context.fillStyle = css;
        context.fillRect(0, 0, 1, 1);
        const data = context.getImageData(0, 0, 1, 1).data;
        return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
      };
      const linear = (value: number) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      };
      const luminance = ([r, g, b]: Rgb) =>
        0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
      const contrast = (a: Rgb, b: Rgb) => {
        const [x, y] = [luminance(a), luminance(b)];
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };

      const tag = document.querySelector(".cm-tag");
      const selection = document.querySelector(".cm-selectionBackground");
      if (!tag || !selection) throw new Error("tag or selection is missing");
      const ground = over(getComputedStyle(document.body).backgroundColor, [0, 0, 0]);
      const accent = over(getComputedStyle(tag).color, ground);
      const selected = over(getComputedStyle(selection).backgroundColor, ground);
      const tagBackground = getComputedStyle(tag).backgroundColor;
      const tagOnPage = over(tagBackground, ground);
      const tagOnSelection = over(tagBackground, selected);
      return {
        plainSelection: contrast(selected, ground),
        selectedTag: contrast(tagOnSelection, tagOnPage),
        tagOnPage: contrast(tagOnPage, ground),
        textOnTag: contrast(accent, tagOnPage),
        textOnSelectedTag: contrast(accent, tagOnSelection),
      };
    });

    expect(ratios.selectedTag).toBeGreaterThanOrEqual(1.3);
    expect(ratios.selectedTag).toBeGreaterThanOrEqual(ratios.plainSelection * 0.9);
    expect(ratios.tagOnPage).toBeGreaterThanOrEqual(1.05);
    expect(ratios.textOnTag).toBeGreaterThanOrEqual(4.5);
    expect(ratios.textOnSelectedTag).toBeGreaterThanOrEqual(4.5);
  });
}
