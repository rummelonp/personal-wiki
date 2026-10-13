import type { EditorState, Range, Text } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import {
  type Callout,
  CalloutFoldWidget,
  CalloutTitleWidget,
  type CalloutType,
  calloutOf,
  defaultCalloutTitle,
  isCalloutCollapsed,
} from "./callout";

interface CalloutLine {
  readonly depth: number;
  readonly type: CalloutType;
  readonly title: boolean;
}

const lineDecorationCache = new Map<string, Decoration>();

/**
 * 引用の行に付ける line decoration。左のアクセントバーは入れ子の深さの本数だけ描く。
 * 深さは class でなく CSS 変数で渡す（入れ子の上限を決めずに済む）。
 * callout の行は最も内側の callout のタイプで色を付ける。
 */
function quoteLine(depth: number, callout: CalloutLine | undefined, folded: boolean): Decoration {
  const key = `${depth}:${callout?.type ?? ""}:${callout?.title ?? ""}:${folded}`;
  let decoration = lineDecorationCache.get(key);
  if (!decoration) {
    const classes = ["cm-lp-blockquote"];
    const attributes: Record<string, string> = { style: `--cm-lp-quote-depth: ${depth}` };
    if (callout) {
      classes.push("cm-lp-callout");
      if (callout.title) classes.push("cm-lp-callout-title");
      attributes["data-callout"] = callout.type;
    }
    if (folded) classes.push("cm-lp-callout-folded");
    decoration = Decoration.line({ class: classes.join(" "), attributes });
    lineDecorationCache.set(key, decoration);
  }
  return decoration;
}

/**
 * `QuoteMark`（`>`）の終わり `markTo` から、引用の記法として隠す範囲の終わりを返す。
 * CommonMark では `>` の後の空白 1 桁分が記法に含まれ、タブもその 1 桁を持つので、タブも含める。
 */
export function quoteMarkEnd(doc: Text, markTo: number): number {
  const next = doc.sliceString(markTo, markTo + 1);
  return next === " " || next === "\t" ? markTo + 1 : markTo;
}

function blockquoteDepth(node: SyntaxNodeRef): number {
  let depth = 1;
  for (let parent = node.node.parent; parent; parent = parent.parent) {
    if (parent.name === "Blockquote") depth += 1;
  }
  return depth;
}

/**
 * 引用（`>`）と callout（`> [!type]`）の Live Preview。live-preview の 1 回の構築の中で、
 * 構文木の走査から `Blockquote` と `QuoteMark` を受け取り、最後に行ごとの decoration を返す。
 *
 * 行の範囲は構文木に従う。`>` の無い lazy continuation 行も引用の中として描き、
 * 空行を挟んだ 2 つの引用は別の引用として描く（Obsidian と同じ CommonMark の解釈）。
 *
 * callout は引用の上に重ねる。見出し行の `>` は callout の記法の一部として `[!type]` と
 * まとめて置き換え、引用としての `>` の隠しと二重に replace を張らない。
 */
export class BlockquoteDecorations {
  /** 行頭の位置 → その行を覆う最も深い引用の深さ */
  private readonly depths = new Map<number, number>();
  /** 行頭の位置 → その行を覆う最も深い callout */
  private readonly callouts = new Map<number, CalloutLine>();
  /** 畳まれた callout の本文の行頭 */
  private readonly folded = new Set<number>();
  /** callout の `>` の位置 → 見出しの記法を置き換える範囲の終わりと decoration */
  private readonly headerMarks = new Map<number, { to: number; decoration: Decoration }>();
  private readonly widgets: Range<Decoration>[] = [];
  private readonly widgetPositions = new Set<number>();

  constructor(
    private readonly state: EditorState,
    private readonly reveal: (from: number, to: number) => boolean,
    private readonly conceal: (from: number, to: number, decoration?: Decoration) => void,
  ) {}

