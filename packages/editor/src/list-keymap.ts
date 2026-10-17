import { isolateHistory } from "@codemirror/commands";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  countColumn,
  EditorSelection,
  type EditorState,
  type Extension,
  type Line,
  Prec,
  type Text,
  type Transaction,
} from "@codemirror/state";
import { type Command, keymap } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { isComposing } from "./ime";

/** ここに入った行では Tab を奪わず、既定の動作（フォーカス移動）に任せる */
const opaqueBlocks = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "CommentBlock"]);

function itemForLine(state: EditorState, tree: Tree, line: Line): SyntaxNode | null {
  const offset = line.text.search(/[^\s>]/);
  if (offset < 0) return null;
  const pos = line.from + offset;
  if (!markdownLanguage.isActiveAt(state, pos, 1)) return null;
  for (let node: SyntaxNode | null = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (opaqueBlocks.has(node.name)) return null;
    if (node.name === "ListItem") return node;
  }
  return null;
}

/** 選択範囲の行にかかる list item のうち、祖先が選ばれていないもの（子孫は祖先と一緒に動く） */
function selectedRoots(state: EditorState, tree: Tree): SyntaxNode[] {
  const found = new Map<number, SyntaxNode>();
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to; ) {
      const line = state.doc.lineAt(pos);
      if (range.empty || range.to > line.from) {
        const item = itemForLine(state, tree, line);
        if (item) found.set(item.from, item);
      }
      pos = line.to + 1;
    }
  }
  const items = [...found.values()];
  return items.filter((item) => {
    for (let p = item.parent; p; p = p.parent) {
      if (p.name === "ListItem" && found.has(p.from)) return false;
    }
    return true;
  });
}

function listItems(list: SyntaxNode): SyntaxNode[] {
  const items: SyntaxNode[] = [];
  // 引用の中のリストでは、ListItem の間に外側の QuoteMark が兄弟として挟まる
  for (let child = list.firstChild; child; child = child.nextSibling) {
    if (child.name === "ListItem") items.push(child);
  }
  return items;
}

function listMark(item: SyntaxNode): SyntaxNode {
  const mark = item.getChild("ListMark");
  if (!mark) throw new Error("ListItem without ListMark");
  return mark;
}

function markerColumn(state: EditorState, item: SyntaxNode): number {
  const mark = listMark(item);
  const line = state.doc.lineAt(mark.from);
  return countColumn(line.text, state.tabSize, mark.from - line.from);
}

/**
 * 子の list item を置くべき列。CommonMark では、記号の後の空白が 1〜4 列なら本文の開始列、
 * 5 列以上か本文が無ければ記号の直後 + 1 列が item の内側になる。
 */
function contentColumn(state: EditorState, item: SyntaxNode): number {
  const mark = listMark(item);
  const line = state.doc.lineAt(mark.from);
  const markEnd = mark.to - line.from;
  const space = /^[ \t]*/.exec(line.text.slice(markEnd))?.[0] ?? "";
  const markEndColumn = countColumn(line.text, state.tabSize, markEnd);
  const textColumn = countColumn(line.text, state.tabSize, markEnd + space.length);
  if (markEnd + space.length === line.text.length || textColumn - markEndColumn > 4) {
    return markEndColumn + 1;
  }
  return textColumn;
}

interface ListNumber {
  readonly value: number;
  readonly delimiter: string;
}

interface TextEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

function parseNumber(mark: string): ListNumber | null {
  const match = /^(\d+)([.)])$/.exec(mark);
  if (!match?.[1] || !match[2]) return null;
  return { value: Number(match[1]), delimiter: match[2] };
}

function markText(state: EditorState, item: SyntaxNode): string {
  const mark = listMark(item);
  return state.sliceDoc(mark.from, mark.to);
}

/** `1.` を並べる書き方のリスト。項目が 1 つだけなら連番と見分けられないので含めない */
function numberedWithOnes(state: EditorState, list: SyntaxNode): boolean {
  const items = listItems(list);
  return items.length > 1 && items.every((item) => parseNumber(markText(state, item))?.value === 1);
}

/**
 * 1 回の Tab / Shift+Tab の編集を溜め、最後にまとめて変更にする。
 *
 * 行頭の空白の増減は、位置ごとに列数を足し合わせてから 1 回で書く。祖先の item と子孫の item が
 * 別々の理由で動く（移動と、記号の幅が変わったことによる子の追従など）と、同じ空白に 2 つの
 * 変更が重なるため。
 *
 * 記号（番号）は先に決める。記号の幅が変わると item の本文の列が動くので、子の行もその分だけ
 * ずらす（`9.` → `10.` で子が 1 列ずれないと、CommonMark では子でなくなる）。
 */
class NestingEdit {
  private readonly shifts = new Map<number, number>();
  private readonly marks = new Map<number, { item: SyntaxNode; text: string }>();
  /**
   * コードの中身の行（キーは `shifts` と同じ）の、項目のインデントとして読まれる列。
   * この列より後ろの空白はコードの中身なので、増減はこの列の手前で行う
   */
  private readonly codeIndents = new Map<number, number>();
  /** 入れ子の深さが変わる item（子孫はここに入れず、祖先から辿る） */
  readonly moved = new Set<number>();
  /** 変更が及ぶリスト。事後の検査で比べる範囲の起点になる */
  readonly lists: SyntaxNode[] = [];

