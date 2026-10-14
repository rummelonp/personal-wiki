import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calloutAppearance } from "./callout";
import { createEditor } from "./create-editor";
import { colorOf, contrastRatio, MIN_CONTRAST, type Rgb, resolve, toRgb } from "./test-contrast";
import { resetScheme, setScheme } from "./test-tokens";
import { SYNTAX_COLOR_VARIABLES } from "./theme";

const SCHEMES = ["light", "dark"] as const;

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
    const accentSoft = resolve(content, "var(--ui-color-accent-soft)");
    const text = colorOf(content);

    v.focus();
    v.dispatch({ selection: EditorSelection.range(0, 5) });
    const selection = toRgb(
      getComputedStyle(await queryDrawn(v, ".cm-selectionBackground")).backgroundColor,
    );

    expect(contrastRatio(accent, accentSoft)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(contrastRatio(text, selection)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it.each(SCHEMES)(
    "%s: リンクは accent、未解決リンクは補助色に accent の破線、tag は accent の淡い地、markdown link も accent",
    (scheme) => {
      setScheme(scheme);
      const v = mount();
      const content = v.contentDOM;
      const accent = resolve(content, "var(--ui-color-accent)");
      const muted = resolve(content, "var(--ui-color-muted)");
      const accentSoft = resolve(content, "var(--ui-color-accent-soft)");

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
      expect(toRgb(getComputedStyle(tag).backgroundColor)).toEqual(accentSoft);
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
    tooltip.innerHTML = '<ul><li aria-selected="true">候補</li></ul>';
    v.dom.append(tooltip);
    try {
      const option = query(v, ".cm-tooltip-autocomplete li[aria-selected]");
      expect(toRgb(getComputedStyle(tooltip).backgroundColor)).toEqual(background);
      expect(toRgb(getComputedStyle(tooltip).borderTopColor)).toEqual(border);
      // 選択行は quick switcher と同じく、地の色の変化と左の差し色の線で示す（差し色の地にしない）
      expect(toRgb(getComputedStyle(option).backgroundColor)).toEqual(selected);
      expect(colorOf(option)).toEqual(text);
      expect(contrastRatio(text, selected)).toBeGreaterThanOrEqual(MIN_CONTRAST);
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
