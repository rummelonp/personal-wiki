import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, type EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { type BuiltDecorations, decorationPlugin } from "./decoration-plugin";
import { createRevealTest } from "./reveal";

// GFM Table の node 名。parser は createEditor が base にしている lang-markdown の
// `markdownLanguage`（GFM 入り）が持つので、`packages/markdown` には定義が無い。
const TABLE = "Table";
const TABLE_HEADER = "TableHeader";
const TABLE_ROW = "TableRow";
const TABLE_DELIMITER = "TableDelimiter";

const delimiterRow = Decoration.line({ class: "cm-lp-table-delimiter" });
const pipeMark = Decoration.mark({ class: "cm-lp-table-pipe" });

/**
 * 列幅を測るための、DOM に繋がない canvas の 2D context。`measureText` は DOM のレイアウトを
 * 読まないので、build()（visibleRanges だけを扱う軽い呼び出し。decoration-plugin.ts）の中で
 * 呼んでも読み書きの往復（layout thrash）が起きない。
 */
let measureContext: CanvasRenderingContext2D | null = null;

function getMeasureContext(): CanvasRenderingContext2D {
  measureContext ??= document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
  return measureContext;
}

/**
 * セルの文字幅を測るときに使う font。表の中で `**bold**` や `` `code` `` のように書体が変わる
 * 記法を使っても、本文の font だけで測る（`ch` 単位で数えていた頃と同じ簡略化。記法の文字自体は
 * 測定に含まれるが描画では隠れるので、太さが変わる記法の直後などでは実描画幅とわずかにずれうる）。
 *
 * TableHeader の中身だけは例外。lang-markdown の構文ハイライトが `tags.heading` を当て、
 * theme.ts の heading 用ルール（fontWeight 700）で bold に描かれるため、本文の weight で測ると
 * header セルの実描画幅が min-width を上回り、header の文字が長い列ほど pipe が右にずれる。
 * ここで測る weight を切り替えて実際の描画と合わせる。
 */
const TABLE_HEADER_FONT_WEIGHT = "700";

function editorFont(view: EditorView, header: boolean): string {
  const style = getComputedStyle(view.contentDOM);
  const weight = header ? TABLE_HEADER_FONT_WEIGHT : style.fontWeight;
  return `${style.fontStyle} ${weight} ${style.fontSize} ${style.fontFamily}`;
}

/**
 * `measureText` の advance width と実際の DOM 描画の間に生じうるサブピクセル差を吸収する余白。
 * min-width は下限（floor）なので、実際の幅がこれよりわずかに大きくても、その列の右端の
 * 余白が増えるだけで揃えは崩れない。逆（実際より大きく見積もる）は起こしたくないので、
 * 丸めは切り上げにする。
 */
const MEASURE_SLACK_PX = 1;

function measureWidth(ctx: CanvasRenderingContext2D, text: string): number {
  return Math.ceil(ctx.measureText(text).width) + MEASURE_SLACK_PX;
}

/**
 * 列幅の上限の CSS 式。列の実測幅 w_i を「行の欄に入る幅」A まで詰めるとき、短い列は w_i のまま残し、
 * 長い列だけを共通の上限 X にそろえて削る（列 i の幅は min(w_i, X)）。X は Σ min(w_i, X) = A の解で、
 * 幅を小さい順に並べた先頭 j 本の和を S_j とすると max_j (A − S_j) / (n − j) になる。A は描いて
 * みるまで決まらないので、式のまま CSS に渡して `100%` を行の幅で解かせる（theme.ts の
 * `.cm-lp-table-row`）。build() の中で editor の幅を読まずに済み、幅が変わっても組み直さない。
 *
 * 各列を w_i に比例して縮める方が式は短いが、長いセルが 1 つあると短い列まで数 px に潰れて、
 * 見出しの語が 1 字ずつ折り返す。
 */
