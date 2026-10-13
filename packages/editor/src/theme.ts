import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { calloutTypeStyles } from "./callout";
import { byScheme } from "./scheme";

/**
 * コードの構文色。色相そのものに意味がある（文字列と数値を見分ける）ので役割 token では表せず、
 * packages/editor が明暗の組で持つ。
 *
 * 値は view に CSS 変数として置き、`HighlightStyle` からは変数名だけを参照する。`HighlightStyle` が
 * 作る class 名は生成されたもので外から辿れないため、変数名を通してしか test が解決後の色を読めない。
 * 明るい側は白いエディタ面に、暗い側は暗いエディタ面に対して 4.5:1 以上（`theme.test.ts` が測る）。
 */
const SYNTAX_COLORS = {
  meta: ["#404740", "#a6b3a6"],
  keyword: ["#7a1ea0", "#d9a2ef"],
  atom: ["#2b31b8", "#9db3ff"],
  literal: ["#116644", "#6fd08a"],
  string: ["#aa1111", "#ff9e9e"],
  escape: ["#b34700", "#ffab70"],
  definition: ["#1d4ed8", "#8ab4ff"],
  local: ["#5b30c8", "#b39dff"],
  type: ["#0f766e", "#5ed4cf"],
  // style-mod は camelCase の key を dash 区切りに直すので、変数名は小文字とハイフンだけで書く
  "class-name": ["#116677", "#7fd1e8"],
  special: ["#225566", "#9ec7d8"],
  property: ["#0b5bd3", "#9bb8ff"],
} as const satisfies Record<string, readonly [light: string, dark: string]>;

type SyntaxColor = keyof typeof SYNTAX_COLORS;

/** 解決後の色を読むための変数名。`theme.test.ts` がコントラスト比を測るのに使う */
export const SYNTAX_COLOR_VARIABLES: readonly string[] = Object.keys(SYNTAX_COLORS).map(
  (name) => `--cm-syntax-${name}`,
);

const syntaxColor = (name: SyntaxColor) => `var(--cm-syntax-${name})`;

// 変数は view の root に置く。切り替え（`--ui-light`、`--ui-dark`）は祖先の領域から継承する
const syntaxColorVariables = EditorView.baseTheme({
  "&": Object.fromEntries(
    Object.entries(SYNTAX_COLORS).map(([name, [light, dark]]) => [
      `--cm-syntax-${name}`,
      byScheme(light, dark),
    ]),
  ),
});

/**
 * @codemirror/language の `defaultHighlightStyle` と同じ tag の組に、明暗の組を持つ色を当てたもの。
 * 色以外の装飾も大半は `defaultHighlightStyle` のままにしてある。
 * comment と invalid は色相に意味が無いので、構文色でなく役割 token を使う。
 *
 * 見出し（`t.heading`。ATX/setext の 1〜6、`/...` 指定で見出し行の inline 装飾にも掛かる）は
 * `defaultHighlightStyle` の下線を外し、大きさと太さだけで本文と区別する。下線は
 * リンク（`t.link`）の記号として既に使っており、見出しに残すと壊れたリンクと見分ける手掛かりが
 * 一つ減る。大きさは `livePreviewTheme` の `.cm-lp-h1`〜`.cm-lp-h3` が持つ（見出し行はここでは
 * 太さと書体だけを当て、mark 自体には大きさを持たせない。source を出したとき見出し行の高さが
 * 大きさで乱れないようにするため、大きさは `Decoration.line` の class 側に置く）。
 *
 * `t.monospace`（インラインコードと fenced/indented code の `CodeText`。lang-markdown が
 * 両方をこの 1 tag にまとめている）に等幅を当てるのはここだけで、他の text はすべて
 * `--ui-font-body`/`--ui-font-heading` に従う（`typographyTheme`）。CodeMirror の既定は
 * `.cm-scroller` を丸ごと等幅にするので、ここで上書きしないと等幅がコード以外にも及ぶ。
 *
 * ただし言語指定付き fence（` ```ts ` など）は `@lezer/markdown` が埋め込み言語の parser を
 * `overlay` mount で入れる。`@lezer/highlight` は overlay 内を inheritedClass を空にして解決するため、
 * 埋め込み言語側の tag（`t.keyword` など）の span にはこの `t.monospace` の class が継承されない。
 * その分は `code-block.ts` が `FencedCode`/`CodeBlock` の各行に付ける `.cm-lp-code`
 * （`livePreviewTheme`）が、span 側の継承でなく行の DOM 継承で補う。
 */
