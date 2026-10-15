import { syntaxTree } from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import { Decoration, type EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { commentNodes, highlightNodes, taskListNodes } from "@personal-wiki/markdown";
import { BlockquoteDecorations, quoteMarkEnd } from "./blockquote";
import { calloutFolds } from "./callout";
import { CODE_BLOCK_NODES, concealFences, decorateCodeLines } from "./code-block";
import { CommentDecorations } from "./comment";
import { type BuiltDecorations, decorationPlugin } from "./decoration-plugin";
import { externalHref, MD_LINK_URL_ATTR } from "./external-link";
import { linkSyntaxParts } from "./link-syntax";
import { ListIndents, type ListPrefix, listIndentsStale } from "./list-indent";
import { type TaskSyntax, taskSyntax } from "./list-syntax";
import { noBreakDecorations } from "./no-break";
import { createRevealTest, isSimplifiedView } from "./reveal";

const hide = Decoration.replace({});
const strong = Decoration.mark({ class: "cm-lp-strong" });
const emphasis = Decoration.mark({ class: "cm-lp-em" });
const strikethrough = Decoration.mark({ class: "cm-lp-strike" });
const highlight = Decoration.mark({ class: "cm-lp-highlight" });
const inlineCode = Decoration.mark({ class: "cm-lp-inline-code" });

const headingLines = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `cm-lp-heading cm-lp-h${level}` }),
);
/** 本文の 1 行目の見出し。上の余白は前の節との区切りなので、区切る相手の無い先頭では付けない */
const leadingHeadingLines = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `cm-lp-heading cm-lp-h${level} cm-lp-heading-leading` }),
);

/** 複数行にわたる setext 見出しの 2 行目以降。上の余白は見出しの先頭の行だけが持つ */
const continuedHeadingLines = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `cm-lp-heading cm-lp-h${level} cm-lp-heading-continued` }),
);

/** 箇条書きの `-`/`*`/`+` を置き換える記号。番号付きリストの `1.` 等は対象外。 */
class ListBulletWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const bullet = document.createElement("span");
    bullet.className = "cm-lp-list-bullet";
    bullet.textContent = "•";
    return bullet;
  }

  // 既定の true だとクリックを editor が無視し、カーソルを記号の位置に置いて source を出せない
  // （HorizontalRuleWidget と同じ理由）。
  override ignoreEvent(): boolean {
    return false;
  }
}

const listBullet = Decoration.replace({ widget: new ListBulletWidget() });

const ATX_HEADING = /^ATXHeading([1-6])$/;
const SETEXT_HEADING = /^SetextHeading([12])$/;

class HorizontalRuleWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const rule = document.createElement("span");
    rule.className = "cm-lp-hr";
    rule.setAttribute("role", "separator");
    return rule;
  }

  // 既定の true だと罫線のクリックを editor が無視し、カーソルを行に置いて source を出せない。
  override ignoreEvent(): boolean {
    return false;
  }
}

const horizontalRule = Decoration.replace({ widget: new HorizontalRuleWidget() });

