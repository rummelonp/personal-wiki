import { describe, expect, it } from "vitest";
import css from "./theme.css?raw";

const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");

/** 明るい側は最初の :root、暗い側は dark の節から token の値を読む */
function token(name: string, scheme: "light" | "dark"): string {
  const source = scheme === "light" ? css.slice(0, darkStart) : css.slice(darkStart);
  const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(source);
  if (!match?.[1]) throw new Error(`${name} が ${scheme} に無い`);
  return match[1];
}

const channel = (hex: string, offset: number) => {
  const v = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) =>
  0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

describe("検索の一致箇所の地（--color-mark-bg）", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`${scheme}: 本文の文字が地の上で 4.5:1 以上で読める`, () => {
      expect(
        contrast(token("--color-fg", scheme), token("--color-mark-bg", scheme)),
      ).toBeGreaterThan(4.5);
    });

    // 一致箇所の中のリンク（差し色の文字）も読める
    it(`${scheme}: 差し色の文字が地の上で 4.5:1 以上で読める`, () => {
      expect(
        contrast(token("--color-accent", scheme), token("--color-mark-bg", scheme)),
      ).toBeGreaterThan(4.5);
    });

    // 差し色と別の系統（黄）の地に戻らない。差し色が青系なので、青が赤より強いことで見る
    it(`${scheme}: 差し色と同じ青系の色相にある`, () => {
      const hex = token("--color-mark-bg", scheme);
      const [r, b] = [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(5, 7), 16)];
      expect(b).toBeGreaterThan(r);
    });
  }
});