function fitExpression(widths: readonly number[]): string {
  const sorted = [...widths].sort((a, b) => a - b);
  const terms: string[] = [];
  let sum = 0;
  sorted.forEach((width, j) => {
    terms.push(`(var(--cm-lp-table-available) - ${sum}px) / ${sorted.length - j}`);
    sum += width;
  });
  return `max(${terms.join(", ")})`;
}

type Align = "left" | "center" | "right" | null;

/**
 * 区切り行（lezer の、表の直下の `TableDelimiter`。行の中の `|` と違って子を持たない）から列ごとの
 * 揃えを読む。区切り行のセルはどれも `-` を含むので、`|` で割った断片のうち `-` を含むものだけを
 * 列とみなせば、両端の `|` の有無や引用の `>` を数えずに済む。
 */
function columnAligns(state: EditorState, table: SyntaxNode): Align[] {
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name !== TABLE_DELIMITER) continue;
    return state.doc
      .sliceString(child.from, child.to)
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.includes("-"))
      .map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        return left ? "left" : null;
      });
  }
  return [];
}

const cellMarks = new Map<string, Decoration>();

/**
 * 外枠の左端は 1 列目のセルが描く（theme.ts の `.cm-lp-table-cell-first`）。行頭の `|` を省いた表
 * （`a | b`）にも左端の線を引くため、pipe の有無ではなく列の番号で決める。
 */
function cellClass(header: boolean, first: boolean, align: Align = null): string {
  const classes = ["cm-lp-table-cell"];
  if (header) classes.push("cm-lp-table-header");
  if (first) classes.push("cm-lp-table-cell-first");
  if (align) classes.push(`cm-lp-table-align-${align}`);
  return classes.join(" ");
}

function cellMark(widthPx: number, header: boolean, first: boolean, align: Align): Decoration {
  const key = `${header ? "h" : "b"}:${first ? "f" : ""}:${align ?? ""}:${widthPx}`;
  let mark = cellMarks.get(key);
  if (!mark) {
    mark = Decoration.mark({
      class: cellClass(header, first, align),
      attributes: { style: `--cm-lp-table-width: ${widthPx}px` },
    });
    cellMarks.set(key, mark);
  }
  return mark;
}

/**
 * 空白も無い空のセル（`||`）の箱。幅 0 の範囲には mark が付かず、その列の箱が無いと後ろの列が
 * 左へずれる。replace ではなく挿入する widget なので、DOM から文字を消さない（IME 不変条件 2）。
 */
class EmptyCellWidget extends WidgetType {
  constructor(
    private readonly widthPx: number,
    private readonly header: boolean,
    private readonly first: boolean,
  ) {
    super();
  }

  override eq(other: EmptyCellWidget): boolean {
    return (
      other.widthPx === this.widthPx && other.header === this.header && other.first === this.first
    );
  }

  override toDOM(): HTMLElement {
    const cell = document.createElement("span");
    // 中身が空の inline-block は line box を持たず高さが 0 になり、罫線が描かれない。
    // 高さは theme.ts の `.cm-lp-table-cell-empty::before` が文字の無い DOM のまま行の高さにそろえる
    cell.className = `${cellClass(this.header, this.first)} cm-lp-table-cell-empty`;
    cell.style.setProperty("--cm-lp-table-width", `${this.widthPx}px`);
    return cell;
  }

  // 既定の true だとクリックを editor が無視し、空のセルをクリックしても表が source に戻らない
  override ignoreEvent(): boolean {
    return false;
  }
}

interface Segment {
  readonly from: number;
  readonly to: number;
}

/**
 * セルの中身の前後の空白を描かない mark（GFM の描画と同じ）。右寄せの空白などを描くと、その後ろが
 * 折り返せる位置になって空白だけの表示行ができ、列の上限より長い空白はセルを押し広げる。揃えは
 * 区切り行の `:` から text-align で付ける。focus のある view では rendered の表にカーソルが入らない
 * ので、隠した空白の上に caret は来ない（focus の無い view から戻った直後、表を組み直すまでの短い間を
 * 除く）。
 */
const spaceMark = Decoration.mark({ class: "cm-lp-table-space" });

