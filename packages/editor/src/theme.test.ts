import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calloutAppearance } from "./callout";
import { createEditor } from "./create-editor";
import {
  colorOf,
  contrastRatio,
  MIN_CONTRAST,
  over,
  type Rgb,
  resolve,
  toRgb,
} from "./test-contrast";
import { resetEditorHue, resetScheme, setEditorHue, setScheme } from "./test-tokens";
import { SYNTAX_COLOR_VARIABLES } from "./theme";

const SCHEMES = ["light", "dark"] as const;

// テーマはエディタ面へ色相だけを渡すので、5 度刻みで一周させて今後のテーマも覆う
const HUES = Array.from({ length: 72 }, (_, index) => index * 5);

const LINK = "既知のページ";
const UNRESOLVED = "未知のページ";
const URL = "https://example.com";
const DOC = [
  "# 見出し",
  "",
  `本文と [[${LINK}]] と [[${UNRESOLVED}]] と #タグ と ==強調==。`,
  "",
  `[ラベル](${URL})`,
  "",
  "> [!success] 成功",
  "> 引用の本文",
  "",
  "- [x] 完了した task",
].join("\n");
const URL_LINE = 5;

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, { doc: DOC, resolveWikiLink: (target) => target === LINK });
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
  resetScheme();
  resetEditorHue();
});

function query(v: EditorView, selector: string): HTMLElement {
  const element = v.dom.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`${selector} is not rendered`);
  return element;
}

function deepestElement(element: HTMLElement): HTMLElement {
  let current = element;
  while (current.firstElementChild instanceof HTMLElement) current = current.firstElementChild;
  return current;
}

// caret と選択範囲は layer が measure の後に描くので、dispatch の直後にはまだ無い
const queryDrawn = (v: EditorView, selector: string): Promise<HTMLElement> =>
  vi.waitFor(() => query(v, selector));

/** callout の色は行の class からしか引けないので、同じ class の要素を置いて読む */
function calloutColor(v: EditorView, type: string): Rgb {
  const line = document.createElement("div");
  line.className = "cm-lp-callout";
  line.dataset.callout = type;
  v.contentDOM.append(line);
  try {
    return resolve(line, "rgb(var(--cm-lp-callout-color))");
  } finally {
    line.remove();
  }
}