  constructor(
    private readonly state: EditorState,
    private readonly tree: Tree,
  ) {}

  /** item の記号を `text` に書き換える予定を立てる */
  setMark(item: SyntaxNode, text: string): void {
    if (text === markText(this.state, item)) this.marks.delete(item.from);
    else this.marks.set(item.from, { item, text });
  }

  /** 番号付きの item の番号だけを変える。区切り（`.` / `)`）は今の予定のまま */
  renumber(item: SyntaxNode, value: number): void {
    const number = this.numberOf(item);
    if (number) this.setMark(item, `${value}${number.delimiter}`);
  }

  /** 予定を反映した後の番号。先に処理したリストが決めた番号を、後のリストが読めるようにする */
  numberOf(item: SyntaxNode): ListNumber | null {
    return parseNumber(this.marks.get(item.from)?.text ?? markText(this.state, item));
  }

  /** 記号の書き換えで変わる幅の列数 */
  widthDelta(item: SyntaxNode): number {
    const planned = this.marks.get(item.from);
    return planned ? planned.text.length - markText(this.state, item).length : 0;
  }

  /**
   * item の行（子孫を含む）を `delta` 列だけずらす。記号のある 1 行目以外は `restDelta` 列。
   * 外側の引用の `>` より後ろ、最初の非空白文字の直前の空白で増減させる。行頭で足すとタブの
   * 後ろの列が変わらないことがあるので、空白の末尾で扱う。ただし fence やインデントされたコードの
   * 中身の行では、項目のインデントより後ろの空白もコードの一部なので、インデントの中で増減させる
   * （空白の末尾で足すと、元のタブがインデントとして読まれてスペースに化ける）。
   * item の本文の列より浅い行は怠惰な継続行（lazy continuation）なので触らない。動かしたことで
   * 構造が変わる場合（インデントされたコードの位置にあった行が項目になるなど）は事後の検査が弾く。
   */
  shift(item: SyntaxNode, delta: number, restDelta = delta): void {
    const { state } = this;
    let quotes = 0;
    for (let p = item.parent; p; p = p.parent) if (p.name === "Blockquote") quotes += 1;
    const first = state.doc.lineAt(item.from).number;
    const last = state.doc.lineAt(item.to).number;
    const content = contentColumn(state, item);
    for (let n = first; n <= last; n += 1) {
      const lineDelta = n === first ? delta : restDelta;
      if (lineDelta === 0) continue;
      const line = state.doc.line(n);
      // 行頭から数えて外側の引用の数だけの `>` が外側の引用のもの。その後ろの `>` は item の中の
      // 引用。構文木の QuoteMark では数えない（引用の中の setext の下線の行では `>` が QuoteMark
      // にならない）
      let prefixEnd = line.from;
      const leading = /^[\s>]*/.exec(line.text)?.[0] ?? "";
      for (let i = 0, seen = 0; i < leading.length && seen < quotes; i += 1) {
        if (leading[i] !== ">") continue;
        seen += 1;
        prefixEnd = line.from + i + 1;
      }
      const space = /^[ \t]*/.exec(line.text.slice(prefixEnd - line.from))?.[0] ?? "";
      const textStart = prefixEnd - line.from + space.length;
      const textColumn = countColumn(line.text, state.tabSize, textStart);
      const codeIndent =
        n === first
          ? null
          : this.codeIndent(textStart === line.text.length ? line.from : line.from + textStart);
      // 空白だけの行はインデントが要らない。コードの中では、インデントより後ろの空白が中身なので動かす
      if (textStart === line.text.length && (codeIndent === null || textColumn <= codeIndent))
        continue;
      if (n !== first && textColumn < content) continue;
      if (codeIndent !== null) this.codeIndents.set(prefixEnd, codeIndent);
      this.shifts.set(prefixEnd, (this.shifts.get(prefixEnd) ?? 0) + lineDelta);
    }
  }

  /**
   * `pos`（行の最初の非空白文字、空白だけの行なら行頭）が fence やインデントされたコードの中
   * （fence の行を含む）なら、その行でコードの中身より手前のインデントとして読まれる列。fence では
   * コードを含む一番内側の item の本文の列、インデントされたコードではそこから 4 列先（その 4 列も
   * コードのインデントで、中身ではない）。そうでなければ null。引用を挟むコードは `>` の後ろが中身なので
   * 対象にしない
   */
  private codeIndent(pos: number): number | null {
    const { state } = this;
    let node: SyntaxNode | null = this.tree.resolveInner(pos, 1);
    for (; node; node = node.parent) {
      if (node.name === "FencedCode" || node.name === "CodeBlock") break;
      if (node.name === "ListItem" || node.name === "Blockquote") return null;
    }
    if (!node) return null;
    for (let p = node.parent; p; p = p.parent) {
      if (p.name === "Blockquote") return null;
      if (p.name === "ListItem")
        return contentColumn(state, p) + (node.name === "CodeBlock" ? 4 : 0);
    }
    return null;
  }