interface CellText {
  /** 前後の空白を除いた中身の範囲。中身が空白だけのセルは空白ごと描くので null */
  readonly content: Segment | null;
  readonly widthPx: number;
}

/**
 * GFM がセルの前後から除くのは ASCII の空白とタブだけ。`trim()` のように全角空白（U+3000）や NBSP まで
 * 除くと、それで書いたインデントが消える。
 */
const LEADING_SPACE = /^[ \t]+/;
const TRAILING_SPACE = /[ \t]+$/;

function cellText(ctx: CanvasRenderingContext2D, text: string, from: number): CellText {
  const lead = LEADING_SPACE.exec(text)?.[0].length ?? 0;
  const trimmed = text.slice(lead).replace(TRAILING_SPACE, "");
  if (trimmed === "") return { content: null, widthPx: measureWidth(ctx, text) };
  const start = from + lead;
  return {
    content: { from: start, to: start + trimmed.length },
    widthPx: measureWidth(ctx, trimmed),
  };
}

/**
 * 行を列ごとの範囲に分ける。`TableCell` node ではなく `|` の間を 1 列とするのは、
 * parser が空のセルに `TableCell` を作らず、node だけでは列の番号がずれるため。
 * 範囲はセルの前後の空白を含む。
 */
function columnSegments(state: EditorState, row: SyntaxNode): Segment[] {
  const segments: Segment[] = [];
  let start = row.from;
  let sawPipe = false;
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name !== TABLE_DELIMITER) continue;
    // 行頭の `|` の手前には列が無い
    if (sawPipe || child.from > row.from) segments.push({ from: start, to: child.from });
    sawPipe = true;
    start = child.to;
  }
  // 末尾の `|` の後ろは、空白以外があるときだけ列になる（parser の列数の数え方と同じ）
  if (!sawPipe || state.doc.sliceString(start, row.to).trim() !== "") {
    segments.push({ from: start, to: row.to });
  }
  return segments;
}

/** 引用の `>` と、その後の空白 1 桁（blockquote.ts が隠す範囲。quoteMarkEnd と同じ数え方） */
const QUOTE_MARKS = /^(?:[ \t]*>[ \t]?)*/;

/**
 * 行頭から表の行の始まりまでのうち、引用の記法を除いて画面に残る部分（リストの中のインデントなど）。
 * 行は flex で描くので、空白だけの文字は mark で包まないと flex の規則で描かれずに消える。
 */
function visibleIndent(state: EditorState, rowFrom: number): string {
  const prefix = state.doc.sliceString(state.doc.lineAt(rowFrom).from, rowFrom);
  return prefix.slice(QUOTE_MARKS.exec(prefix)?.[0].length ?? 0);
}

const indentMark = Decoration.mark({ class: "cm-lp-table-indent" });

interface MeasuredRow {
  readonly node: SyntaxNode;
  readonly header: boolean;
  readonly segments: readonly Segment[];
  readonly contents: readonly (Segment | null)[];
}

/**
 * 行頭のインデント（リストの中の表）を mark で包み、最も広いインデントの幅を返す。インデントはセルの外に
 * 描かれるので、列に配れる幅から引く（theme.ts の `--cm-lp-table-available`）。
 */
function decorateIndents(
  view: EditorView,
  rows: readonly MeasuredRow[],
  out: Range<Decoration>[],
): number {
  const { state } = view;
  const indents = rows.flatMap((row) => {
    const indent = visibleIndent(state, row.node.from);
    return indent ? [{ from: row.node.from, indent }] : [];
  });
  if (indents.length === 0) return 0;
  const ctx = getMeasureContext();
  ctx.font = editorFont(view, false);
  let indentPx = 0;
  for (const { from, indent } of indents) {
    const text = indent.replaceAll("\t", " ".repeat(state.tabSize));
    indentPx = Math.max(indentPx, measureWidth(ctx, text));
    out.push(indentMark.range(from - indent.length, from));
  }
  return indentPx;
}

