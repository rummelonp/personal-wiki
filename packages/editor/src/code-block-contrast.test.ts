import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { calloutAppearance } from "./callout";
import { createEditor } from "./create-editor";
import { colorOf, contrastRatio, MIN_CONTRAST, over, resolve } from "./test-contrast";
import { resetEditorHue, resetScheme, setEditorHue, setScheme } from "./test-tokens";

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