  changes(): TextEdit[] {
    const { state } = this;
    for (const { item } of this.marks.values()) {
      const width = this.widthDelta(item);
      if (width !== 0) this.shift(item, 0, width);
    }
    const edits: TextEdit[] = [];
    /** 記号の位置 → 記号の列がずれる列数 */
    const markShifts = new Map<number, number>();
    for (const { item } of this.marks.values()) markShifts.set(listMark(item).from, 0);
    const advance = (column: number, ch: string) =>
      ch === "\t" ? column + state.tabSize - (column % state.tabSize) : column + 1;
    for (const [prefixEnd, delta] of this.shifts) {
      if (delta === 0) continue;
      const line = state.doc.lineAt(prefixEnd);
      const space = /^[ \t]*/.exec(line.text.slice(prefixEnd - line.from))?.[0] ?? "";
      const startColumn = countColumn(line.text, state.tabSize, prefixEnd - line.from);
      // 書き換えるのはインデントとして読まれる部分。コードの中身の行では、parser と同じく目標の列に
      // 届くまで（またぐタブを含めて）がインデントで、残りはコードの中身として触らない
      const codeIndent = this.codeIndents.get(prefixEnd);
      let indentLength = space.length;
      let oldColumn = countColumn(line.text, state.tabSize, prefixEnd - line.from + space.length);
      if (codeIndent !== undefined) {
        indentLength = 0;
        oldColumn = startColumn;
        while (indentLength < space.length && oldColumn < codeIndent) {
          oldColumn = advance(oldColumn, space[indentLength] as string);
          indentLength += 1;
        }
      }
      // コードの行は、新しいインデントの列でちょうど parser の読むインデントが終わるようにする。
      // インデントをまたぐタブはインデントに含めて読まれるので、元の列でなく目標の列から数える
      const newColumn = Math.max(startColumn, (codeIndent ?? oldColumn) + delta);
      let kept = "";
      let column = startColumn;
      for (const ch of space.slice(0, indentLength)) {
        const next = advance(column, ch);
        if (next > newColumn) break;
        kept += ch;
        column = next;
      }
      const insert = kept + " ".repeat(newColumn - column);
      const mark = this.tree.resolveInner(prefixEnd + space.length, 1);
      if (mark.name === "ListMark" && mark.from === prefixEnd + space.length)
        markShifts.set(mark.from, newColumn - oldColumn);
      if (insert !== space.slice(0, indentLength))
        edits.push({ from: prefixEnd, to: prefixEnd + indentLength, insert });
    }
    for (const [from, markShift] of markShifts) {
      const mark = this.tree.resolveInner(from, 1);
      const text =
        this.marks.get(mark.parent?.from ?? -1)?.text ?? state.sliceDoc(mark.from, mark.to);
      const line = state.doc.lineAt(mark.from);
      const markEnd = mark.to - line.from;
      const space = /^[ \t]*/.exec(line.text.slice(markEnd))?.[0] ?? "";
      // 記号の後のタブはタブ位置まで伸びるので、記号の列や幅が変わると本文の列が記号と一緒に
      // 動かないことがある（`-\tb` を 2 列ずらしても本文は 4 列目のまま）。そうなるときだけ、
      // 今の位置での幅の空白に置き換える。本文の無い項目は本文の列が空白で決まらないので触らない
      const markEndColumn = countColumn(line.text, state.tabSize, markEnd);
      const width = countColumn(line.text, state.tabSize, markEnd + space.length) - markEndColumn;
      const newMarkEnd =
        countColumn(line.text, state.tabSize, mark.from - line.from) + markShift + text.length;
      let kept = newMarkEnd;
      for (const ch of space) kept = advance(kept, ch);
      const convert =
        space.includes("\t") &&
        markEnd + space.length < line.text.length &&
        kept - newMarkEnd !== width;
      if (!convert && text === state.sliceDoc(mark.from, mark.to)) continue;
      edits.push(
        convert
          ? { from: mark.from, to: mark.to + space.length, insert: text + " ".repeat(width) }
          : { from: mark.from, to: mark.to, insert: text },
      );
    }
    return edits;
  }
}

/**
 * 番号付きリストの残った項目を詰め直す。lang-markdown の Enter と同じく、元の番号が連番だった
 * ところまでだけ振り直す。`1.` を並べる書き方のように連番でないリストには手を付けない。
 * `moved` の項目は飛ばし、`restart` の項目の次からは 1 から数え直す。
 */
function renumberRemaining(
  state: EditorState,
  items: readonly SyntaxNode[],
  moved: (item: SyntaxNode) => boolean,
  restart: (item: SyntaxNode) => boolean,
  edit: NestingEdit,
): void {
  let previous: number | null = null;
  let next: number | null = null;
  for (const item of items) {
    const number = parseNumber(markText(state, item));
    if (!number) return;
    if (previous !== null && number.value !== previous + 1) return;
    previous = number.value;
    if (restart(item)) {
      next = 1;
    } else if (!moved(item)) {
      if (next === null) next = number.value;
      edit.renumber(item, next);
      next += 1;
    }
  }
}

