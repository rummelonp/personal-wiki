import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calloutAppearance } from "./callout";
import { createEditor } from "./create-editor";
import { colorOf, contrastRatio, MIN_CONTRAST, over, resolve, toRgb } from "./test-contrast";
import { resetEditorHue, resetScheme, setEditorHue, setScheme } from "./test-tokens";
import { COMMENT_COLOR_VARIABLE, SYNTAX_COLOR_VARIABLES } from "./theme";

const SCHEMES = ["light", "dark"] as const;

// テーマはエディタ面へ色相だけを渡す（ホストの `--ui-editor-hue`）。色相を 5 度刻みで一周させれば、
// 今あるテーマも、後から足すテーマも覆える
const HUES = Array.from({ length: 72 }, (_, index) => index * 5);

const CODE = "```ts\nconst a = 1;\n```";
const quoted = (lines: string) => lines.replaceAll(/^/gm, "> ");
const PLACES: readonly (readonly [place: string, doc: string])[] = [
  ["本文", CODE],
  ["引用", quoted(CODE)],
  ["リスト", `- 項目\n\n${CODE.replaceAll(/^/gm, "  ")}`],
  ...Object.keys(calloutAppearance).map(
    (type) => [`callout(${type})`, `> [!${type}]\n${quoted(CODE)}`] as const,
  ),
];

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc: string): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, { doc });
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

describe("code block language label", () => {
  it.each(SCHEMES.flatMap((scheme) => PLACES.map(([place, doc]) => [scheme, place, doc])))(
    "%s: %s のコードブロックの言語名が地に対してどの色相でも 4.5:1 以上",
    (scheme, _, doc) => {
      setScheme(scheme as (typeof SCHEMES)[number]);
      const v = mount(doc);
      const label = v.contentDOM.querySelector(".cm-lp-code-language");
      const line = label?.closest(".cm-line");
      if (!label || !line) throw new Error("the language label is not rendered");

      const failures = HUES.flatMap((hue) => {
        setEditorHue(hue);
        // callout の中の行の地は半透明（callout の色の 0.08）なので、エディタ面の地に重ねて測る
        const background = over(
          getComputedStyle(line).backgroundColor,
          resolve(v.contentDOM, "var(--ui-color-background)"),
        );
        const ratio = contrastRatio(colorOf(label), background);
        return ratio >= MIN_CONTRAST ? [] : [`hue ${hue}: ${ratio.toFixed(2)}:1`];
      });

      expect(failures).toEqual([]);
    },
  );
});

describe("選択したコードの構文色", () => {
  const FOREGROUNDS = [...SYNTAX_COLOR_VARIABLES, COMMENT_COLOR_VARIABLE];

  /** 選択の地にコードの行の地（半透明）を重ねた色に対する、各構文色の比が 4.5:1 を割る組 */
  function failuresOver(v: EditorView, label: string): string[] {
    const selection = v.dom.querySelector(".cm-selectionBackground");
    const line = v.contentDOM.querySelector(".cm-lp-code");
    if (!selection || !line) throw new Error("the selection or the code line is not rendered");
    return HUES.flatMap((hue) => {
      setEditorHue(hue);
      const ground = over(
        getComputedStyle(line).backgroundColor,
        toRgb(getComputedStyle(selection).backgroundColor),
      );
      return FOREGROUNDS.flatMap((variable) => {
        const ratio = contrastRatio(resolve(v.contentDOM, `var(${variable})`), ground);
        return ratio >= MIN_CONTRAST
          ? []
          : [`${label} hue ${hue} ${variable}: ${ratio.toFixed(2)}:1`];
      });
    });
  }

  it.each(SCHEMES)(
    "%s: focus の有無どちらの選択の上でも、構文色と comment がどの色相でも 4.5:1 以上",
    async (scheme) => {
      setScheme(scheme);
      const v = mount(`前\n\n${CODE}\n\n後`);
      v.focus();
      v.dispatch({ selection: EditorSelection.range(0, v.state.doc.length) });
      await vi.waitFor(() => {
        if (!v.dom.querySelector(".cm-selectionBackground")) throw new Error("not drawn yet");
      });
      const focused = failuresOver(v, "focused");

      v.contentDOM.blur();
      await vi.waitFor(() => expect(v.dom.classList.contains("cm-focused")).toBe(false));
      const blurred = failuresOver(v, "blurred");

      expect([...focused, ...blurred]).toEqual([]);
    },
  );
});
