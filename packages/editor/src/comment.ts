import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import { quoteMarkEnd } from "./blockquote";

const shown = Decoration.mark({ class: "cm-lp-comment" });
const collapsedLine = Decoration.line({ class: "cm-lp-comment-hidden" });
const skipped = Decoration.replace({});

/**
 * コメント（`%%text%%`）の Live Preview。live-preview の 1 回の構築の中で、構文木の走査から
 * コメントの node を受け取る。
 *
 * focus のある view では、カーソルの位置に関わらず記法ごと専用のスタイルで見せる。
 * Obsidian も編集中はコメントを見せ、それ以外の表示では見せない。カーソルで切り替えないので、
 * focus のある view にはコメントの `Decoration.replace` を張らない（IME 不変条件 2 に触れない）。
 * readonly の view も含め、focus の無い view では中身ごと隠す。
 *
 * 行をまたぐ `Decoration.replace` は ViewPlugin からは張れないので、行ごとに隠し、行全体が
 * コメントの行は line decoration で畳む。引用の `>` は blockquote.ts が隠すので、ここでは隠さない
 * （replace 同士を重ねない）。
 */
export class CommentDecorations {
  private readonly ranges = new Map<string, Range<Decoration>>();
  private readonly atomicRanges = new Map<string, Range<Decoration>>();

  constructor(
    private readonly state: EditorState,
    private readonly hidden: boolean,
    private readonly conceal: (from: number, to: number) => void,
  ) {}

  /** `from`..`to` は走査中の visibleRange。範囲外の行には decoration を作らない */
  enterComment(node: SyntaxNodeRef, from: number, to: number): void {
    if (!this.hidden) {
      this.ranges.set(`c:${node.from}:${node.to}`, shown.range(node.from, node.to));
      return;
    }
    // 行ごとに隠した範囲の間の改行と畳んだ行も、カーソルが 1 回で飛び越えるようにする。
    this.atomicRanges.set(`${node.from}:${node.to}`, skipped.range(node.from, node.to));

    const { doc } = this.state;
    const start = Math.max(node.from, from);
    const end = Math.min(node.to, to);
    const quoteEnds = new Map<number, number>();
    syntaxTree(this.state).iterate({
      from: start,
      to: end,
      enter: (child) => {
        if (child.name !== "QuoteMark") return true;
        const lineFrom = doc.lineAt(child.from).from;
        quoteEnds.set(
          lineFrom,
          Math.max(quoteEnds.get(lineFrom) ?? 0, quoteMarkEnd(doc, child.to)),
        );
        return false;
      },
    });

    const last = doc.lineAt(end).number;
    for (let n = doc.lineAt(start).number; n <= last; n += 1) {
      const line = doc.line(n);
      this.conceal(
        Math.max(node.from, quoteEnds.get(line.from) ?? line.from),
        Math.min(node.to, line.to),
      );
      if (line.from >= node.from && line.to <= node.to) {
        this.ranges.set(`l:${line.from}`, collapsedLine.range(line.from));
      }
    }
  }

  decorations(): Range<Decoration>[] {
    return [...this.ranges.values()];
  }

  atomic(): Range<Decoration>[] {
    return [...this.atomicRanges.values()];
  }
}