/** Tab。item を直前の兄弟の子にする。直前に兄弟が無い項目は入れ子にできないので動かさない */
function indentChanges(state: EditorState, roots: readonly SyntaxNode[], edit: NestingEdit): void {
  const rootFroms = new Set(roots.map((root) => root.from));
  const lists = new Map<number, SyntaxNode>();
  for (const root of roots) if (root.parent) lists.set(root.parent.from, root.parent);

  for (const list of lists.values()) {
    const items = listItems(list);
    const runs: { target: SyntaxNode; run: SyntaxNode[] }[] = [];
    for (let i = 0; i < items.length; ) {
      const target = items[i - 1];
      if (!rootFroms.has(items[i]?.from ?? -1) || !target) {
        i += 1;
        continue;
      }
      const run: SyntaxNode[] = [];
      for (; i < items.length && rootFroms.has(items[i]?.from ?? -1); i += 1) {
        const item = items[i];
        if (item) run.push(item);
      }
      runs.push({ target, run });
    }
    const moved = new Set(runs.flatMap(({ run }) => run.map((item) => item.from)));
    if (runs.length > 0) edit.lists.push(list);
    for (const from of moved) edit.moved.add(from);

    if (list.name === "OrderedList") {
      for (const { target, run } of runs) {
        // 直前の兄弟が同じ区切りの番号付きリストを子に持っていれば、その続きになる
        const child = target.lastChild;
        const tail = child?.name === "OrderedList" ? listItems(child).at(-1) : undefined;
        const tailNumber = tail ? parseNumber(markText(state, tail)) : null;
        const own = parseNumber(markText(state, run[0] as SyntaxNode));
        let start = 1;
        if (child && tailNumber && tailNumber.delimiter === own?.delimiter) {
          start = numberedWithOnes(state, child) ? 1 : tailNumber.value + 1;
        }
        run.forEach((item, k) => {
          edit.renumber(item, start + k);
        });
      }
      renumberRemaining(
        state,
        items,
        (item) => moved.has(item.from),
        () => false,
        edit,
      );
    }

    // 詰めた番号の桁が変わると、直前の兄弟の本文の列（子を置く列）も変わる
    for (const { target, run } of runs) {
      const column = contentColumn(state, target) + edit.widthDelta(target);
      for (const item of run) edit.shift(item, column - markerColumn(state, item));
    }
  }
}

function depth(node: SyntaxNode): number {
  let n = 0;
  for (let p = node.parent; p; p = p.parent) n += 1;
  return n;
}

/**
 * Shift+Tab。item を親の item の兄弟にする。後ろに残った兄弟は、動かした item の子になる。
 *
 * 動かした item の記号は、外側のリストの種類と区切り（`-` / `*` / `+`、`.` / `)`）に合わせる。
 * 記号が違うとそこで外側のリストが切れ、親の後ろの兄弟が新しいリストの先頭になる。先頭が 1 以外の
 * 番号付き項目は段落の途中から始められないので、直前の項目の本文へ吸い込まれて項目でなくなる。
 */
function outdentChanges(
  state: EditorState,
  roots: readonly SyntaxNode[],
  edit: NestingEdit,
): boolean {
  const rootFroms = new Set(roots.map((root) => root.from));
  const isRoot = (item: SyntaxNode) => rootFroms.has(item.from);
  const lists = new Map<number, SyntaxNode>();
  for (const root of roots) if (root.parent) lists.set(root.parent.from, root.parent);
  // 外側のリストから、同じ深さなら文書順に処理する。内側のリストから出る item の番号と、それで
  // 繰り下がる兄弟の番号は、外側や手前のリストの処理が決めた番号の続きにする
  const ordered = [...lists.values()].sort((a, b) => depth(a) - depth(b) || a.from - b.from);

  for (const list of ordered) {
    const parent = list.parent;
    const outer = parent?.parent;
    // 引用を挟んだ入れ子やトップレベルのリストは、外へ出す先の item が無い
    if (parent?.name !== "ListItem" || !outer) continue;
    const items = listItems(list);
    const moved = items.filter(isRoot);
    edit.lists.push(outer);
    for (const item of moved) edit.moved.add(item.from);

    const parentNumber = edit.numberOf(parent);
    if (parentNumber && numberedWithOnes(state, outer)) {
      for (const item of moved) edit.setMark(item, `1${parentNumber.delimiter}`);
    } else if (parentNumber) {
      moved.forEach((item, k) => {
        edit.setMark(item, `${parentNumber.value + 1 + k}${parentNumber.delimiter}`);
      });
      const outerItems = listItems(outer);
      const following = outerItems.slice(
        outerItems.findIndex((item) => item.from === parent.from) + 1,
      );
      // 親の後ろの兄弟は、動かした数だけ番号を送る（連番だったところまで。外へ出る item は除く）
      let previous = parentNumber.value;
      let next = parentNumber.value + moved.length;
      for (const item of following) {
        const number = edit.numberOf(item);
        if (isRoot(item) || !number || number.value !== previous + 1) break;
        previous = number.value;
        next += 1;
        edit.renumber(item, next);
      }
    } else {
      const bullet = markText(state, parent);
      for (const item of moved) edit.setMark(item, bullet);
    }
    if (list.name === "OrderedList") {
      renumberRemaining(state, items, isRoot, isRoot, edit);
      // 連番でないリストでも、新しい子のリストの先頭は 1 にする。1 以外は段落の途中から始められない
      items.forEach((item, i) => {
        const previous = items[i - 1];
        if (!isRoot(item) && previous && isRoot(previous)) edit.renumber(item, 1);
      });
    }

    const column = markerColumn(state, parent);
    // 親の記号の幅が変わると、`changes()` は親の 2 行目以降をその分ずらす。ここで動かす item の行も
    // そこに含まれるので、差し引いておかないと親の記号の列からずれる
    const parentWidth = edit.widthDelta(parent);
    /** 直前に動かした item の、動かした後の本文の列（親の幅の差を足す前） */
    let movedContent: number | null = null;
    for (const item of items) {
      if (isRoot(item)) {
        const delta = column - markerColumn(state, item) - parentWidth;
        edit.shift(item, delta);
        movedContent = contentColumn(state, item) + delta + edit.widthDelta(item);
      } else if (movedContent !== null) {
        // 記号の幅が親と違うと、元の列のままでは動かした item の子にならない
        edit.shift(item, movedContent - markerColumn(state, item));
      }
    }
  }
  return roots.some(isNested);
}

