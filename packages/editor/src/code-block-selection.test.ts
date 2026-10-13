import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp } from "vitest/browser";
import { createEditor } from "./create-editor";
import { resolve, toRgb } from "./test-contrast";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

/** 実際に描かれた画面を撮り、CSS の座標で 1 点の色を読む道具 */
async function screenshotReader() {
  const { data } = (await cdp().send("Page.captureScreenshot", { format: "png" })) as {
    data: string;
  };
  const bitmap = await createImageBitmap(
    await (await fetch(`data:image/png;base64,${data}`)).blob(),
  );
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("canvas 2d context is unavailable");
  context.drawImage(bitmap, 0, 0);
  const scale = bitmap.width / innerWidth;
  return (x: number, y: number): number[] =>
    [...context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data].slice(0, 3);
}

function expectColor(actual: number[], expected: readonly number[]) {
  // 色空間の変換と合成のときの丸めで 1〜2 ずれうる
  for (const [i, channel] of actual.entries()) {
    expect(Math.abs(channel - (expected[i] ?? 0))).toBeLessThanOrEqual(2);
  }
}

const DOC = "前\n\n```ts\na\nb\n```\n\n後";

/** DOC を描き、選択を置いて、地の上端・本文・下端と、その外側の点の色を撮る */
async function sample(from: number, to: number) {
  host = document.createElement("div");
  host.style.width = "480px";
  document.body.append(host);
  view = createEditor(host, { doc: DOC });
  view.focus();
  view.dispatch({ selection: EditorSelection.range(from, to) });
  const dom = view.dom;
  await vi.waitFor(() => expect(dom.querySelector(".cm-selectionBackground")).not.toBeNull());
  const selected = toRgb(
    getComputedStyle(dom.querySelector(".cm-selectionBackground") as Element).backgroundColor,
  );
  const surface = resolve(view.contentDOM, "var(--ui-color-surface)");
  const lines = [...view.contentDOM.querySelectorAll(".cm-lp-code")];
  const first = lines[0]?.getBoundingClientRect();
  const second = lines[1]?.getBoundingClientRect();
  const last = lines.at(-1)?.getBoundingClientRect();
  if (!first || !second || !last) throw new Error("code lines are not rendered");
  const gap = Number.parseFloat(getComputedStyle(lines[0] as Element).borderTopWidth);
  const pixel = await screenshotReader();
  const x = first.left + first.width / 2;
  return {
    selected,
    surface,
    background: resolve(view.contentDOM, "var(--ui-color-background)"),
    gap,
    topGap: pixel(x, first.top + gap / 2),
    body: pixel(x, second.top + second.height / 2),
    bottomGap: pixel(x, last.bottom - gap / 2),
    bottomGapTop: pixel(x, last.bottom - gap + 2),
    above: pixel(x, first.top - 4),
    below: pixel(x, last.bottom + 4),
  };
}

describe("selection across a code block", () => {
  it("shows the selection in the gaps around the block while the opaque background hides it", async () => {
    // 選択の層は本文の下に描かれるので、不透明な地の行では隠れ、地の外の隙間（透明な border）にだけ見える。
    // 前後の行も選択されていれば、隙間の色はその行と同じで帯が途切れずに続く。
    const r = await sample(1, DOC.length - 1);
    expect(r.gap).toBeGreaterThan(0);
    expect(r.selected).not.toEqual(r.surface);
    expectColor(r.topGap, r.selected);
    expectColor(r.bottomGap, r.selected);
    expectColor(r.body, r.surface);
    expectColor(r.above, r.selected);
    expectColor(r.below, r.selected);
  });

  it("shows only a strip under the block when the selection ends at the start of the next line", async () => {
    // 閉じフェンスの行頭から次の行頭まで（3 回クリックや Shift+↓ で行を選んだ形）では、選ぶのは地の中の行だけで
    // 隠れる。それでも、その行の選択の矩形が隙間の上半分に食い込み、選ばれていない次の行の上に細い帯だけが見える。
    // 根本の原因は、ブロックの中の選択が見えないこと（直したらこのテストも改める）
    const close = DOC.indexOf("```\n\n");
    const r = await sample(close, close + 4);
    expectColor(r.bottomGapTop, r.selected);
    expect(r.below).not.toEqual(r.selected);
    expectColor(r.above, r.background);
  });
});
