import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { countColumn, type EditorState, type Range } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

export const CODE_BLOCK_NODES = new Set(["FencedCode", "CodeBlock"]);

/**
 * fenced/indented code の各行に等幅を強制する。`codeHighlightStyle` の `t.monospace` は
 * 言語指定の無い fence と indented code には効くが、言語指定付き fence（` ```ts ` など）は
 * `@lezer/markdown` の `parseCode` が埋め込み言語の parser を `overlay` mount で入れるため、
 * `@lezer/highlight` の `highlightRange` が overlay 内を inheritedClass を空にして解決し、
 * 埋め込み言語側の tag（`t.keyword` など）の span まで `t.monospace` の継承が届かない
 * （`theme.ts` の `codeHighlightStyle` 側のコメント参照）。行の class に font-family を直接
 * 持たせれば、span 側の継承に頼らず DOM のフラットな子要素すべてに効く（`theme.ts` の
 * `livePreviewTheme` の `.cm-lp-code`）。背景と余白もこの行 class に載せる。
 */
const codeLine = Decoration.line({ class: "cm-lp-code" });
// 地の角はブロックの上端と下端の行だけで丸める。行ごとに丸めると行の継ぎ目で角が欠けて見える。
const codeFirstLine = Decoration.line({ class: "cm-lp-code-first" });
const codeLastLine = Decoration.line({ class: "cm-lp-code-last" });
const openFenceLine = Decoration.line({ class: "cm-lp-code-open-fence" });

/** 行頭の字下げの桁数ごとの、折り返した行をそろえる line decoration */
const indentLines = new Map<number, Decoration>();

/**
 * 折り返した行を、その行の先頭の字下げにそろえる（ぶら下げインデント）。コードの行は等幅で描くので、
 * 字下げの幅は桁数を `ch` にすれば決まり、list-indent.ts のように書体から幅を見積もる必要が無い。
 * タブも CSS の tab-size（CodeMirror が `state.tabSize` で当てる）と同じ規則で桁に数える。
 */
function indentLine(state: EditorState, text: string): Decoration | null {
  const indent = /^[ \t]*/.exec(text)?.[0] ?? "";
  if (indent.length === 0 || indent.length === text.length) return null;
  const columns = countColumn(indent, state.tabSize);
  let decoration = indentLines.get(columns);
  if (!decoration) {
    decoration = Decoration.line({
      class: "cm-lp-code-indent",
      attributes: { style: `--cm-lp-code-indent: ${columns}ch` },
    });
    indentLines.set(columns, decoration);
  }
  return decoration;
}

/**
 * language-data の名前と別名に無いが、info string によく書かれる略記の表示名。language-data に
 * ある名前もこちらが先に効く（`bash` を「Shell」でなく「Bash」、`diff` を小文字でなく「Diff」、
 * `ini` を「Properties files」でなく「INI」で出す）。
 */
const DISPLAY_NAMES: ReadonlyMap<string, string> = new Map([
  ["bash", "Bash"],
  ["zsh", "Zsh"],
  ["py", "Python"],
  ["rs", "Rust"],
  ["kt", "Kotlin"],
  ["hs", "Haskell"],
  ["golang", "Go"],
  ["diff", "Diff"],
  ["mermaid", "Mermaid"],
  ["graphql", "GraphQL"],
  ["elixir", "Elixir"],
  ["ex", "Elixir"],
  ["exs", "Elixir"],
  ["md", "Markdown"],
  ["ini", "INI"],
]);

/**
 * ラベルに出す言語の表示名。fenced code の色分けと同じ language-data の名前を使い、bundle に
 * 載っている一覧をそのまま引く。名前と別名の完全一致だけで引き、色分け（lang-markdown）がする
 * 別名の部分一致では引かない。部分一致では `postcss` が CSS に、`text` が LaTeX になり、書いた名前と
 * 違う言語を名乗る。拡張子でも引かない。引けなければ書いたまま出す。
 */
function displayName(language: string): string {
  const key = language.toLowerCase();
  return (
    DISPLAY_NAMES.get(key) ??
    LanguageDescription.matchLanguageName(languages, key, false)?.name ??
    language
  );
}

export const CODE_START_LABEL = "コードブロックの始まり";
export const CODE_END_LABEL = "コードブロックの終わり";

/**
 * 支援技術にブロックの境目を伝える、幅の無い区切り。フェンスを隠すと境目を示すのは地の色だけになり、
 * 読み上げでは本文とコードの行が続いて聞こえる。名前は aria-label に置き、行の文字（textContent）や
 * ページ内検索に境目の言葉を混ぜない。役割は水平線（HorizontalRuleWidget）と同じ separator にそろえる。
 *
 * Chrome の AX ツリーに名前付きの separator として載ることはテストで確かめてある。VoiceOver や NVDA の
 * 実機で読まれるかは確かめていない。文字を持たない要素を飛ばす読み上げでも、境目が伝わらないだけで
 * 置く前と変わらない。
 */