function isNested(item: SyntaxNode): boolean {
  for (let p = item.parent; p; p = p.parent) if (p.name === "ListItem") return true;
  return false;
}

/** 事後の検査のための構文解析にかける時間の上限（ms）。間に合わなければ確かめられないので変更しない */
const parseBudget = 100;

interface Scope {
  readonly from: number;
  readonly to: number;
}

function itemDepth(node: SyntaxNode): number {
  let depth = 0;
  for (let p = node.parent; p; p = p.parent) if (p.name === "ListItem") depth += 1;
  return depth;
}

const listMarkText = /^[\s>]*([-*+]|\d{1,9}[.)])([ \t]|$)/;

/**
 * 変更で構文が変わりうる範囲。変更の最初の行と最後の行（`changedFrom` / `changedTo`）を挟む。
 *
 * 始まりは、最初の変更の直前の空でない行を含む一番内側の item の先頭。前の行の読み方が後ろの行で
 * 変わるのは段落が setext の見出しや表の見出し行になる場合だけで、その段落はこの item の中にある。
 * 見つからなければ変わるリストの先頭の行。
 *
 * 終わりは、次の 2 つのうち手前のもの。どちらも、そこから先の行は読み方が変わらない。
 * - 最後の変更より後ろで、変わるリストの項目のうち一番浅いもの以下の深さで始まる item の行。
 *   この行は動かした item と記号を変えた item の中に無い（中にあれば本文の列まで下がっていて、
 *   一緒にずらしている）。この行が前後で同じ深さの item として読まれれば、それより深い入れ物は
 *   すべて閉じ、残る祖先は動いていない item なので、後ろの行は同じ状態から読まれる。
 *   前後で同じに読まれることは事後の検査で確かめる。
 * - リストの後ろで「空行の次にある、リストの記号の列 + 2 より浅い行」の手前。そこから先は、
 *   怠惰な継続行にならず（空行の後）、リストのどの item の本文の列にも届かない（記号 1 文字と
 *   空白 1 つが最小）。
 * 空行の無い長いリストでも手間が文書の長さで決まらないよう、前者を先に探す。
 */
function checkScope(
  state: EditorState,
  tree: Tree,
  lists: readonly SyntaxNode[],
  changedFrom: number,
  changedTo: number,
): Scope | null {
  if (lists.length === 0) return null;
  const { doc } = state;
  let from = doc.length;
  for (const list of lists) from = Math.min(from, doc.lineAt(list.from).from);
  for (let n = doc.lineAt(changedFrom).number - 1; n >= 1; n -= 1) {
    const line = doc.line(n);
    const offset = line.text.search(/[^\s>]/);
    if (offset < 0) continue;
    for (
      let node: SyntaxNode | null = tree.resolveInner(line.from + offset, 1);
      node;
      node = node.parent
    ) {
      if (node.name === "ListItem") {
        from = Math.max(from, doc.lineAt(node.from).from);
        break;
      }
    }
    break;
  }

  const shallowest = Math.min(...lists.map(itemDepth));
  let to = doc.length;
  for (let n = doc.lineAt(changedTo).number + 1; n <= doc.lines; n += 1) {
    const line = doc.line(n);
    // 解析の済んでいない行は item かどうか分からず、途中で切れたリストでは番号の振り直しも
    // 途中までしか組み立てていない。後者の規則（リストの終わり）に任せ、そこまで解析させる
    if (line.to > tree.length) break;
    if (!listMarkText.test(line.text)) continue;
    const offset = line.text.search(/[^\s>]/);
    const mark = tree.resolveInner(line.from + offset, 1);
    if (mark.name === "ListMark" && mark.parent && itemDepth(mark.parent) <= shallowest) {
      to = line.to;
      break;
    }
  }

  let listsEnd = 0;
  for (const list of lists) {
    const floor = Math.min(...listItems(list).map((item) => markerColumn(state, item))) + 2;
    let end = doc.length;
    let blank = false;
    for (let n = doc.lineAt(list.to).number + 1; n <= doc.lines; n += 1) {
      const line = doc.line(n);
      if (line.from >= to) break;
      const lead = /^[\s>]*/.exec(line.text)?.[0] ?? "";
      if (lead.length === line.text.length) {
        blank = true;
        continue;
      }
      if (blank && countColumn(line.text, state.tabSize, lead.length) < floor) {
        end = line.from;
        break;
      }
      blank = false;
    }
    listsEnd = Math.max(listsEnd, end);
  }
  return { from, to: Math.min(to, listsEnd) };
}

