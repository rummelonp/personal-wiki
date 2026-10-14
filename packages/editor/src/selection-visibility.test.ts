import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { revealBlockId } from "./block-id";
import { createEditor } from "./create-editor";
import { colorOf, contrastRatio, MIN_CONTRAST, over, resolve, toRgb } from "./test-contrast";
import { screenshotReader } from "./test-screenshot";
import { resetScheme, setScheme } from "./test-tokens";

/**
 * 選択範囲の地は本文の下の層（`.cm-selectionLayer`）に描かれるので、行や inline に不透明な地を敷く装飾は
 * その範囲の選択を隠す。装飾の地は半透明にして、選択が透けることを確かめる。
 */

const SCHEMES = ["light", "dark"] as const;

let view: EditorView | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
  resetScheme();
});

function mount(doc: string, width = 480): EditorView {
  host = document.createElement("div");
  host.style.width = `${width}px`;
  document.body.append(host);
  view = createEditor(host, { doc });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
}

/** computed な色（`rgb()` / `rgba()` / `color(srgb ... / a)`）の不透明度 */
function alphaOf(color: string): number {
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
  if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
  const rgba = /^rgba\(\s*[^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/.exec(color);
  return rgba ? Number(rgba[1]) : 1;
}

/** 背景色が不透明な要素（選択範囲を隠す）の一覧 */
function opaqueBackgrounds(root: Element, except: string): string[] {
  return [...root.querySelectorAll("*")]
    .filter((element) => !element.matches(except))
    .filter((element) => {
      const { backgroundColor } = getComputedStyle(element);
      return backgroundColor !== "rgba(0, 0, 0, 0)" && alphaOf(backgroundColor) >= 1;
    })
    .map((element) => `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`);
}

const RICH_DOC = [
  "---",
  "tags: [a]",
  "---",
  "",
  "本文 ==強調== と `code` と #tag",
  "",
  "```ts",
  "const a = 1;",
  "```",
  "",
  "> 引用",
  "",
  "> [!note] 注意",
  "> 本文",
  "",
  "> [!note] callout 中のコード",
  "> ```",
  "> code",
  "> ```",
  "",
  "| a | b |",
  "| - | - |",
  "| c | d |",
  "",
  "- [ ] 作業",
  "",
  "段落 ^target",
].join("\n");

// 地の色が token そのもので、半透明にできないもの。選択を隠す既知の残りとして検査から外す
//  - tag の chip: ホストの `--ui-color-accent-soft` が不透明な色として渡される
const KEPT_OPAQUE = ".cm-tag";

describe("装飾の地は選択範囲を隠さない", () => {
  it("frontmatter を畳んだ表示と、本文・コード・引用・callout・表の地が不透明でない", () => {
    const v = mount(RICH_DOC);
    v.focus();
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.length) });
    expect(v.contentDOM.querySelector(".cm-frontmatter")).not.toBeNull();
    expect(v.contentDOM.querySelector(".cm-lp-highlight")).not.toBeNull();
    expect(v.contentDOM.querySelector(".cm-lp-inline-code")).not.toBeNull();
    expect(v.contentDOM.querySelector(".cm-lp-code")).not.toBeNull();
    expect(v.contentDOM.querySelector(".cm-lp-callout")).not.toBeNull();
    expect(v.contentDOM.querySelector(".cm-lp-table-header")).not.toBeNull();
    expect(opaqueBackgrounds(v.contentDOM, KEPT_OPAQUE)).toEqual([]);
  });

  it("frontmatter を開いた source の行の地が不透明でない", () => {
    const v = mount(RICH_DOC);
    v.focus();
    v.dispatch({ selection: EditorSelection.cursor(5) });
    expect(v.contentDOM.querySelector(".cm-frontmatter-source")).not.toBeNull();
    expect(opaqueBackgrounds(v.contentDOM, KEPT_OPAQUE)).toEqual([]);
  });

  it("カーソル行の地が不透明でない", async () => {
    const v = mount(RICH_DOC);
    v.focus();
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(5).from) });
    await vi.waitFor(() => expect(v.contentDOM.querySelector(".cm-active-line")).not.toBeNull());
    const line = v.contentDOM.querySelector(".cm-active-line") as Element;
    const { backgroundColor } = getComputedStyle(line);
    expect(backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(alphaOf(backgroundColor)).toBeLessThan(1);
  });

  it("ブロック参照の強調の地が不透明でない", () => {
    const v = mount(RICH_DOC);
    expect(revealBlockId(v, "target")).toBe(true);
    const mark = v.contentDOM.querySelector(".cm-block-ref-highlight");
    if (!mark) throw new Error("the block highlight is not rendered");
    expect(alphaOf(getComputedStyle(mark).backgroundColor)).toBeLessThan(1);
  });
});

describe("カーソル行の中だけを選んだとき", () => {
  const LINE = "選択の地が行の地に隠れずに見えること、その確認のための長めの一行";

  async function selectInActiveLine() {
    const v = mount(`前の行\n\n${LINE}\n\n後の行`);
    v.focus();
    const line = v.state.doc.line(3);
    v.dispatch({ selection: EditorSelection.range(line.from + 3, line.from + 9) });
    await vi.waitFor(() => expect(v.contentDOM.querySelector(".cm-active-line")).not.toBeNull());
    const layer = await vi.waitFor(() => {
      const element = v.dom.querySelector(".cm-selectionBackground");
      if (!element) throw new Error("the selection is not drawn");
      return element;
    });
    // 行の中の文字の無い位置（行の上の余白）を読む。選択の矩形は行の高さいっぱいに広がる
    const rect = layer.getBoundingClientRect();
    const lineRect = (
      v.contentDOM.querySelector(".cm-active-line") as Element
    ).getBoundingClientRect();
    const pixel = await screenshotReader();
    return {
      v,
      selected: toRgb(getComputedStyle(layer).backgroundColor),
      lineBackground: getComputedStyle(v.contentDOM.querySelector(".cm-active-line") as Element)
        .backgroundColor,
      inside: pixel(rect.left + rect.width / 2, rect.top + 2),
      outside: pixel(Math.min(rect.right + 30, lineRect.right - 4), rect.top + 2),
    };
  }

  it.each(SCHEMES)(
    "%s: 選択の地が行の地の上に見え、行の地だけの部分と区別できる",
    async (scheme) => {
      setScheme(scheme);
      const { v, selected, lineBackground, inside, outside } = await selectInActiveLine();
      const page = resolve(v.contentDOM, "var(--ui-color-background)");
      const selectedOnLine = over(lineBackground, selected);
      const lineOnly = over(lineBackground, page);

      const close = (actual: number[], expected: readonly number[]) => {
        for (const [index, channel] of actual.entries()) {
          expect(Math.abs(channel - (expected[index] ?? 0))).toBeLessThanOrEqual(2);
        }
      };
      close(inside, selectedOnLine);
      close(outside, lineOnly);

      const delta = Math.max(
        ...selectedOnLine.map((channel, i) => Math.abs(channel - (lineOnly[i] ?? 0))),
      );
      expect(delta).toBeGreaterThan(8);
    },
  );

  it.each(SCHEMES)("%s: 選択と行の地が重なっても本文が 4.5:1 以上", async (scheme) => {
    setScheme(scheme);
    const { v, selected, lineBackground } = await selectInActiveLine();
    const selectedOnLine = over(lineBackground, selected);
    expect(contrastRatio(colorOf(v.contentDOM), selectedOnLine)).toBeGreaterThanOrEqual(
      MIN_CONTRAST,
    );
  });
});