describe("editor colors", () => {
  it.each(SCHEMES)("%s: 本文と構文色が地に対して 4.5:1 以上", (scheme) => {
    setScheme(scheme);
    const v = mount();
    const content = v.contentDOM;
    const background = resolve(content, "var(--ui-color-background)");

    const foregrounds: [name: string, color: Rgb][] = [
      // colorOf ではなく resolve を通す。token が壊れて継承に落ちても、白地にブラウザ既定の黒が
      // 21:1 で通ってしまい、この test が見逃す
      ["本文", resolve(content, "var(--ui-color-text)")],
      ["補助の文字", resolve(content, "var(--ui-color-muted)")],
      ["リンク", resolve(content, "var(--ui-color-accent)")],
      ["失敗", resolve(content, "var(--ui-color-danger)")],
      ...SYNTAX_COLOR_VARIABLES.map((variable): [string, Rgb] => [
        variable,
        resolve(content, `var(${variable})`),
      ]),
      ...Object.keys(calloutAppearance).map((type): [string, Rgb] => [
        `callout(${type})`,
        calloutColor(v, type),
      ]),
    ];

    const failures = foregrounds.flatMap(([name, color]) => {
      const ratio = contrastRatio(color, background);
      return ratio >= MIN_CONTRAST ? [] : [`${name} ${ratio.toFixed(2)}:1`];
    });

    expect(failures).toEqual([]);
  });

  it.each(SCHEMES)("%s: tag と選択範囲の上でも本文が読める", async (scheme) => {
    setScheme(scheme);
    const v = mount();
    const content = v.contentDOM;
    const accent = resolve(content, "var(--ui-color-accent)");
    const tagGround = over(
      getComputedStyle(query(v, ".cm-tag")).backgroundColor,
      resolve(content, "var(--ui-color-background)"),
    );
    const text = colorOf(content);

    v.focus();
    v.dispatch({ selection: EditorSelection.range(0, 5) });
    const selection = toRgb(
      getComputedStyle(await queryDrawn(v, ".cm-selectionBackground")).backgroundColor,
    );

    expect(contrastRatio(accent, tagGround)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(contrastRatio(text, selection)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it.each(SCHEMES)(
    "%s: 選択した tag の文字は、tag の地を選択の地に重ねた上で、focus の有無どちらでもどの色相でも 4.5:1 以上",
    async (scheme) => {
      setScheme(scheme);
      const v = mount();
      const tag = query(v, ".cm-tag");

      /** tag の半透明の地を選択の地に重ねた色に対する、accent の比が 4.5:1 を割る組 */
      function failuresOver(label: string): string[] {
        const selection = query(v, ".cm-selectionBackground");
        return HUES.flatMap((hue) => {
          setEditorHue(hue);
          const ground = over(
            getComputedStyle(tag).backgroundColor,
            toRgb(getComputedStyle(selection).backgroundColor),
          );
          const ratio = contrastRatio(resolve(v.contentDOM, "var(--ui-color-accent)"), ground);
          return ratio >= MIN_CONTRAST ? [] : [`${label} hue ${hue}: ${ratio.toFixed(2)}:1`];
        });
      }

      v.focus();
      v.dispatch({ selection: EditorSelection.range(0, v.state.doc.length) });
      await queryDrawn(v, ".cm-selectionBackground");
      const focused = failuresOver("focused");

      v.contentDOM.blur();
      await vi.waitFor(() => expect(v.dom.classList.contains("cm-focused")).toBe(false));
      const blurred = failuresOver("blurred");

      expect([...focused, ...blurred]).toEqual([]);
    },
  );

  it.each(SCHEMES)(
    "%s: リンクは accent、未解決リンクは補助色に accent の破線、tag は accent の淡い地、markdown link も accent",
    (scheme) => {
      setScheme(scheme);
      const v = mount();
      const content = v.contentDOM;
      const accent = resolve(content, "var(--ui-color-accent)");
      const muted = resolve(content, "var(--ui-color-muted)");
      const page = resolve(content, "var(--ui-color-background)");

      const link = query(v, `[data-wikilink-target="${LINK}"]`);
      const unresolved = query(v, `[data-wikilink-target="${UNRESOLVED}"]`);
      const tag = query(v, ".cm-tag");
      const mdLink = query(v, ".cm-md-link");

      expect(colorOf(link)).toEqual(accent);
      expect(unresolved.className).toContain("cm-wikilink-unresolved");
      expect(colorOf(unresolved)).toEqual(muted);
      expect(getComputedStyle(unresolved).textDecorationStyle).toBe("dashed");
      expect(toRgb(getComputedStyle(unresolved).textDecorationColor)).toEqual(accent);
      // 文字を持つのは内側の構文 highlight（t.link）の span。その色と実線が外側の指定を覆うと
      // 解決済みのリンクと見分けがつかなくなる
      const unresolvedText = deepestElement(unresolved);
      expect(colorOf(unresolvedText)).toEqual(muted);
      expect(getComputedStyle(unresolvedText).textDecorationLine).toBe("none");
      expect(colorOf(tag)).toEqual(accent);
      // 地は accent を透かした色。地の色そのものと違い、選択範囲の層が透けて見える
      const tagBackground = getComputedStyle(tag).backgroundColor;
      expect(() => toRgb(tagBackground)).toThrow(/translucent/);
      const tagGround = over(tagBackground, page);
      expect(tagGround).not.toEqual(page);
      expect(contrastRatio(tagGround, accent)).toBeLessThan(contrastRatio(page, accent));
      expect(colorOf(mdLink)).toEqual(accent);
      expect(getComputedStyle(mdLink).textDecorationLine).toBe("underline");
    },
  );

  it.each(SCHEMES)("%s: caret と autocomplete の tooltip が役割 token に従う", async (scheme) => {
    setScheme(scheme);
    const v = mount();
    const content = v.contentDOM;
    const text = colorOf(content);
    const background = resolve(content, "var(--ui-color-background)");
    const border = resolve(content, "var(--ui-color-border)");
    const accent = resolve(content, "var(--ui-color-accent)");
    const selected = resolve(content, "var(--ui-color-selected)");

    v.focus();
    expect(toRgb(getComputedStyle(await queryDrawn(v, ".cm-cursor")).borderLeftColor)).toEqual(
      text,
    );

    // 本物の tooltip は候補が出たときだけ現れるので、同じ class の要素を view の中に置いて cascade を見る
    const tooltip = document.createElement("div");
    tooltip.className = "cm-tooltip cm-tooltip-autocomplete";
    tooltip.innerHTML =
      '<ul><li aria-selected="true">候補<span class="cm-completionDetail">説明</span></li></ul>';
    v.dom.append(tooltip);
    try {
      const option = query(v, ".cm-tooltip-autocomplete li[aria-selected]");
      expect(toRgb(getComputedStyle(tooltip).backgroundColor)).toEqual(background);
      expect(toRgb(getComputedStyle(tooltip).borderTopColor)).toEqual(border);
      // 選択行は quick switcher と同じく、地の色の変化と左の差し色の線で示す（差し色の地にしない）
      expect(toRgb(getComputedStyle(option).backgroundColor)).toEqual(selected);
      expect(colorOf(option)).toEqual(text);
      expect(contrastRatio(text, selected)).toBeGreaterThanOrEqual(MIN_CONTRAST);
      // muted は選択行の地の上で 4.5:1 を割ることがあるので、選択行の中の detail は本文の色にする
      const detail = query(v, ".cm-tooltip-autocomplete li[aria-selected] .cm-completionDetail");
      expect(colorOf(detail)).toEqual(text);
      expect(contrastRatio(colorOf(detail), selected)).toBeGreaterThanOrEqual(MIN_CONTRAST);
      // autocomplete 自身の規則（等幅、border-box でない ul）でなく、こちらの規則が勝っている
      const list = query(v, ".cm-tooltip-autocomplete > ul");
      expect(getComputedStyle(list).fontFamily).toContain("editor-test-body");
      expect(getComputedStyle(list).boxSizing).toBe("border-box");
      // 行の余白も autocomplete の既定（左右 3px）でなくこちらの値
      expect(Number.parseFloat(getComputedStyle(option).paddingLeft)).toBeGreaterThan(3);
      expect(getComputedStyle(option).boxShadow).toContain("inset");
      expect(getComputedStyle(option).boxShadow).toContain(`rgb(${accent.join(", ")})`);
    } finally {
      tooltip.remove();
    }
  });

  it("コードの構文色は packages/editor が持つ組から来る（CodeMirror の既定でない）", () => {
    const v = mount();
    // source を出さないと URL は隠れたままなので、その行にカーソルを置く
    v.focus();
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(URL_LINE).from) });

    const url = [...v.contentDOM.querySelectorAll("span")].find((span) => span.textContent === URL);
    if (!url) throw new Error("URL is not revealed");

    expect(colorOf(url)).toEqual(resolve(v.contentDOM, "var(--cm-syntax-atom)"));
  });
});