/** 範囲の終わりの行まで解析が済んでいるか（範囲の終わりを決める行を parser が読んでいるか） */
function covers(state: EditorState, tree: Tree, scope: Scope): boolean {
  return tree.length >= state.doc.lineAt(scope.to).to;
}

interface ItemShape {
  /** 始まる行の番号。変更は改行を増減させないので、前後で同じ行から始まるはず */
  readonly line: number;
  readonly depth: number;
  readonly own: string;
  readonly moved: boolean;
}

const ownLine = (line: string) =>
  line
    .replace(/^[\s>]*/, "")
    .replace(/^([-*+]|\d{1,9}[.)])(?=\s|$)/, "")
    .trim();

/**
 * 範囲にかかる list item の、深さと本文（子のリストを除き、行頭の空白、`>`、記号を落としたもの）。
 * 範囲の外の本文は前後で同じなので、範囲の終わりで切る（解析の済んだ位置が前後で違っても揃う）。
 */
function itemShapes(
  state: EditorState,
  tree: Tree,
  scope: Scope,
  moved: ReadonlySet<number> = new Set(),
): ItemShape[] {
  const shapes: ItemShape[] = [];
  tree.iterate({
    from: scope.from,
    to: scope.to,
    enter: (ref) => {
      if (ref.name !== "ListItem" || ref.to <= scope.from || ref.from >= scope.to) return;
      const node = ref.node;
      let depth = 0;
      let isMoved = moved.has(node.from);
      for (let p = node.parent; p; p = p.parent) {
        if (p.name !== "ListItem") continue;
        depth += 1;
        if (moved.has(p.from)) isMoved = true;
      }
      const end = Math.min(node.to, scope.to);
      let text = "";
      let pos = node.from;
      for (let child = node.firstChild; child && child.from < end; child = child.nextSibling) {
        if (child.name !== "BulletList" && child.name !== "OrderedList") continue;
        text += `${state.sliceDoc(pos, child.from)}\n`;
        pos = child.to;
      }
      if (pos < end) text += state.sliceDoc(pos, end);
      const own = text
        .split("\n")
        .map(ownLine)
        .filter((line) => line !== "")
        .join("\n");
      shapes.push({ line: state.doc.lineAt(node.from).number, depth, own, moved: isMoved });
    },
  });
  return shapes;
}

/** 行のブロックの種類を比べるときに飛ばす node。入れ子の深さと記号は itemShapes が見る */
const listContainers = new Set([
  "Document",
  "ListItem",
  "BulletList",
  "OrderedList",
  "ListMark",
  "Task",
  "TaskMarker",
  "QuoteMark",
]);

/**
 * 範囲の行ごとの、最初の文字にかかる node の祖先（リストの入れ物を除く）の名前と始まる行の並び。
 * 本文の比較は行頭の空白を落とすので、段落がインデントされたコードになる、段落の次の行が
 * setext の下線になる、段落が 2 つに分かれる（次の行が表の区切り行として読まれる）といった
 * ブロックの変化はこちらで拾う。
 * 変更は行頭の空白と記号しか書き換えず改行の数は変わらないので、前後で同じ行番号を比べられる。
 */
function lineKinds(state: EditorState, tree: Tree, first: number, last: number): string[] {
  const kinds: string[] = [];
  for (let n = first; n <= last; n += 1) {
    const line = state.doc.line(n);
    const offset = line.text.search(/[^\s>]/);
    const names: string[] = [];
    if (offset >= 0) {
      for (
        let node: SyntaxNode | null = tree.resolveInner(line.from + offset, 1);
        node;
        node = node.parent
      ) {
        if (!listContainers.has(node.name))
          names.push(`${node.name}@${state.doc.lineAt(node.from).number}`);
      }
    }
    kinds.push(names.join("<"));
  }
  return kinds;
}

/**
 * 範囲のコードの中身（fence とインデントされたコードの CodeText）を、空白を落とさずに並べたもの。
 * 項目のインデントとコードの中身の空白の境目は parser の読み方で決まり、本文の比較（空白を落とす）でも
 * 行の種類でも、タブがインデントとして読まれてスペースに化けたことは分からない。Go や Makefile では
 * タブに意味があるので、中身の文字が 1 つでも変わる変更は捨てる。
 */
function codeTexts(state: EditorState, tree: Tree, scope: Scope): string[] {
  const texts: string[] = [];
  tree.iterate({
    from: scope.from,
    to: scope.to,
    enter: (ref) => {
      if (ref.name !== "CodeText" || ref.to <= scope.from || ref.from >= scope.to) return;
      const block = ref.node.parent;
      const line = block ? state.doc.lineAt(block.from).number : 0;
      const text = state.sliceDoc(Math.max(ref.from, scope.from), Math.min(ref.to, scope.to));
      // インデントの位置が変わると、parser が改行を前後の CodeText のどちらに付けるかが変わるので、
      // node の区切りでなくコードのブロックごとにつなげて比べる
      if (texts.at(-1)?.startsWith(`${line}|`)) texts[texts.length - 1] += text;
      else texts.push(`${line}|${text}`);
    },
  });
  return texts;
}

