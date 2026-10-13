import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { parseTaskMarker, taskListNodes } from "@personal-wiki/markdown";

/**
 * task の checkbox の送り幅（checkbox の幅と右の余白の和）を本文の文字の大きさに対する比で表したもの。
 * task-list.ts が checkbox をこの寸法で描き、live-preview.ts のぶら下げインデントが同じ値で
 * 行頭の幅を見積もる。片方だけ変えると、折り返した行が本文の始まりとずれる。
 */
export const TASK_CHECKBOX_EM = { width: 1, gap: 0.3 } as const;

export interface TaskSyntax {
  /** ブラケット（`[ ]`）の範囲。checkbox に置き換わる */
  readonly marker: { readonly from: number; readonly to: number };
  readonly checked: boolean;
  /**
   * 箇条書きの task で checkbox と一緒に隠す、行頭の記号とそれに続く空白（`- `）の範囲。
   * 番号付きリストの番号は本文の意味を運ぶので隠さず、null にする。
   */
  readonly hiddenMark: { readonly from: number; readonly to: number } | null;
  /**
   * source を出すかを判定する範囲の始点。記号を隠す箇条書きでは記号から、番号付きでは
   * ブラケットから始める。記号とブラケットを別々に判定すると、片方だけが source に戻った
   * `[ ] 本文` や `- ☐ 本文` のような中間の見た目ができる。
   */
  readonly revealFrom: number;
}

/** `task`（`Task` node）の checkbox に関わる範囲。ブラケットが task marker として読めなければ null */
export function taskSyntax(state: EditorState, task: SyntaxNode): TaskSyntax | null {
  const markerNode = task.getChild(taskListNodes.marker);
  if (!markerNode) return null;
  const parsed = parseTaskMarker(state.sliceDoc(markerNode.from, markerNode.to));
  if (!parsed) return null;
  const marker = { from: markerNode.from, to: markerNode.to };
  const listMark = task.prevSibling;
  const bullet =
    listMark?.name === "ListMark" &&
    task.parent?.name === "ListItem" &&
    task.parent.parent?.name === "BulletList" &&
    state.doc.lineAt(listMark.from).number === state.doc.lineAt(marker.from).number;
  if (!bullet || !listMark) {
    return { marker, checked: parsed.checked, hiddenMark: null, revealFrom: marker.from };
  }
  return {
    marker,
    checked: parsed.checked,
    hiddenMark: { from: listMark.from, to: marker.from },
    revealFrom: listMark.from,
  };
}