function boundary(name: string): HTMLElement {
  const separator = document.createElement("span");
  separator.className = "cm-lp-code-boundary";
  separator.setAttribute("role", "separator");
  separator.setAttribute("aria-label", name);
  return separator;
}

/** 隠した開きフェンスの中身。境目と、info string があればその言語名のラベル */
class CodeOpenFenceWidget extends WidgetType {
  constructor(private readonly language: string) {
    super();
  }

  override eq(other: CodeOpenFenceWidget): boolean {
    return other.language === this.language;
  }

  override toDOM(): HTMLElement {
    const fence = document.createElement("span");
    fence.className = "cm-lp-code-fence";
    fence.append(boundary(CODE_START_LABEL));
    if (this.language) {
      const label = document.createElement("span");
      label.className = "cm-lp-code-language";
      // info string は本文の一部（ユーザーの入力）なので textContent だけで組む
      label.textContent = this.language;
      fence.append(label);
    }
    return fence;
  }

  // 既定の true だとクリックを editor が無視し、カーソルをフェンスに置いて source を出せない
  // （HorizontalRuleWidget と同じ理由）。
  override ignoreEvent(): boolean {
    return false;
  }
}

class CodeCloseFenceWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  override toDOM(): HTMLElement {
    return boundary(CODE_END_LABEL);
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

const closeFence = Decoration.replace({ widget: new CodeCloseFenceWidget() });

// pandoc の属性形式（`{.python .numberLines}`、`{#id .python}`）では最初の class が言語になる。
// 引用符の中（`{title="a .b" .python}`）の `.` は class ではないので、引用符の対は丸ごと読み飛ばす
const PANDOC_LANGUAGE = /^\{(?:(?:[^}"]|"[^"]*")*?\s)??\.([^\s{}"]+)/;

/** info string の言語名。pandoc の属性形式から取れなければ先頭の語 */
function languageOf(info: string): string {
  return PANDOC_LANGUAGE.exec(info)?.[1] ?? info.split(/\s/)[0] ?? "";
}

/**
 * コードブロックの各行に、地と書体と、折り返した行を字下げにそろえる line decoration を付ける。
 * `visible` の外の行には付けない
 */
export function decorateCodeLines(
  state: EditorState,
  block: SyntaxNode,
  visible: (from: number, to: number) => boolean,
  out: Range<Decoration>[],
): void {
  const first = state.doc.lineAt(block.from);
  const last = state.doc.lineAt(block.to);
  for (let number = first.number; number <= last.number; number += 1) {
    const line = state.doc.line(number);
    if (!visible(line.from, line.to)) continue;
    out.push(codeLine.range(line.from));
    if (number === first.number) out.push(codeFirstLine.range(line.from));
    if (number === last.number) out.push(codeLastLine.range(line.from));
    const indent = indentLine(state, line.text);
    if (indent) out.push(indent.range(line.from));
  }
}

/**
 * fenced code のフェンス行の中身を隠す。呼び出し側は、ブロック全体が source を出す対象でないときだけ
 * 呼ぶ（行ごとに判定すると、本文の行にカーソルがあるときフェンスが消えたままになり、言語を書き換えられない）。
 *
 * 行そのものは消さず、行の中の記法だけを置き換える。行の高さが残るので、カーソルが入って
 * フェンスが現れても本文の行は上下に動かない。開きフェンスは info string の言語名を、表示名にして
 * 行の右端のラベルに置き換え、閉じフェンスは見た目を空にする。どちらにも読み上げ用の境目を置く。
 * 範囲は記法の先頭から行末までで、前にある字下げや引用の `>`（他の記法の持ち物）は含めない。
 */
export function concealFences(
  state: EditorState,
  block: SyntaxNode,
  conceal: (from: number, to: number, decoration?: Decoration) => void,
  out: Range<Decoration>[],
): void {
  const marks = block.getChildren("CodeMark");
  const open = marks[0];
  if (!open) return;
  const openLine = state.doc.lineAt(open.from);
  const info = block.getChild("CodeInfo");
  const language = info ? languageOf(state.doc.sliceString(info.from, info.to)) : "";
  if (language) out.push(openFenceLine.range(openLine.from));
  conceal(
    open.from,
    openLine.to,
    Decoration.replace({
      widget: new CodeOpenFenceWidget(language ? displayName(language) : ""),
    }),
  );

  // 閉じフェンスの無い（doc の末尾まで続く）ブロックでは、CodeMark は開きの 1 つだけになる
  const close = marks.length > 1 ? marks[marks.length - 1] : undefined;
  if (close && close.from > openLine.to) {
    conceal(close.from, state.doc.lineAt(close.from).to, closeFence);
  }
}