/**
 * 事後の検査。規則で組み立てた変更を適用した構文木で、範囲の list item が同じ数、同じ順に並び、
 * 本文と各行のブロックの種類が変わらず、動かした item（と子孫）だけが 1 段深く / 浅くなって
 * いるかを確かめる。
 * 記号の種類や番号、継続行、空の項目などの組み合わせで、項目が段落に吸い込まれたり本文が別の
 * 項目へ移ったりする抜け穴が続いたので、個別の条件を塞ぐのでなく結果を見る。
 */
function keepsListItems(
  state: EditorState,
  tree: Tree,
  tr: Transaction,
  edit: NestingEdit,
  scope: Scope,
  step: 1 | -1,
): boolean {
  const next = tr.state;
  const nextScope = {
    from: tr.changes.mapPos(scope.from, -1),
    to: tr.changes.mapPos(scope.to, 1),
  };
  const nextTree = ensureSyntaxTree(next, next.doc.lineAt(nextScope.to).to, parseBudget);
  if (!nextTree) return false;
  const before = itemShapes(state, tree, scope, edit.moved);
  const after = itemShapes(next, nextTree, nextScope);
  const sameItems =
    before.length === after.length &&
    before.every((item, i) => {
      const now = after[i];
      return (
        now?.line === item.line &&
        now.own === item.own &&
        now.depth === item.depth + (item.moved ? step : 0)
      );
    });
  if (!sameItems) return false;
  const first = state.doc.lineAt(scope.from).number;
  const last = state.doc.lineAt(scope.to).number;
  const kindsBefore = lineKinds(state, tree, first, last);
  const kindsAfter = lineKinds(next, nextTree, first, last);
  if (!kindsBefore.every((kind, i) => kind === kindsAfter[i])) return false;
  const codeBefore = codeTexts(state, tree, scope);
  const codeAfter = codeTexts(next, nextTree, nextScope);
  return (
    codeBefore.length === codeAfter.length && codeBefore.every((text, i) => text === codeAfter[i])
  );
}

interface Plan {
  readonly edit: NestingEdit;
  readonly edits: TextEdit[];
  /** 変更しないときにキーを消費するか */
  readonly handled: boolean;
  readonly scope: Scope | null;
}

function planNesting(state: EditorState, tree: Tree, direction: "indent" | "outdent"): Plan | null {
  const roots = selectedRoots(state, tree);
  if (roots.length === 0) return null;
  const edit = new NestingEdit(state, tree);
  // Tab は入れ子にできない項目でも奪う。本文の後ろにあるのは editor と関係の薄い UI で、
  // リストを書いている途中でフォーカスが飛ぶと文脈を失う。抜けたいときは Escape → Tab を使う。
  // Shift+Tab は入れ子の中なら、戻せないとき（検査に落ちたときなど）も奪う。トップレベルでは
  // 奪わない。本文の前には title 欄があり、本文から戻る経路が Shift+Tab である
  let handled = true;
  if (direction === "indent") indentChanges(state, roots, edit);
  else handled = outdentChanges(state, roots, edit);
  const edits = edit.changes();
  if (edits.length === 0) return { edit, edits, handled, scope: null };
  const changedFrom = Math.min(...edits.map((e) => e.from));
  const changedTo = Math.max(...edits.map((e) => e.to));
  return {
    edit,
    edits,
    handled,
    scope: checkScope(state, tree, edit.lists, changedFrom, changedTo),
  };
}

function changeListNesting(direction: "indent" | "outdent"): Command {
  return (view) => {
    // IME 不変条件 3。Safari は compositionend と keydown の順序が入れ替わることがある
    if (isComposing(view)) return false;
    const { state } = view;
    if (state.readOnly) return false;
    let tree = syntaxTree(state);
    let plan = planNesting(state, tree, direction);
    // 画面外は解析が済んでいないことがある。途中で切れたリストでは範囲も変更も読み違えるので、
    // 範囲の終わりまで解析してから組み立て直す（範囲はリストの終わりで決まるので、数回で収まる）
    for (let i = 0; plan?.scope && !covers(state, tree, plan.scope); i += 1) {
      const more =
        i < 4 ? ensureSyntaxTree(state, state.doc.lineAt(plan.scope.to).to, parseBudget) : null;
      if (!more) return plan.handled;
      tree = more;
      plan = planNesting(state, tree, direction);
    }
    if (!plan) return false;
    if (plan.edits.length === 0 || !plan.scope) return plan.handled;
    const changes = state.changes(plan.edits);
    const tr = state.update({
      changes,
      selection: state.selection.map(changes, 1),
      scrollIntoView: true,
      userEvent: direction === "indent" ? "input.indent" : "delete.dedent",
      // 直前の入力とまとめて戻されないよう、undo の単位を前後で切る
      annotations: isolateHistory.of("full"),
    });
    if (!keepsListItems(state, tree, tr, plan.edit, plan.scope, direction === "indent" ? 1 : -1)) {
      return plan.handled;
    }
    view.dispatch(tr);
    return true;
  };
}

/**
 * lang-markdown の `getContext` の必要な部分を写したもの（export されていない）。
 * Shift+Enter の行頭を、Enter が item の 2 行目以降で作る継続の行頭と揃えるために使う。
 */
