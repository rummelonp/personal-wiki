import { Decoration, type EditorView, type ViewUpdate } from "@codemirror/view";
import { TASK_CHECKBOX_EM } from "./list-syntax";

/** リスト項目の行で、行頭から本文の始まりまでに見えているもの */
export interface ListPrefix {
  /** checkbox より前に見えている文字（インデントと行頭の記号、番号付きなら番号と空白） */
  readonly before: string;
  readonly checkbox: boolean;
  /** checkbox の後ろ、本文の始まりまでの文字 */
  readonly after: string;
}

interface Metrics {
  readonly context: CanvasRenderingContext2D;
  readonly fontSize: number;
  readonly tabWidth: number;
}

/** table.ts と同じく、DOM に繋がない canvas で測る。build() の中で DOM のレイアウトを読まずに済む */
let measureContext: CanvasRenderingContext2D | null = null;

const lineDecorations = new Map<string, Decoration>();

/**
 * view ごとに、直近の build() で幅を見積もったときの書体（`fontSignature`）。
 * CodeMirror は view の DOM を document に繋いでから plugin を作り、theme の style はその後に
 * 当てる。そのため最初の build() はホストから継承しただけの書体で測ってしまう。
 * 書体を読めなかった build() では空文字を入れ、読めない間は組み直さない。
 */
const measuredWith = new WeakMap<EditorView, string>();

/**
 * 見積もりに使った書体が今の書体と違えば組み直させる（`rebuildWhen`）。見比べるのは CodeMirror が
 * `geometryChanged` を立てたときだけなので、行の高さも文字の大きさも変えずに字幅だけが変わる
 * 書体の差し替え（同じ metrics の web font の遅れた読み込みなど）は、次に別の理由で
 * geometry が変わるまで拾わない。
 */
export function listIndentsStale(update: ViewUpdate): boolean {
  if (!update.geometryChanged) return false;
  const measured = measuredWith.get(update.view);
  return measured !== undefined && measured !== (readFont(update.view)?.signature ?? "");
}

interface Font {
  readonly context: CanvasRenderingContext2D;
  readonly fontSize: number;
  /** 書体の指定に加え、実際の字幅も含める。指定が同じでも web font の読み込みで字幅は変わる */
  readonly signature: string;
}

function readFont(view: EditorView): Font | null {
  const style = getComputedStyle(view.contentDOM);
  const fontSize = Number.parseFloat(style.fontSize);
  if (!(fontSize > 0)) return null;
  measureContext ??= document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  measureContext.font = font;
  const probe = measureContext.measureText("•1. あa").width;
  return { context: measureContext, fontSize, signature: `${font}|${probe}` };
}

/**
 * ぶら下げインデント（折り返した 2 行目以降を本文の始まりにそろえる）の line decoration を作る。
 * 1 回の build() の中で使い捨てにする。書体を読むのは最初に使うときの 1 回だけ。
 *
 * 行頭の幅は描いた DOM を測らず、本文と同じ font で文字列の幅から見積もる。描いた後に測って
 * 直すには decoration をもう一度組む dispatch が要り、組み直しのたびに行の描画が 2 段階になる。
 * 見積もりはリスト項目の行が本文の font で描かれる前提に立つので、呼び出し側は見出しや
 * コードブロックの行に使わない。
 */
export class ListIndents {
  private metrics: Metrics | null | undefined;

  constructor(private readonly view: EditorView) {}

  /** 書体を読めない（文字の大きさが決まっていない）ときは null */
  lineDecoration(prefix: ListPrefix): Decoration | null {
    const metrics = this.getMetrics();
    if (!metrics) return null;
    let width = this.advance(metrics, 0, prefix.before);
    if (prefix.checkbox) {
      width += (TASK_CHECKBOX_EM.width + TASK_CHECKBOX_EM.gap) * metrics.fontSize;
    }
    width = this.advance(metrics, width, prefix.after);
    // 行ごとに decoration を作らず値ごとに使い回すため、表示に効かない桁で丸める
    const indent = `${Math.round(width * 100) / 100}px`;
    let decoration = lineDecorations.get(indent);
    if (!decoration) {
      decoration = Decoration.line({
        class: "cm-lp-list",
        attributes: { style: `--cm-lp-list-indent: ${indent}` },
      });
      lineDecorations.set(indent, decoration);
    }
    return decoration;
  }

  /** `x` から `text` を描き終えた位置。タブは次のタブ位置まで進める（CSS の tab-size と同じ規則） */
  private advance({ context, tabWidth }: Metrics, x: number, text: string): number {
    let position = x;
    for (const [index, segment] of text.split("\t").entries()) {
      if (index > 0) position = (Math.floor(position / tabWidth) + 1) * tabWidth;
      if (segment) position += context.measureText(segment).width;
    }
    return position;
  }

  private getMetrics(): Metrics | null {
    if (this.metrics !== undefined) return this.metrics;
    const font = readFont(this.view);
    measuredWith.set(this.view, font?.signature ?? "");
    this.metrics = font && {
      context: font.context,
      fontSize: font.fontSize,
      tabWidth: this.view.state.tabSize * font.context.measureText(" ").width,
    };
    return this.metrics;
  }
}
