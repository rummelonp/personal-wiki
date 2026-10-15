import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "./create-editor";
import { over, resolve, toRgb } from "./test-contrast";
import { screenshotReader } from "./test-screenshot";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

function expectColor(actual: number[], expected: readonly number[]) {
  // 色空間の変換と合成のときの丸めで 1〜2 ずれうる
  for (const [i, channel] of actual.entries()) {
    expect(Math.abs(channel - (expected[i] ?? 0))).toBeLessThanOrEqual(2);
  }
}

const DOC = "前\n\n```ts\na\nb\n```\n\n後";

/** DOC を描き、選択を置いて、地の上端／本文／下端と、その外側の点の色を撮る */
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
    // 地は半透明なので、選択の層（本文の下）の上に地が重なった色が画面に出る
    selectedOnSurface: over(getComputedStyle(lines[1] as Element).backgroundColor, selected),
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
  it("shows the selection through the translucent background, and in the gaps around the block", async () => {
    // 選択の層は本文の下に描かれるので、地が半透明でないと隠れる。地は半透明にして、地の上でも選択の色に
    // 地が重なった色で見せる。地の外の隙間（透明な border）は、前後の行も選択されていれば同じ選択の色で、
    // 帯が途切れずに続く。
    const r = await sample(1, DOC.length - 1);
    expect(r.gap).toBeGreaterThan(0);
    expect(r.selected).not.toEqual(r.surface);
    expectColor(r.topGap, r.selected);
    expectColor(r.bottomGap, r.selected);
    expectColor(r.body, r.selectedOnSurface);
    expect(r.body).not.toEqual([...r.surface]);
    expectColor(r.above, r.selected);
    expectColor(r.below, r.selected);
  });

  it("leaves the block on its own background when nothing in it is selected", async () => {
    const r = await sample(0, 1);
    expectColor(r.body, r.surface);
  });

  it("shows only a strip under the block when the selection ends at the start of the next line", async () => {
    // 閉じフェンスの行頭から次の行頭まで（3 回クリックや Shift+↓ で行を選んだ形）では、選ぶのは地の中の行だけ。
    // その行の選択の矩形が隙間の上半分に食い込み、選ばれていない次の行の上に細い帯が見える。
    const close = DOC.indexOf("```\n\n");
    const r = await sample(close, close + 4);
    expectColor(r.bottomGapTop, r.selected);
    expect(r.below).not.toEqual(r.selected);
    expectColor(r.above, r.background);
  });
});