interface Container {
  readonly node: SyntaxNode;
  readonly from: number;
  readonly to: number;
  readonly spaceBefore: string;
  readonly spaceAfter: string;
}

function containers(node: SyntaxNode | null, doc: Text): Container[] | null {
  const nodes: SyntaxNode[] = [];
  for (let cur = node; cur; cur = cur.parent) {
    if (opaqueBlocks.has(cur.name)) return null;
    if (cur.name === "ListItem" || cur.name === "Blockquote") nodes.push(cur);
  }
  const result: Container[] = [];
  for (const cur of nodes.reverse()) {
    const line = doc.lineAt(cur.from);
    const start = cur.from - line.from;
    const text = line.text.slice(start);
    const quote = cur.name === "Blockquote" ? /^ *>( ?)/.exec(text) : null;
    const ordered = cur.parent?.name === "OrderedList" ? /^( *)\d+[.)]( *)/.exec(text) : null;
    const bullet =
      cur.parent?.name === "BulletList" ? /^( *)[-+*]( {1,4}\[[ xX]\])?( +)/.exec(text) : null;
    if (quote) {
      const to = start + quote[0].length;
      result.push({ node: cur, from: start, to, spaceBefore: "", spaceAfter: quote[1] ?? "" });
    } else if (ordered) {
      pushListContainer(result, cur, start, ordered[0].length, ordered[1] ?? "", ordered[2] ?? "");
    } else if (bullet) {
      pushListContainer(result, cur, start, bullet[0].length, bullet[1] ?? "", bullet[3] ?? "");
    }
  }
  return result;
}

function pushListContainer(
  result: Container[],
  node: SyntaxNode,
  start: number,
  length: number,
  spaceBefore: string,
  spaceAfter: string,
): void {
  // 記号の後の空白が 5 列以上なら、4 列を超えた分は本文（インデントされたコード）側
  const trim = spaceAfter.length > 4 ? 4 : 0;
  result.push({
    node,
    from: start,
    to: start + length - trim,
    spaceBefore,
    spaceAfter: spaceAfter.slice(0, spaceAfter.length - trim),
  });
}

/** 継続の行頭。引用は `>` を残し、list item は記号の幅を空白で埋める */
function blank(container: Container, maxWidth: number | null): string {
  let result = container.spaceBefore + (container.node.name === "Blockquote" ? ">" : "");
  if (maxWidth !== null) {
    while (result.length < maxWidth) result += " ";
    return result;
  }
  const width = container.to - container.from - result.length - container.spaceAfter.length;
  return result + " ".repeat(Math.max(0, width)) + container.spaceAfter;
}

/**
 * Shift+Enter。行頭記号を付けずに改行し、同じ list item（と外側の引用）の中に留まる。
 * リストや引用の外では何もしない（既定の `insertNewlineAndIndent` に任せる）。
 */
const insertSoftBreak: Command = (view) => {
  if (isComposing(view)) return false;
  const { state } = view;
  if (state.readOnly) return false;
  const tree = syntaxTree(state);
  let unhandled = false;
  const spec = state.changeByRange((range) => {
    const pos = range.from;
    if (
      !range.empty ||
      !(markdownLanguage.isActiveAt(state, pos, -1) || markdownLanguage.isActiveAt(state, pos, 1))
    ) {
      unhandled = true;
      return { range };
    }
    const line = state.doc.lineAt(pos);
    const context = containers(tree.resolveInner(pos, -1), state.doc) ?? [];
    while (context.length > 0 && (context.at(-1)?.from ?? 0) > pos - line.from) context.pop();
    const inner = context.at(-1);
    // 記号の途中（`- ` の前など）では継続の行頭を決められない
    if (!inner || inner.to - inner.spaceAfter.length > pos - line.from) {
      unhandled = true;
      return { range };
    }
    let insert = "";
    context.forEach((container, i) => {
      const nextContainer = context[i + 1];
      insert += blank(
        container,
        nextContainer ? countColumn(line.text, 4, nextContainer.from) - insert.length : null,
      );
    });
    // 改行の前の行末の空白は落とす。ただし空の item の記号の後ろの空白は記号の一部なので残す
    let from = pos;
    while (from > line.from + inner.to && /\s/.test(line.text.charAt(from - line.from - 1)))
      from -= 1;
    return {
      range: EditorSelection.cursor(from + 1 + insert.length),
      changes: { from, to: pos, insert: state.lineBreak + insert },
    };
  });
  if (unhandled) return false;
  view.dispatch(state.update(spec, { scrollIntoView: true, userEvent: "input" }));
  return true;
};

/**
 * リスト内の Tab/Shift+Tab による入れ子の変更と、Shift+Enter のソフト改行。
 * Shift+Enter は `defaultKeymap` の `insertNewlineAndIndent` より先に取る必要があるので Prec.high。
 * Enter と Backspace は `markdown()` の `markdownKeymap` が持つ。
 * 候補 UI が開いている間の Tab は autocomplete の keymap（Prec.highest）が先に取る。
 */
export function listKeymap(): Extension {
  return Prec.high(
    keymap.of([
      { key: "Tab", run: changeListNesting("indent"), shift: changeListNesting("outdent") },
      { key: "Shift-Enter", run: insertSoftBreak },
    ]),
  );
}
