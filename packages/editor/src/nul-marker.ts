import { type Extension, RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { decorationPlugin } from "./decoration-plugin";

const nulMark = Decoration.mark({ class: "cm-nul" });

/**
 * 本文の NUL に赤い印を付ける。NUL は幅が無く画面に出ないが、保存では拒まれるので、
 * どこにあるかを見せないと消せない。
 *
 * replace の widget にせず mark にするのは、選択とカーソルが NUL の前後に置けるままにするため
 * （IME 不変条件 2）。印は疑似要素に描くので、doc の文字と位置は変わらない。
 */
export function nulMarker(): Extension {
  return [
    decorationPlugin({
      name: "nul",
      build(view) {
        const builder = new RangeSetBuilder<Decoration>();
        for (const { from, to } of view.visibleRanges) {
          const text = view.state.sliceDoc(from, to);
          for (let i = text.indexOf("\u0000"); i !== -1; i = text.indexOf("\u0000", i + 1)) {
            builder.add(from + i, from + i + 1, nulMark);
          }
        }
        return { decorations: builder.finish() };
      },
    }),
    nulTheme,
  ];
}

const nulTheme = EditorView.baseTheme({
  ".cm-nul::after": {
    // 読み上げでは文字の名前だけを伝える。alt text の構文を解さないブラウザは前の宣言を使う
    content: '"NUL"',
    content_alt: '"NUL" / "NUL 文字"',
    display: "inline-block",
    padding: "0 2px",
    marginInline: "1px",
    border: "1px solid var(--ui-color-danger)",
    borderRadius: "var(--ui-radius-sm, 3px)",
    color: "var(--ui-color-danger)",
    fontFamily: "var(--ui-font-mono)",
    fontSize: "0.75em",
    lineHeight: "1.2",
    verticalAlign: "0.1em",
    pointerEvents: "none",
  },
});