function decorateTable(view: EditorView, table: SyntaxNode, out: Range<Decoration>[]): void {
  const { state } = view;
  const visible = (from: number, to: number) =>
    view.visibleRanges.some((range) => range.from <= to && range.to >= from);
  const ctx = getMeasureContext();

  // 列幅は viewport に入っている行だけから決める。表全体を見ると、長い表で
  // visibleRanges の外を走査することになる（decoration-plugin.ts の DecorationBuilder）。
  const rows: MeasuredRow[] = [];
  const widths: number[] = [];
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (!visible(child.from, child.to)) continue;
    if (child.name === TABLE_DELIMITER) {
      out.push(delimiterRow.range(state.doc.lineAt(child.from).from));
      continue;
    }
    if (child.name !== TABLE_HEADER && child.name !== TABLE_ROW) continue;
    const header = child.name === TABLE_HEADER;
    ctx.font = editorFont(view, header);
    const segments = columnSegments(state, child);
    const contents = segments.map((segment, column) => {
      const cell = cellText(ctx, state.doc.sliceString(segment.from, segment.to), segment.from);
      widths[column] = Math.max(widths[column] ?? 0, cell.widthPx);
      return cell.content;
    });
    rows.push({ node: child, header, segments, contents });
  }

  const aligns = columnAligns(state, table);
  const indentPx = decorateIndents(view, rows, out);
  const rowLine = Decoration.line({
    class: "cm-lp-table-row",
    attributes: {
      style: `--cm-lp-table-columns: ${widths.length}; --cm-lp-table-indent: ${indentPx}px; --cm-lp-table-fit: ${fitExpression(widths)}`,
    },
  });
  for (const row of rows) {
    out.push(rowLine.range(state.doc.lineAt(row.node.from).from));
    row.segments.forEach((segment, column) => {
      const width = widths[column] ?? 0;
      const first = column === 0;
      const content = row.contents[column];
      if (segment.from < segment.to) {
        const mark = cellMark(width, row.header, first, aligns[column] ?? null);
        out.push(mark.range(segment.from, segment.to));
        if (content && segment.from < content.from) {
          out.push(spaceMark.range(segment.from, content.from));
        }
        if (content && content.to < segment.to) out.push(spaceMark.range(content.to, segment.to));
      } else {
        const widget = new EmptyCellWidget(width, row.header, first);
        out.push(Decoration.widget({ widget }).range(segment.from));
      }
    });
    for (let child = row.node.firstChild; child; child = child.nextSibling) {
      if (child.name === TABLE_DELIMITER) out.push(pipeMark.range(child.from, child.to));
    }
  }
}

/**
 * 表は `Decoration.replace` を使わずに描く。`|` と区切り行は CSS で見えなくするだけで DOM に残し、
 * 空のセルの箱は文字を消さない挿入の widget にする。隠した範囲を atomicRanges に入れる必要も、
 * IME の composition 位置を DOM から失わせる余地も無い（IME 不変条件 2）。
 */
function build(view: EditorView): BuiltDecorations {
  const reveal = createRevealTest(view);
  const decorations: Range<Decoration>[] = [];
  const seen = new Set<number>();

  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== TABLE) return true;
        if (seen.has(node.from)) return false;
        seen.add(node.from);
        // 表のどこかにカーソルがあれば表全体を source に戻す。行単位で戻すと、
        // 戻した行だけ列幅の揃えが外れて編集中の行の位置が左右に動く。
        // 範囲を表の行の頭と末尾まで広げるのは、rendered の行（flex。theme.ts）にカーソルを置かせない
        // ため。インデントの手前や行末の空白の後ろで変換すると、未確定の文字が flex の行の中に入る。
        const { doc } = view.state;
        const from = doc.lineAt(node.from).from;
        const to = doc.lineAt(node.to).to;
        if (!reveal(from, to)) decorateTable(view, node.node, decorations);
        return false;
      },
    });
  }

  return { decorations: Decoration.set(decorations, true) };
}

/** GFM table の Live Preview。列の区切りを揃え、区切り行を畳む。 */
export function tables(): Extension {
  return decorationPlugin({ name: "table", build });
}
