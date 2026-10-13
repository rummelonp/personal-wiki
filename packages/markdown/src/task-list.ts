import { tags } from "@lezer/highlight";
import type { BlockContext, LeafBlock, LeafBlockParser, MarkdownConfig } from "@lezer/markdown";

/**
 * task list の構文木ノード名。decoration 側が文字列リテラルを直書きしないよう、ここを唯一の定義とする。
 * GFM の TaskList と同じ名前にしてある。Editor の base（lang-markdown の GFM 入り）がすでに
 * 定義している node をそのまま使い、list-keymap のように GFM の名前で node を見る処理とも揃う。
 */
export const taskListNodes = {
  /** リスト項目の最初の段落。`[ ]` から段落の終わりまで */
  task: "Task",
  /** `[ ]`、`[x]` のようなブラケットとその中の 1 文字 */
  marker: "TaskMarker",
} as const;

// ブラケット内は 1 文字（code point 単位なので絵文字も 1 文字）。`]` と改行は入らない。
// `]` の後ろに空白かタブを要るのは GFM と同じ。
// バッククォートも入れない。task list を解析しない抽出では `[`] #tag `x`` の `` ` `` が code span を
// 開いて中の tag を拾わないのに、Editor だけ task にすると `#tag` を tag として描き、両者がずれる。
const TASK_MARKER = /^\[([^\]\r\n`])\][ \t]/u;

const UNCHECKED = " ";
const CHECKED = "x";

export interface TaskMarker {
  /** ブラケット内の文字 */
  readonly status: string;
  readonly checked: boolean;
}

/**
 * TaskMarker の文字列（`[ ]`、`[x]` など）を読む。task marker の形でなければ null。
 *
 * 完了かどうかは `[ ]`（半角空白）だけが未完了、それ以外の文字はすべて完了の 2 状態
 * （Obsidian 公式 help の「ブラケット内のどの文字でも完了」に合わせた）。
 * `[-]` や `[?]` に固有の意味は付けない。
 */
export function parseTaskMarker(marker: string): TaskMarker | null {
  const status = TASK_MARKER.exec(`${marker} `)?.[1];
  if (status === undefined || `[${status}]` !== marker) return null;
  return { status, checked: status !== UNCHECKED };
}

/**
 * checkbox を切り替えたときにブラケット内へ書く文字。未完了なら `x`、完了ならどの文字でも空白に戻す。
 */
export function toggledTaskStatus(marker: TaskMarker): string {
  return marker.checked ? UNCHECKED : CHECKED;
}

class TaskParser implements LeafBlockParser {
  constructor(private readonly markerLength: number) {}

  nextLine(): boolean {
    return false;
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    const markerTo = leaf.start + this.markerLength;
    cx.addLeafElement(
      leaf,
      cx.elt(taskListNodes.task, leaf.start, leaf.start + leaf.content.length, [
        cx.elt(taskListNodes.marker, leaf.start, markerTo),
        ...cx.parser.parseInline(leaf.content.slice(this.markerLength), markerTo),
      ]),
    );
    return true;
  }
}

/**
 * Obsidian の task list（`- [ ]`、`- [x]`）を解析する MarkdownConfig。
 *
 * GFM の TaskList はブラケット内に空白と `x`/`X` しか認めないが、Obsidian はどの 1 文字でも
 * 完了のタスクとして読むので、`[-]` や `[?]` も task にする。block parser の名前を GFM と同じ
 * `TaskList` にしてあり、GFM 入りの parser に `configure` すると GFM のものを置き換える。
 *
 * 中身は段落と同じく inline として解析するので、links/tags/block id の抽出には載せない
 * （載せても抽出結果が変わらない）。
 */
export const ObsidianTaskList: MarkdownConfig = {
  defineNodes: [
    { name: taskListNodes.task, block: true, style: tags.list },
    { name: taskListNodes.marker, style: tags.atom },
  ],
  parseBlock: [
    {
      name: "TaskList",
      leaf(cx, leaf) {
        const match = TASK_MARKER.exec(leaf.content);
        if (!match || cx.parentType().name !== "ListItem") return null;
        // 末尾の空白は marker に含めない
        return new TaskParser(match[0].length - 1);
      },
      after: "SetextHeading",
    },
  ],
};
