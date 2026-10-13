import { expect } from "vitest";

/**
 * test が実ブラウザに解決させた色を読み、コントラスト比を測るための道具。
 *
 * Editor のスタイルは実行時に注入され、色は役割 token と明暗の切り替えの `var()` で決まるので、
 * 値を静的に読んでも実際に出る色は分からない。測り方（canvas で 8bit の RGB に揃える、輝度から
 * 比を出す）は WCAG の相対輝度の定義に従う。
 */

/** WCAG 2.2 AA の本文のコントラスト比 */
export const MIN_CONTRAST = 4.5;

export type Rgb = readonly [number, number, number];

const canvas = document.createElement("canvas");
canvas.width = 1;
canvas.height = 1;
const context2d = canvas.getContext("2d", { willReadFrequently: true });

export function toRgb(color: string): Rgb {
  if (!context2d) throw new Error("canvas 2d context is unavailable");
  const sentinel = "#010203";
  context2d.fillStyle = sentinel;
  context2d.fillStyle = color;
  if (context2d.fillStyle === sentinel) throw new Error(`unparsable color: ${color}`);
  context2d.clearRect(0, 0, 1, 1);
  context2d.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context2d.getImageData(0, 0, 1, 1).data;
  if (a !== 255) throw new Error(`color is translucent: ${color}`);
  return [r ?? 0, g ?? 0, b ?? 0];
}

/** 半透明かもしれない `color` を、不透明な `backdrop` の上に塗った結果の色 */
export function over(color: string, backdrop: Rgb): Rgb {
  if (!context2d) throw new Error("canvas 2d context is unavailable");
  context2d.clearRect(0, 0, 1, 1);
  context2d.fillStyle = `rgb(${backdrop.join(" ")})`;
  context2d.fillRect(0, 0, 1, 1);
  // 解析できない色は fillStyle を変えず、背景の色だけを測って通ってしまう
  const sentinel = "#010203";
  context2d.fillStyle = sentinel;
  context2d.fillStyle = color;
  if (context2d.fillStyle === sentinel) throw new Error(`unparsable color: ${color}`);
  context2d.fillRect(0, 0, 1, 1);
  const [r, g, b] = context2d.getImageData(0, 0, 1, 1).data;
  return [r ?? 0, g ?? 0, b ?? 0];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

// 親に置いた色と同じなら、値が無効で color が継承に落ちている（切り替えが無いときの壊れ方）
const INHERITED = "rgb(1, 2, 3)";

/** `within` の中で `expression`（`var(--x)` や `rgb(var(--x))`）が解決する色 */
export function resolve(within: HTMLElement, expression: string): Rgb {
  const parent = document.createElement("span");
  parent.style.color = INHERITED;
  const probe = document.createElement("span");
  probe.style.color = expression;
  parent.append(probe);
  within.append(parent);
  try {
    const value = getComputedStyle(probe).color;
    expect(value, `${expression} is unresolved`).not.toBe(INHERITED);
    return toRgb(value);
  } finally {
    parent.remove();
  }
}

export const colorOf = (element: Element): Rgb => toRgb(getComputedStyle(element).color);