function build(view: EditorView): BuiltDecorations {
  const reveal = createRevealTest(view);
  const { state } = view;
  const caret = view.hasFocus ? state.selection.ranges : [];
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  // 同じ node が隣り合う visibleRange の両方に跨ると enter が 2 回走る。
  const seen = new Set<string>();
  // table.ts の decorateTable と同じ理由: node（コードブロック）の一部だけが今回の
  // visibleRanges の要素に含まれていても、node 全体は複数の visibleRanges にまたがりうる。
  // outer の for が渡す 1 要素分の from/to でなく view.visibleRanges 全体を見て判定する。
  const visible = (from: number, to: number) =>
    view.visibleRanges.some((range) => range.from <= to && range.to >= from);

  const conceal = (from: number, to: number, decoration: Decoration = hide): void => {
    if (from >= to) return;
    // callout の見出しは `>` から `[!type]` までを 1 つの replace にする（blockquote.ts）。
    // `[!**x**]` のように識別子の中にある記法の隠しを重ねると、どちらが描かれるかが
    // CodeMirror の重なりの扱い次第になる。Obsidian の識別子は `]` 以外を何でも含めるので、
    // 識別子の文字を絞るのでなく、見出しの範囲では他の隠しを張らない。
    if (decoration === hide && quotes.overlapsHeader(from, to)) return;
    const key = `${from}:${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    decorations.push(decoration.range(from, to));
    atomic.push(decoration.range(from, to));
  };
  const quotes = new BlockquoteDecorations(state, reveal, conceal);
  const comments = new CommentDecorations(state, isSimplifiedView(view), conceal);
  const listIndents = new ListIndents(view);
  const tree = syntaxTree(state);

  /**
   * リスト項目の行に、折り返した 2 行目以降を本文の始まりにそろえる line decoration を付ける。
   * 幅は今描いている見た目（記号を「•」にしたか、checkbox にしたか、引用の `>` を隠したか）で測る。
   */
  const hangingIndent = (
    mark: SyntaxNode,
    content: SyntaxNode | null,
    task: TaskSyntax | null,
    checkbox: boolean,
  ): void => {
    const { doc } = state;
    const line = doc.lineAt(mark.from);
    // 見出しやコードブロックの項目は本文と大きさや書体が違い、本文の font で測った幅が合わない。
    // 本文が次の行から始まる項目は、記号の行に折り返す本文が無い。
    if (content?.name !== "Paragraph" && !task) return;
    if (!content || content.from > line.to) return;
    const key = `li:${line.from}`;
    if (seen.has(key)) return;
    seen.add(key);

    // 引用の中では、blockquote.ts が隠す `>` と後ろの空白 1 つを幅に数えない。source を出している
    // 行では `>` も本文の書体で見えているので、そのまま幅に数える。
    const revealed = reveal(line.from, line.to);
    let leadFrom = line.from;
    const quoteMarks: number[] = [];
    tree.iterate({
      from: line.from,
      to: mark.from,
      enter: (child) => {
        if (child.name !== "QuoteMark" || child.to > mark.from) return;
        if (revealed) quoteMarks.push(child.from);
        else leadFrom = Math.max(leadFrom, quoteMarkEnd(doc, child.to));
      },
    });
    const lead = doc.sliceString(leadFrom, mark.from);
    // `- - a` のように前に別の記号が並ぶ行は、前の記号の見た目まで追わない
    for (let index = 0; index < lead.length; index += 1) {
      const char = lead[index];
      if (char !== " " && char !== "\t" && !quoteMarks.includes(leadFrom + index)) return;
    }

    let prefix: ListPrefix;
    if (task) {
      const bodyFrom = skipSpaces(doc.sliceString(task.marker.to, line.to), task.marker.to);
      const shownTo = checkbox ? task.marker.from : task.marker.to;
      const shownFrom = checkbox && task.hiddenMark ? shownTo : mark.from;
      prefix = {
        before: lead + doc.sliceString(shownFrom, shownTo),
        checkbox,
        after: doc.sliceString(task.marker.to, bodyFrom),
      };
    } else {
      const bullet = mark.parent?.parent?.name === "BulletList" && !reveal(mark.from, mark.to);
      const symbol = bullet ? "•" : doc.sliceString(mark.from, mark.to);
      prefix = {
        before: lead + symbol + doc.sliceString(mark.to, content.from),
        checkbox: false,
        after: "",
      };
    }
    const decoration = listIndents.lineDecoration(prefix);
    if (decoration) decorations.push(decoration.range(line.from));
  };

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (CODE_BLOCK_NODES.has(node.name)) {
          const key = `code:${node.from}`;
          if (seen.has(key)) return false;
          seen.add(key);
          decorateCodeLines(state, node.node, visible, decorations);
          if (node.name === "FencedCode" && !reveal(node.from, node.to)) {
            concealFences(state, node.node, conceal, decorations);
          }
          // 引用の中では、コードの 2 行目以降の `>` がコードブロックの子になる。コードの中へは降りない
          // ので、`>` だけを引用の側へ渡す。渡さないと閉じフェンスの行に `>` だけが残る
          for (const mark of node.node.getChildren("QuoteMark")) {
            if (visible(mark.from, mark.to)) quotes.quoteMark(mark);
          }
          return false;
        }
        const heading = ATX_HEADING.exec(node.name);
        if (heading?.[1]) {
          const level = Number(heading[1]);
          const lineFrom = state.doc.lineAt(node.from).from;
          const line = (lineFrom === 0 ? leadingHeadingLines : headingLines)[level - 1];
          if (line && !seen.has(`h:${lineFrom}`)) {
            seen.add(`h:${lineFrom}`);
            decorations.push(line.range(lineFrom));
          }
          return true;
        }
        const setext = SETEXT_HEADING.exec(node.name);
        if (setext?.[1]) {
          // 見出しの文は複数行にわたりうる。下線の行は見出しの大きさにせず、記号も隠さない
          // （Obsidian の Live Preview も下線を source のまま残す）。
          const level = Number(setext[1]);
          const underline = node.node.lastChild;
          if (underline?.name !== "HeaderMark") return true;
          const first = state.doc.lineAt(node.from);
          const last = state.doc.lineAt(underline.from);
          for (let number = first.number; number < last.number; number += 1) {
            const line = state.doc.line(number);
            const lines =
              number > first.number
                ? continuedHeadingLines
                : line.from === 0
                  ? leadingHeadingLines
                  : headingLines;
            const decoration = lines[level - 1];
            if (decoration && !seen.has(`h:${line.from}`)) {
              seen.add(`h:${line.from}`);
              decorations.push(decoration.range(line.from));
            }
          }
          return true;
        }
        if (node.name === "HeaderMark") {
          const parent = node.node.parent;
          if (!parent || !ATX_HEADING.test(parent.name)) return false;
          if (reveal(parent.from, parent.to)) return false;
          // `#` に続く空白まで隠す。見出し本文しか残っていない行を作らないよう、
          // 本文が空の見出しは記法を残す。
          const contentStart = skipSpaces(state.doc.sliceString(node.to, parent.to), node.to);
          if (contentStart < parent.to) conceal(node.from, contentStart);
          return false;
        }
        if (node.name === "StrongEmphasis" || node.name === "Emphasis") {
          const mark = node.name === "StrongEmphasis" ? strong : emphasis;
          const key = `m:${node.from}:${node.to}`;
          if (!seen.has(key)) {
            seen.add(key);
            decorations.push(mark.range(node.from, node.to));
          }
          return true;
        }
        if (node.name === "EmphasisMark") {
          const parent = node.node.parent;
          if (!parent) return false;
          if (!reveal(parent.from, parent.to)) conceal(node.from, node.to);
          return false;
        }
        // GFM の Strikethrough は markdownLanguage に最初から入っている。
        if (node.name === "Strikethrough") {
          const key = `s:${node.from}:${node.to}`;
          if (!seen.has(key)) {
            seen.add(key);
            decorations.push(strikethrough.range(node.from, node.to));
          }
          return true;
        }
        if (node.name === "StrikethroughMark") {
          const parent = node.node.parent;
          if (!parent) return false;
          if (!reveal(parent.from, parent.to)) conceal(node.from, node.to);
          return false;
        }
        if (node.name === "InlineCode") {
          const key = `ic:${node.from}:${node.to}`;
          if (!seen.has(key)) {
            seen.add(key);
            decorations.push(inlineCode.range(node.from, node.to));
            const open = node.node.firstChild;
            const close = node.node.lastChild;
            if (open && close && close.name === "CodeMark" && close.from > open.to) {
              decorations.push(
                ...noBreakDecorations(
                  state.doc,
                  node.node,
                  { from: open.to, to: close.from },
                  caret,
                ),
              );
            }
          }
          return true;
        }
        if (node.name === "CodeMark") {
          // fenced code の CodeMark は上の CODE_BLOCK_NODES で降りないので、ここに来るのは
          // インラインコードの `` ` `` だけだが、親を見て取り違えを避ける。
          const parent = node.node.parent;
          if (parent?.name !== "InlineCode") return false;
          if (!reveal(parent.from, parent.to)) conceal(node.from, node.to);
          return false;
        }
        if (node.name === "HorizontalRule") {
          // node は直前の字下げを含まない。字下げを残すと横幅いっぱいの罫線が次の表示行へ
          // 折り返すので、隠す範囲に含める。`>` などの前置きは他の記法の持ち物なので残す。
          const line = state.doc.lineAt(node.from);
          const prefix = state.doc.sliceString(line.from, node.from);
          const indent = /[ \t]*$/.exec(prefix)?.[0].length ?? 0;
          // `>` の直後の 1 桁は引用の記法に属し、blockquote.ts が隠す。replace 同士を重ねると
          // どちらが描かれるかが CodeMirror の重なりの扱い次第になるので、その 1 桁は含めない。
          const ownedByQuote = indent > 0 && prefix[prefix.length - indent - 1] === ">";
          const from = node.from - indent + (ownedByQuote ? 1 : 0);
          const key = `hr:${from}`;
          if (!reveal(line.from, line.to) && !seen.has(key)) {
            seen.add(key);
            decorations.push(horizontalRule.range(from, node.to));
            atomic.push(horizontalRule.range(from, node.to));
          }
          return false;
        }
        if (node.name === "ListMark") {
          const item = node.node.parent;
          if (item?.name !== "ListItem") return false;
          const content = node.node.nextSibling;
          const task = content?.name === taskListNodes.task ? taskSyntax(state, content) : null;
          // checkbox は task-list.ts が描く。ここと同じ範囲で判定しないと記号とブラケットの片方だけが戻る
          const checkbox = task !== null && !reveal(task.revealFrom, task.marker.to);
          if (task?.hiddenMark) {
            // checkbox が行頭の記号を兼ねるので、「•」と checkbox を並べない
            if (checkbox) conceal(task.hiddenMark.from, task.hiddenMark.to);
          } else if (item.parent?.name === "BulletList" && !reveal(node.from, node.to)) {
            // OrderedList の `1.` などは対象外（番号は本文の意味を運ぶ）
            conceal(node.from, node.to, listBullet);
          }
          hangingIndent(node.node, content, task, checkbox);
          return false;
        }
        if (node.name === "Blockquote") {
          quotes.enterBlockquote(node, from, to);
          return true;
        }
        if (node.name === "QuoteMark") {
          quotes.quoteMark(node);
          return false;
        }
        if (node.name === highlightNodes.highlight) {
          const key = `hl:${node.from}:${node.to}`;
          if (!seen.has(key)) {
            seen.add(key);
            decorations.push(highlight.range(node.from, node.to));
          }
          return true;
        }
        if (node.name === highlightNodes.mark) {
          const parent = node.node.parent;
          if (!parent) return false;
          if (!reveal(parent.from, parent.to)) conceal(node.from, node.to);
          return false;
        }
        if (node.name === "Link") {
          const key = `lk:${node.from}`;
          if (!seen.has(key)) {
            seen.add(key);
            const parts = linkSyntaxParts(node, state.doc);
            if (parts) {
              const { open, closeBracket, closeParen, url } = parts;
              // text が空の `[](url)` は node 全体が幅 0 の replace になり、simplified view では
              // 常に何も表示されず復帰手段が無くなる。mark を張らない条件と揃え、conceal もしない。
              if (open.to < closeBracket.from) {
                // 許可 scheme 以外は href を付けない。`javascript:` などを DOM に置かないことが
                // URL を隠す表示での一次防御になる（素のクリックは external-link.ts が同じ
                // allowlist で弾く）。
                const href = externalHref(url);
                decorations.push(
                  Decoration.mark({
                    class: "cm-md-link",
                    ...(href === null ? {} : { tagName: "a" }),
                    attributes: {
                      // URL を隠すと読み手はクリック前に遷移先を確認できない。title で hover
                      // すれば読める形にしておく。
                      [MD_LINK_URL_ATTR]: url,
                      title: url,
                      ...(href === null
                        ? {}
                        : {
                            href,
                            target: "_blank",
                            rel: "noopener noreferrer",
                            // contenteditable の中では `<a>` が既定でドラッグ可能になる
                            draggable: "false",
                          }),
                    },
                  }).range(open.to, closeBracket.from),
                );
                if (!reveal(node.from, node.to)) {
                  conceal(node.from, open.to);
                  conceal(closeBracket.from, closeParen.to);
                }
              }
            }
          }
          // text 部分の中の強調などは他の分岐が引き続き処理する。
          return true;
        }
        // 中の QuoteMark を blockquote.ts に渡すため、子へ降りる。
        if (node.name === commentNodes.inline || node.name === commentNodes.block) {
          comments.enterComment(node, from, to);
          return true;
        }
        return true;
      },
    });
  }
  decorations.push(...quotes.decorations());
  decorations.push(...comments.decorations());
  atomic.push(...comments.atomic());

  return { decorations: Decoration.set(decorations, true), atomic: Decoration.set(atomic, true) };
}

function skipSpaces(text: string, offset: number): number {
  let i = 0;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  return offset + i;
}

/**
 * 見出し、強調、取り消し線、インラインコード、引用、callout、箇条書きの記号、markdown link、コードブロックの
 * Live Preview。WikiLink と tag は別の extension が持つ。
 *
 * task の行では行頭の `- ` を隠し、checkbox の描画は `taskList()` に任せる。`taskList()` を
 * 入れずにこれだけを使うと、記号が消えて `[ ]` の source だけが残る。
 */
export function livePreview(): Extension {
  return [
    decorationPlugin({
      name: "live-preview",
      build,
      rebuildWhen: (update) =>
        update.startState.field(calloutFolds, false) !== update.state.field(calloutFolds, false) ||
        listIndentsStale(update),
    }),
    calloutFolds,
  ];
}