const codeHighlightStyle = HighlightStyle.define([
  { tag: t.meta, color: syntaxColor("meta") },
  { tag: t.link, color: "var(--ui-color-accent)", textDecoration: "underline" },
  { tag: t.heading, fontFamily: "var(--ui-font-heading)", fontWeight: "700" },
  { tag: t.monospace, fontFamily: "var(--ui-font-mono, ui-monospace, monospace)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.keyword, color: syntaxColor("keyword") },
  { tag: [t.atom, t.bool, t.url, t.contentSeparator, t.labelName], color: syntaxColor("atom") },
  { tag: [t.literal, t.inserted], color: syntaxColor("literal") },
  { tag: [t.string, t.deleted], color: syntaxColor("string") },
  { tag: [t.regexp, t.escape, t.special(t.string)], color: syntaxColor("escape") },
  { tag: t.definition(t.variableName), color: syntaxColor("definition") },
  { tag: t.local(t.variableName), color: syntaxColor("local") },
  { tag: [t.typeName, t.namespace], color: syntaxColor("type") },
  { tag: t.className, color: syntaxColor("class-name") },
  { tag: [t.special(t.variableName), t.macroName], color: syntaxColor("special") },
  { tag: t.definition(t.propertyName), color: syntaxColor("property") },
  { tag: t.comment, color: "var(--ui-color-muted)" },
  { tag: t.invalid, color: "var(--ui-color-danger)" },
]);

/** 構文色。色の変数を view に置いてから当てる */
export const codeHighlighting: Extension = [
  syntaxColorVariables,
  syntaxHighlighting(codeHighlightStyle, { fallback: true }),
];

/**
 * 本文の書体・大きさ・行間。`.cm-scroller` は CodeMirror 自身の `baseTheme` が
 * `font-family: monospace` を既定で当てており（`Prec.fallback`）、`EditorView.theme` は
 * 既定より優先されるためここで上書きできる。等幅はコードだけに使う。コード自身の書体は
 * `codeHighlightStyle` の `t.monospace` が span に直接 font-family を当てる（子孫要素への
 * 直接の宣言は祖先からの継承に常に勝つので、この rule との宣言順には依存しない）。
 *
 * 16px・行の高さ 1.75 は本文用。`rem` にせず固定 px にしているのは、ホストの
 * root の font-size が変わっても本文の大きさを固定するため（Editor はホストの
 * spacing のように rem で揃える対象ではなく、可読性の基準そのものである）。
 */
export const typographyTheme = EditorView.theme({
  "&": { fontFamily: "var(--ui-font-body)" },
  ".cm-scroller": { fontFamily: "var(--ui-font-body)", fontSize: "16px", lineHeight: "1.75" },
});

/**
 * CodeMirror 自身が持つ色の上書き。本文の view と title 欄の両方に入れる。
 *
 * CodeMirror は明暗を `EditorView.darkTheme` facet で切り替えるが、このアプリの明暗は CSS の切り替えなので
 * facet では決まらない（view を作り直さずに変わる）。view には常に `cm-light` が付くため、`&light` の規則だけが
 * 当たる。その規則を役割 token で上書きする。selector を `&light` に揃え、class を重ねて詳細度を 1 つ上げてあるのは、
 * base theme どうしの適用順に頼らず確実に勝たせるため。
 */
export const editorSurfaceTheme = EditorView.baseTheme({
  "&light .cm-cursor, &light .cm-dropCursor": { borderLeftColor: "var(--ui-color-text)" },
  "&light .cm-selectionLayer .cm-selectionBackground.cm-selectionBackground": {
    background: "color-mix(in srgb, var(--ui-color-accent) 14%, var(--ui-color-background))",
  },
  "&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground.cm-selectionBackground":
    {
      background: "color-mix(in srgb, var(--ui-color-accent) 22%, var(--ui-color-background))",
    },
  "&light .cm-tooltip.cm-tooltip": {
    border: "1px solid var(--ui-color-border)",
    backgroundColor: "var(--ui-color-background)",
    color: "var(--ui-color-text)",
  },
  "&light .cm-tooltip-section:not(:first-child)": { borderTop: "1px solid var(--ui-color-border)" },
  "&light .cm-tooltip-autocomplete.cm-tooltip-autocomplete ul li[aria-selected]": {
    background: "var(--ui-color-accent)",
    color: "var(--ui-color-on-accent)",
  },
});

const CODE_BLOCK_RADIUS = "var(--ui-radius-sm, 0.25rem)";
const CODE_BLOCK_GAP = "var(--ui-space-2, 0.5rem)";

/**
 * Live Preview が付けるクラスの最小限の見た目。色と書体はホストの CSS 変数から受け取り、
 * テーマごとの作り込みはここに置かない。
 */
export const livePreviewTheme = EditorView.baseTheme({
  // fenced/indented code の行ごとの等幅強制（code-block.ts の decorateCodeLines）に加え、
  // 背景と左右の余白。フェンス記号や言語指定の行にも及ぶので、`t.monospace` の span 継承が
  // overlay mount で途切れるケース（codeHighlightStyle のコメント参照）も含めて等幅にできる。
  ".cm-line.cm-lp-code": {
    fontFamily: "var(--ui-font-mono, ui-monospace, monospace)",
    paddingLeft: "0.75em",
    paddingRight: "0.75em",
  },
  // 引用と callout の中では丸めない。角丸は行の背景ごと切り抜くので、引用のバー（background-image）と
  // callout の地（background-color）が角で欠ける。
  ".cm-line.cm-lp-code-first:not(.cm-lp-blockquote)": {
    borderTopLeftRadius: CODE_BLOCK_RADIUS,
    borderTopRightRadius: CODE_BLOCK_RADIUS,
  },
  ".cm-line.cm-lp-code-last:not(.cm-lp-blockquote)": {
    borderBottomLeftRadius: CODE_BLOCK_RADIUS,
    borderBottomRightRadius: CODE_BLOCK_RADIUS,
  },
  // 言語名のラベル（隠した開きフェンスの行）。流れの外に置いて行の右端に寄せる。流れの中で
  // 右寄せにすると、同じ行の前にある字下げや箇条書きの「•」まで右へ寄る。
  ".cm-line.cm-lp-code-open-fence": { position: "relative" },
  ".cm-lp-code-language": {
    position: "absolute",
    top: "50%",
    // 行の右の padding（行の文字で 0.75em）と揃える。ラベルの文字は 0.75 倍なので 1em で同じ幅になる
    right: "1em",
    transform: "translateY(-50%)",
    fontFamily: "var(--ui-font-body)",
    fontSize: "0.75em",
    // muted のままでは明るい側で 4.5:1 を割る。今あるテーマでは callout の地（苔で 4.38:1）が、
    // エディタ面の地は黄系の色相（60 前後）のテーマを足したときに割れる（code-block-contrast.test.ts が色相を一周させて測る）。
    // 本文の色へ 2 割寄せ、補助の文字に見える濃さで足りさせる
    color: "color-mix(in srgb, var(--ui-color-muted) 80%, var(--ui-color-text))",
    userSelect: "none",
    // 流れの外にあるので行の中身に押し返されず、長い言語名が行の左の字下げや「•」に重なるため、幅に上限を付ける
    maxWidth: "50%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // ブロックの上と下に地の外の隙間を空け、前後の本文と離す。margin は CodeMirror が行の高さに数えない
  // （見出しの余白と同じ理由）ので、行の高さに入る透明な border で空け、地は padding-box で切る。
  // 角丸は border の外側の縁で効くので、縦の半径に隙間の分を足して地の角を丸いまま保つ。
  // forced-colors では透明な border も CanvasText で塗られ太い線になるので空けず、下の 1px の線だけにする。
  // 引用と callout の中では空けない。地を切ると引用のバーと callout の地も隙間で途切れる。
  "@media (forced-colors: none)": {
    ".cm-line.cm-lp-code-first:not(.cm-lp-blockquote)": {
      borderTop: `${CODE_BLOCK_GAP} solid transparent`,
      backgroundClip: "padding-box",
      borderTopLeftRadius: `${CODE_BLOCK_RADIUS} calc(${CODE_BLOCK_RADIUS} + ${CODE_BLOCK_GAP})`,
      borderTopRightRadius: `${CODE_BLOCK_RADIUS} calc(${CODE_BLOCK_RADIUS} + ${CODE_BLOCK_GAP})`,
    },
    ".cm-line.cm-lp-code-last:not(.cm-lp-blockquote)": {
      borderBottom: `${CODE_BLOCK_GAP} solid transparent`,
      backgroundClip: "padding-box",
      borderBottomLeftRadius: `${CODE_BLOCK_RADIUS} calc(${CODE_BLOCK_RADIUS} + ${CODE_BLOCK_GAP})`,
      borderBottomRightRadius: `${CODE_BLOCK_RADIUS} calc(${CODE_BLOCK_RADIUS} + ${CODE_BLOCK_GAP})`,
    },
  },
  // 折り返した行を行頭の字下げにそろえる（code-block.ts の indentLine）。list と同じ理由で hanging にする。
  // 字下げが行の半分を越える行は半分で止める。そろえると、折り返した行が狭い幅で右へはみ出す。
  ".cm-line.cm-lp-code-indent": { textIndent: "min(var(--cm-lp-code-indent), 50%) hanging" },
  ".cm-line.cm-lp-code-indent *": { textIndent: "0" },
  // forced-colors では地の色が Canvas に揃えられ、フェンスを隠したブロックの範囲が見えなくなるので線で示す
  "@media (forced-colors: active)": {
    ".cm-line.cm-lp-code-first": { borderTop: "1px solid CanvasText" },
    ".cm-line.cm-lp-code-last": { borderBottom: "1px solid CanvasText" },
  },
  // callout の中の code block は `cm-lp-code` と `cm-lp-callout` の両方が同じ行に付く。不透明な
  // surface 色をそのまま当てると callout の 0.08 の地（`.cm-lp-callout` 側）を完全に潰すので、
  // 単独のときだけ surface 色を足す。callout 側の地は残る。
  ".cm-line.cm-lp-code:not(.cm-lp-callout)": {
    backgroundColor: "var(--ui-color-surface)",
  },
  ".cm-lp-heading": { fontWeight: "700" },
  // title（28px 固定、title-editor.ts）より必ず小さくし、本文の 1 行目のように続けて見える
  // title を見出しの頂点に保つ。h4〜h6 は本文と同じ大きさのまま太さだけで区別する。
  ".cm-lp-h1": { fontSize: "1.5em" },
  ".cm-lp-h2": { fontSize: "1.25em" },
  ".cm-lp-h3": { fontSize: "1.125em" },
  // 節の区切りを見つけやすくする上の余白。margin でなく padding にするのは、CodeMirror が行の高さを
  // 行の border box で測り、margin を測らないため（margin にするとクリック位置やスクロールがずれる）。
  // 行の class に置くので、カーソルが入って `#` を出しても余白は変わらない。
  ".cm-line.cm-lp-h1": { paddingTop: "var(--ui-space-6, 1.5rem)" },
  ".cm-line.cm-lp-h2": { paddingTop: "var(--ui-space-4, 1rem)" },
  ".cm-line.cm-lp-h3": { paddingTop: "var(--ui-space-3, 0.75rem)" },
  ".cm-line.cm-lp-h4, .cm-line.cm-lp-h5, .cm-line.cm-lp-h6": {
    paddingTop: "var(--ui-space-2, 0.5rem)",
  },
  ".cm-line.cm-lp-heading.cm-lp-heading-leading, .cm-line.cm-lp-heading.cm-lp-heading-continued": {
    paddingTop: "0",
  },
  // ぶら下げインデント。`--cm-lp-list-indent` は行頭から本文の始まりまでの幅（list-indent.ts）。
  // padding を広げて負の text-indent で 1 行目を戻す形にしないのは、タブ位置が padding の内側の端
  // （折り返した行の始まり）を起点に並ぶため。行頭の記号の前後にタブがあると本文の始まりがその格子に
  // 引きずられ、どんな幅を指定してもそろわない。`hanging` なら 1 行目は内側の端から始まる。
  ".cm-line.cm-lp-list": { textIndent: "var(--cm-lp-list-indent) hanging" },
  // text-indent は継承するので、行の中の inline-block（embed や罫線の widget）の 1 行目までずらさない
  ".cm-line.cm-lp-list *": { textIndent: "0" },
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-strike": { textDecoration: "line-through" },
  // 蛍光ペンの地。透かさず地に混ぜるのは、重なった行の装飾（callout の地）で濃さが変わらないようにするため
  ".cm-lp-highlight": {
    backgroundColor: byScheme(
      "color-mix(in srgb, #ffd000 40%, var(--ui-color-background))",
      "color-mix(in srgb, #ffd000 26%, var(--ui-color-background))",
    ),
  },
  // 背景は code block の行と同じ surface 色。文字色は変えないので、code block と同じ組み合わせで読める。
  // 等幅は構文 highlight の `t.monospace` も当てるが、mark 自身にも持たせる。記号を隠した
  // 外側の mark と内側の span で書体が食い違うと、padding の幅が本文の書体で測られてずれる。
  ".cm-lp-inline-code": {
    fontFamily: "var(--ui-font-mono, ui-monospace, monospace)",
    backgroundColor: "var(--ui-color-surface)",
    borderRadius: "var(--ui-radius-sm, 0.25rem)",
    padding: "0.1em 0.25em",
  },
  ".cm-lp-comment": { color: "var(--ui-color-muted)" },
  ".cm-line.cm-lp-comment-hidden": { display: "none" },
  // frontmatter（frontmatter-block.ts）。畳んだ枠は開き `---` の行に置く。2 行目以降は畳んだ
  // callout の本文と同じく行ごと CSS で消す。
  // `display: block` にしてはいけない。CodeMirror は inline の replace widget の前後に
  // `img.cm-widgetBuffer`（高さ 1em）を置くので、widget が block になると前後の buffer が
  // それぞれ独立した行ボックスになり、枠の上下に本文 1 行分の空白が出る。
  // inline-block のまま幅を行いっぱいにして、buffer を枠と同じ行ボックスに収める。
  ".cm-frontmatter": {
    display: "inline-block",
    width: "100%",
    boxSizing: "border-box",
    verticalAlign: "top",
    border: "1px solid var(--ui-color-border)",
    borderRadius: "var(--ui-radius-sm, 0.25rem)",
    padding: "0.25em 0.6em",
    backgroundColor: "var(--ui-color-surface)",
    cursor: "pointer",
    fontSize: "0.875em",
  },
  ".cm-line.cm-frontmatter-folded": { display: "none" },
  // source は YAML なので等幅にし、畳んだ枠と同じ地で本文と区切る。文字色は本文のままにして、
  // 明暗どちらの地でも読める状態を `.cm-lp-code` と同じ組み合わせに揃える。
  ".cm-line.cm-frontmatter-source": {
    backgroundColor: "var(--ui-color-surface)",
    fontFamily: "var(--ui-font-mono, ui-monospace, monospace)",
    paddingLeft: "0.75em",
    paddingRight: "0.75em",
  },
  ".cm-frontmatter-chip": {
    display: "inline-block",
    marginRight: "0.35em",
    borderRadius: "var(--ui-radius-sm, 0.25rem)",
    padding: "0 0.3em",
    border: "1px solid var(--ui-color-border)",
    color: "var(--ui-color-text)",
  },
  // tag の chip は本文中の `#tag` と同じ見た目にする（`.cm-tag` が色と地を持つ）
  ".cm-frontmatter-chip.cm-tag": { border: "0" },
  ".cm-frontmatter-label": { marginRight: "0.35em", color: "var(--ui-color-muted)" },
  ".cm-wikilink": {
    color: "var(--ui-color-accent)",
    textDecoration: "underline",
    cursor: "pointer",
  },
  // 未解決のリンクは補助の文字色にして、accent の破線でリンクであることだけを残す
  ".cm-wikilink-unresolved": {
    color: "var(--ui-color-muted)",
    textDecoration: "underline dashed",
    textDecorationColor: "var(--ui-color-accent)",
  },
  // 文字は内側の構文 highlight（t.link）の span が持ち、その accent 色と実線が上の指定を覆ってしまう
  ".cm-wikilink-unresolved *": { color: "inherit", textDecoration: "none" },
  // markdown link（`[text](url)`）の可視テキスト。URL は隠すのでリンクだと分かるのはこの装飾だけ。
  ".cm-md-link": {
    color: "var(--ui-color-accent)",
    textDecoration: "underline",
    cursor: "pointer",
  },
  // autolink は URL 自体が可視テキストなので、色は syntax highlight（`t.url`）に残し、
  // `<a>` にしたことで乗るブラウザ既定のリンク色だけを打ち消す
  ".cm-autolink": { color: "inherit", textDecoration: "underline", cursor: "pointer" },
  ".cm-tag": {
    color: "var(--ui-color-accent)",
    backgroundColor: "var(--ui-color-accent-soft)",
    borderRadius: "var(--ui-radius-sm, 0.25rem)",
    padding: "0 0.2em",
    cursor: "pointer",
  },
  ".cm-block-ref-highlight": {
    backgroundColor: "color-mix(in srgb, var(--ui-color-accent) 24%, var(--ui-color-background))",
  },
  ".cm-lp-hr": {
    display: "inline-block",
    width: "100%",
    verticalAlign: "middle",
    borderTop: "1px solid var(--ui-color-border)",
  },
  // 入れ子の深さ（blockquote.ts が渡す `--cm-lp-quote-depth`）の本数だけ、1rem 間隔でバーを描く。
  // em にしないのは、見出し行（`.cm-lp-h1` など）で間隔が広がり、前後の行とバーと本文の位置がずれるため。
  // `.cm-line` の既定の padding を上書きするため、`.cm-line` と重ねて詳細度を上げる。
  ".cm-line.cm-lp-blockquote": {
    paddingLeft: "calc(6px + var(--cm-lp-quote-depth) * 1rem)",
    backgroundImage:
      "repeating-linear-gradient(to right, var(--cm-lp-quote-bar, var(--ui-color-border)) 0 3px, transparent 3px 1rem)",
    backgroundSize: "calc(var(--cm-lp-quote-depth) * 1rem) 100%",
    backgroundPosition: "6px 0",
    backgroundRepeat: "no-repeat",
  },
  // セルの前後の空白は描かない（table.ts の spaceMark）ので、罫線から文字までの余白は左右の padding
  // （`--cm-lp-table-pad`）だけで取る。
  // 罫線はすべてセルが持つ。各セルが右と下、1 列目が左、見出しのセルが上の線を引くと、格子が外枠まで
  // 閉じる。行（`.cm-line`）に線を持たせないのは、行の箱が表の右端を越えて editor の幅いっぱいに
  // 広がり、引用の中ではバーの左まで届くため。
  // min-width は table.ts が測った文字の幅なので content-box で効かせる。host が全要素を border-box に
  // していると、padding と線の分だけ中身の幅が足りず、文字の長い行のセルが
  // 押し広げられて列の線がずれる。
  //
  // 列の幅は table.ts の fitExpression が組む上限（`--cm-lp-table-fit`）まで詰め、長いセルは列の中で
  // 折り返す。行を flex にするのは、折り返して高くなったセルに同じ行のセルの高さをそろえ、下の線を
  // 一直線にするため（inline-block のままだと短いセルの下の線が 1 行目の高さで止まる）。flex の行は
  // セルを次の表示行へ送らない。`--cm-lp-table-available` は行頭の字下げ、セルの padding と線を除いた、
  // 列に配れる幅で、`100%` は使う側（セル）の包含ブロック、つまり行の幅で解ける。
  ".cm-line.cm-lp-table-row": {
    display: "flex",
    "--cm-lp-table-pad": "var(--ui-space-2, 0.5rem)",
    "--cm-lp-table-available":
      "(100% - var(--cm-lp-table-indent) - var(--cm-lp-table-columns) * (2 * var(--cm-lp-table-pad) + 1px) - 1px)",
  },
  ".cm-lp-table-indent": { flex: "none" },
  ".cm-lp-table-cell": {
    boxSizing: "content-box",
    display: "inline-block",
    flex: "none",
    verticalAlign: "top",
    // 実測の幅は下限として効かせ、上限より長い列は上限ちょうどにする。max-width を実測の幅にしないのは、
    // 測った幅より広く描かれる字（書体の混在）を、欄に余裕があるのに折り返させないため。
    minWidth: "min(var(--cm-lp-table-width), var(--cm-lp-table-fit))",
    maxWidth: "var(--cm-lp-table-fit)",
    padding: "0 var(--cm-lp-table-pad)",
    borderRight: "1px solid var(--ui-color-border)",
    borderBottom: "1px solid var(--ui-color-border)",
    // CodeMirror の break-spaces のままだと、折り返す位置の空白が列に入りきらないときに空白だけの行が
    // 増える。pre-wrap は行末の空白をはみ出させる。rendered のセルにはカーソルが入らないので、
    // break-spaces が守る行末の空白の上のカーソル位置は要らない。
    whiteSpace: "pre-wrap",
  },
  // セルの中身の前後の空白（table.ts の spaceMark）。揃えは下の text-align で付ける
  ".cm-lp-table-space": { display: "none" },
  ".cm-lp-table-cell.cm-lp-table-align-center": { textAlign: "center" },
  ".cm-lp-table-cell.cm-lp-table-align-right": { textAlign: "right" },
  // 空のセル（table.ts の EmptyCellWidget）に幅 0 の文字を置き、隣のセルと同じ高さの line box を持たせる
  ".cm-lp-table-cell-empty::before": { content: '"\\200b"' },
  ".cm-lp-table-cell.cm-lp-table-cell-first": { borderLeft: "1px solid var(--ui-color-border)" },
  // 見出し行は地を敷いて本文行と分け、下の線を太くして区切りを残す。
  ".cm-lp-table-cell.cm-lp-table-header": {
    borderTop: "1px solid var(--ui-color-border)",
    borderBottomWidth: "2px",
    backgroundColor: "var(--ui-color-surface)",
  },
  // pipe は幅 0 の inline-block にして、セルどうしを隙間なく並べる。`|` の字幅が残るとセルの線が
  // そこで途切れ、区切りの左右で余白も字幅の分だけ食い違う。高さはセルと同じ行の高さになる。
  ".cm-lp-table-pipe": {
    display: "inline-block",
    verticalAlign: "top",
    width: "0",
    overflow: "hidden",
    color: "transparent",
  },
  // `|` は構文ハイライトの span（TableDelimiter は t.meta の色を持つ）に包まれて描かれ、span 自身の
  // 色が pipe の透明に勝って `|` が見えてしまう。中の span には色を持たせず透明を継がせる。
  ".cm-lp-table-pipe *": { color: "inherit" },
  ".cm-lp-table-delimiter": { fontSize: "0" },
  // callout はバーをタイプの色にし、行の背景を薄く塗る。色とアイコンは callout.ts の表から来る。
  ".cm-line.cm-lp-callout": {
    "--cm-lp-quote-bar": "rgb(var(--cm-lp-callout-color))",
    backgroundColor: "rgb(var(--cm-lp-callout-color) / 0.08)",
  },
  ".cm-lp-callout-title": { fontWeight: "600", color: "rgb(var(--cm-lp-callout-color))" },
  // 畳んだ本文の行。plugin の decoration は改行を置き換えられないので、行ごと CSS で消す。
  ".cm-line.cm-lp-callout-folded": { display: "none" },
  ".cm-lp-callout-icon::before": {
    content: "var(--cm-lp-callout-icon)",
    display: "inline-block",
    minWidth: "1.2em",
  },
  ".cm-lp-callout-fold": { cursor: "pointer", paddingLeft: "0.4em", userSelect: "none" },
  ".cm-lp-callout-fold::before": { content: '"▾"' },
  '.cm-lp-callout-fold[aria-expanded="false"]::before': { content: '"▸"' },
  ...calloutTypeStyles,
});
