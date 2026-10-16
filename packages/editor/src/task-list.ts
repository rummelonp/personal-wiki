import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import {
  extractPlainText,
  parseTaskMarker,
  taskListNodes,
  toggledTaskStatus,
} from "@personal-wiki/markdown";
import { type BuiltDecorations, decorationPlugin } from "./decoration-plugin";
import { isCompositionUnsettled } from "./ime";
import { TASK_CHECKBOX_EM, taskSyntax } from "./list-syntax";
import { createRevealTest } from "./reveal";

const checkedText = Decoration.mark({ class: "cm-lp-task-checked" });

/** `pos` から始まる TaskMarker の範囲。無いか、task marker として読めなければ null */
function taskMarkerAt(state: EditorState, pos: number): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    from: pos,
    to: pos,
    enter(node) {
      if (found) return false;
      if (node.name === taskListNodes.marker && node.from === pos) {
        found = { from: node.from, to: node.to };
        return false;
      }
      return true;
    },
  });
  return found;
}

/**
 * checkbox の切り替えを doc に書く。書く文字の決め方は `toggledTaskStatus`。
 *
 * ブラケット内の 1 文字だけを置き換え、行のほかの部分には触れない。
 */
function toggleTask(view: EditorView, dom: HTMLElement): void {
  // 確定文字列を読み込む前に dispatch すると確定文字列が消える（IME 不変条件 1）
  if (isCompositionUnsettled(view)) return;
  const { state } = view;
  if (state.readOnly) return;
  // widget を描いた後に doc が変わっていることがあるので、位置と中身を state から取り直す
  const range = taskMarkerAt(state, view.posAtDOM(dom));
  if (!range) return;
  const marker = parseTaskMarker(state.sliceDoc(range.from, range.to));
  if (!marker) return;
  view.dispatch({
    changes: { from: range.from + 1, to: range.to - 1, insert: toggledTaskStatus(marker) },
    userEvent: "input.toggle",
    // 直前の入力と同じ undo 単位にまとめると、undo で打った文字まで一緒に消える
    annotations: isolateHistory.of("full"),
  });
}

/**
 * checkbox の名前にする、タスクの本文。強調やリンクなどの記法の記号は読み上げに出さない。
 * 本文が空のタスクは名前が空になるので、代わりの語を返す。
 */
function taskLabel(state: EditorState, from: number, to: number): string {
  return extractPlainText(state.sliceDoc(from, to)) || "空のタスク";
}

class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly readOnly: boolean,
    readonly label: string,
  ) {
    super();
  }

  override eq(other: TaskCheckboxWidget): boolean {
    return (
      other.checked === this.checked &&
      other.readOnly === this.readOnly &&
      other.label === this.label
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "cm-lp-task-checkbox";
    checkbox.checked = this.checked;
    checkbox.disabled = this.readOnly;
    checkbox.setAttribute("aria-label", this.label);
    // Tab で checkbox に止まると、contentDOM から focus が外れて入力位置を見失う
    checkbox.tabIndex = -1;
    // mousedown で処理する。click まで待つと editor がカーソルを task の行へ動かし、source が出る。
    checkbox.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      toggleTask(view, checkbox);
    });
    // 見た目の checked は doc から描き直す。ブラウザ自身のトグルを許すと、composition 中などで
    // doc を書かなかったときに見た目と doc が食い違う。
    checkbox.addEventListener("click", (event) => event.preventDefault());
    return checkbox;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function build(view: EditorView): BuiltDecorations {
  const reveal = createRevealTest(view);
  const { state } = view;
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  // 同じ node が隣り合う visibleRange の両方に跨ると enter が 2 回走る。
  const seen = new Set<number>();

  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== taskListNodes.task) return true;
        if (seen.has(node.from)) return false;
        seen.add(node.from);
        const task = taskSyntax(state, node.node);
        if (!task) return false;
        const { marker } = task;
        // 箇条書きの行頭の `- ` を隠すのは live-preview.ts（ListMark の持ち主）で、ここでは
        // ブラケットだけを置き換える。source に戻す判定は両方が同じ範囲（revealFrom から）で行う。
        if (!reveal(task.revealFrom, marker.to)) {
          const checkbox = Decoration.replace({
            widget: new TaskCheckboxWidget(
              task.checked,
              state.readOnly,
              taskLabel(state, marker.to, node.to),
            ),
          });
          decorations.push(checkbox.range(marker.from, marker.to));
          atomic.push(checkbox.range(marker.from, marker.to));
        }
        if (task.checked && marker.to < node.to) {
          decorations.push(checkedText.range(marker.to, node.to));
        }
        // 中の WikiLink や強調は他の extension が描く
        return false;
      },
    });
  }
  return { decorations: Decoration.set(decorations, true), atomic: Decoration.set(atomic, true) };
}

const taskListTheme = EditorView.baseTheme({
  // 寸法は live-preview.ts のぶら下げインデントが TASK_CHECKBOX_EM で見積もる。input は UA の
  // stylesheet で文字の大きさが本文より小さいので、em を本文の大きさに揃えるため継承させる。
  ".cm-lp-task-checkbox": {
    fontSize: "inherit",
    width: `${TASK_CHECKBOX_EM.width}em`,
    height: `${TASK_CHECKBOX_EM.width}em`,
    margin: `0 ${TASK_CHECKBOX_EM.gap}em 0 0`,
    verticalAlign: "-0.15em",
    cursor: "pointer",
    // 既定の青は、ホストの accent（ライトとダークで値が違う）と食い違う
    accentColor: "var(--ui-color-accent)",
  },
  ".cm-lp-task-checkbox:disabled": { cursor: "default" },
  ".cm-lp-task-checked": { color: "var(--ui-color-muted)", textDecoration: "line-through" },
});

/** `- [ ]` / `- [x]` の checkbox と、クリックでの完了の切り替え */
export function taskList(): Extension {
  return [decorationPlugin({ name: "task-list", build }), taskListTheme];
}