  /** `from`..`to` は走査中の visibleRange。範囲外の行には decoration を作らない */
  enterBlockquote(node: SyntaxNodeRef, from: number, to: number): void {
    const depth = blockquoteDepth(node);
    const callout = calloutOf(this.state, node);
    const collapsed = callout ? this.enterCallout(node, callout) : false;
    const { doc } = this.state;
    const end = Math.min(node.to, to);
    for (let line = doc.lineAt(Math.max(node.from, from)); ; line = doc.line(line.number + 1)) {
      if ((this.depths.get(line.from) ?? 0) < depth) this.depths.set(line.from, depth);
      if (callout) {
        if ((this.callouts.get(line.from)?.depth ?? 0) < depth) {
          const title = line.from === callout.headerLine.from;
          this.callouts.set(line.from, { depth, type: callout.header.type, title });
        }
        if (collapsed && line.from > callout.headerLine.from) this.folded.add(line.from);
      }
      if (line.to >= end || line.number === doc.lines) break;
    }
  }

  /**
   * 見出し行の置き換えと開閉ボタンを用意し、本文を畳むかを返す。
   *
   * 見出し行の source は、引用の `>` と同じく行全体で判定する。本文を畳んだままにするのは、
   * selection が本文のどの行にも触れていないときだけにする。見えない行にカーソルがあると、
   * 入力が見えない場所へ入る。
   */
  private enterCallout(node: SyntaxNodeRef, callout: Callout): boolean {
    const { header, headerLine } = callout;
    const bodyFrom = headerLine.to + 1;
    const hasBody = bodyFrom <= node.to;
    const collapsed =
      isCalloutCollapsed(this.state, callout) && !(hasBody && this.reveal(bodyFrom, node.to));
    if (this.reveal(headerLine.from, headerLine.to)) return collapsed && hasBody;
    const defaultTitle = header.hasTitle ? null : defaultCalloutTitle(header.identifier);
    this.headerMarks.set(callout.markFrom, {
      to: header.titleFrom,
      decoration: Decoration.replace({ widget: new CalloutTitleWidget(defaultTitle) }),
    });
    // 本文の無い callout は畳むものが無いので、ボタンを出さない。
    if (header.fold && hasBody && !this.widgetPositions.has(headerLine.to)) {
      this.widgetPositions.add(headerLine.to);
      const fold = Decoration.widget({ widget: new CalloutFoldWidget(collapsed), side: 1 });
      this.widgets.push(fold.range(headerLine.to));
    }
    return collapsed && hasBody;
  }

  /**
   * `>` と、それに続く空白かタブ 1 つ（`quoteMarkEnd`）を隠す。
   *
   * source を出すかどうかは記法の文字でなく行全体で判定する。引用は複数行にわたるので
   * 引用全体で判定すると、カーソルがある行と無関係な行の `>` まで現れる。一方で
   * `>` だけで判定すると、行内の本文にカーソルがあるとき記法が隠れたままになり、
   * 行頭で `>` を消したり入れ子を足したりできない。
   */
  quoteMark(node: SyntaxNodeRef): void {
    const header = this.headerMarks.get(node.from);
    if (header) {
      this.conceal(node.from, header.to, header.decoration);
      return;
    }
    const line = this.state.doc.lineAt(node.from);
    if (this.reveal(line.from, line.to)) return;
    this.conceal(node.from, quoteMarkEnd(this.state.doc, node.to));
  }

  /**
   * `from`..`to` が、ここまでに見た callout の見出しの置き換えに掛かるか。
   * 構文木の走査では `Blockquote` が中の段落より先に来るので、見出しの中の記法を
   * 受け取る時点では、その見出しの置き換えはもう登録されている。
   */
  overlapsHeader(from: number, to: number): boolean {
    for (const [markFrom, header] of this.headerMarks) {
      if (from < header.to && to > markFrom) return true;
    }
    return false;
  }

  decorations(): Range<Decoration>[] {
    const lines = [...this.depths].map(([lineFrom, depth]) =>
      quoteLine(depth, this.callouts.get(lineFrom), this.folded.has(lineFrom)).range(lineFrom),
    );
    return [...lines, ...this.widgets];
  }
}
