import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Line,
  MapMode,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import { type EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import { isCompositionUnsettled } from "./ime";
import { byScheme } from "./scheme";

/** Obsidian の標準の 13 タイプ。見た目（色とアイコン）はこの単位で決まる */
export type CalloutType =
  | "note"
  | "abstract"
  | "info"
  | "todo"
  | "tip"
  | "success"
  | "question"
  | "warning"
  | "failure"
  | "danger"
  | "bug"
  | "example"
  | "quote";

// Map にする。素のオブジェクトだと `[!constructor]` や `[!__proto__]` が prototype の
// プロパティに当たり、`note` にフォールバックしない。
const TYPE_BY_IDENTIFIER: ReadonlyMap<string, CalloutType> = new Map(
  Object.entries({
    note: "note",
    abstract: "abstract",
    summary: "abstract",
    tldr: "abstract",
    info: "info",
    todo: "todo",
    tip: "tip",
    hint: "tip",
    important: "tip",
    success: "success",
    check: "success",
    done: "success",
    question: "question",
    help: "question",
    faq: "question",
    warning: "warning",
    caution: "warning",
    attention: "warning",
    failure: "failure",
    fail: "failure",
    missing: "failure",
    danger: "danger",
    error: "danger",
    bug: "bug",
    example: "example",
    quote: "quote",
    cite: "quote",
  } satisfies Record<string, CalloutType>),
);

/**
 * `--cm-lp-callout-color` の RGB（空白区切り）と、タイトルの前に出すアイコンの文字。
 * 色は `rgb()` の中に入れるので、`#rrggbb` でなく空白区切りの成分で持つ。
 *
 * 色は明暗の組で持つ。タイトルの文字にも使うので、明るい側は白いエディタ面、暗い側は暗いエディタ面に対して
 * 4.5:1 以上にしてある（`theme.test.ts` が測る）。Obsidian の配色はライトだけを前提にしていて暗い地では
 * 読めないので、色相だけを借りて濃さを両側で取り直した。
 */
const APPEARANCE: Readonly<
  Record<CalloutType, { readonly light: string; readonly dark: string; readonly icon: string }>
> = {
  note: { light: "8 109 221", dark: "138 180 255", icon: "✎" },
  abstract: { light: "15 118 110", dark: "94 212 207", icon: "≡" },
  info: { light: "8 109 221", dark: "138 180 255", icon: "i" },
  todo: { light: "8 109 221", dark: "138 180 255", icon: "☐" },
  tip: { light: "15 118 110", dark: "94 212 207", icon: "✦" },
  success: { light: "21 128 61", dark: "111 208 138", icon: "✓" },
  question: { light: "180 83 9", dark: "240 184 74", icon: "?" },
  warning: { light: "180 83 9", dark: "240 184 74", icon: "!" },
  failure: { light: "179 38 30", dark: "255 143 135", icon: "✕" },
  danger: { light: "179 38 30", dark: "255 143 135", icon: "ϟ" },
  bug: { light: "179 38 30", dark: "255 143 135", icon: "✱" },
  example: { light: "120 82 238", dark: "179 157 255", icon: "☰" },
  quote: { light: "95 99 104", dark: "168 166 179", icon: "❝" },
};

/** タイプごとの色とアイコン。live preview の theme に混ぜる */
export const calloutTypeStyles: Readonly<Record<string, Record<string, string>>> =
  Object.fromEntries(
    Object.entries(APPEARANCE).map(([type, { light, dark, icon }]) => [
      `.cm-lp-callout[data-callout="${type}"]`,
      { "--cm-lp-callout-color": byScheme(light, dark), "--cm-lp-callout-icon": `"${icon}"` },
    ]),
  );

/** test が明暗ごとの期待値を組み立てるのに使う */
export const calloutAppearance = APPEARANCE;

/** 識別子は大文字小文字を区別しない。未知の識別子は `note` として描く（Obsidian と同じ） */
export function resolveCalloutType(identifier: string): CalloutType {
  return TYPE_BY_IDENTIFIER.get(identifier.toLowerCase()) ?? "note";
}

export interface CalloutHeader {
  readonly type: CalloutType;
  /** 書かれたままの識別子。エイリアスや未知のタイプでも、既定のタイトルはこれから作る */
  readonly identifier: string;
  readonly fold: "+" | "-" | null;
  /** タイトルの先頭。タイトルが無ければ行末 */
  readonly titleFrom: number;
  readonly hasTitle: boolean;
}

// 識別子の後に `+`/`-`、その後は空白か行末でなければ callout としない。
// `[!note]です` のように続けて書いた行を callout に読み替えると、Obsidian で引用として
// 書いたつもりの本文の見た目が変わるため、判定の広い側に倒さない。
const HEADER = /^\[!([^\]]+)\]([+-]?)(?=[ \t]|$)[ \t]*/;

/** `text` は `>` の直後の段落の先頭から行末まで。`offset` はその先頭の文書上の位置 */
export function parseCalloutHeader(text: string, offset: number): CalloutHeader | null {
  const match = HEADER.exec(text);
  const identifier = match?.[1];
  if (!match || !identifier) return null;
  const fold = match[2] === "+" || match[2] === "-" ? match[2] : null;
  return {
    type: resolveCalloutType(identifier),
    identifier,
    fold,
    titleFrom: offset + match[0].length,
    hasTitle: match[0].length < text.length,
  };
}

/** Obsidian は識別子を title case にしたものを既定のタイトルにする */
export function defaultCalloutTitle(identifier: string): string {
  return identifier.charAt(0).toUpperCase() + identifier.slice(1).toLowerCase();
}

export interface Callout {
  readonly header: CalloutHeader;
  /** callout の `>`（その引用自身の最初の QuoteMark）。開閉状態の鍵にもなる */
  readonly markFrom: number;
  readonly headerLine: Line;
}

/**
 * `Blockquote` の node が callout ならその見出しを返す。
 *
 * 見出しになれるのは、引用の最初の `>` と同じ行から始まる段落の先頭の `[!type]` だけ。
 * `> - [!note]`（リスト）や `>` の次の行の `[!note]` は Obsidian でも callout にならない。
 * `[!note]` は構文木上は shortcut reference の `Link` になるので、node でなく行の文字で判定する。
 */
export function calloutOf(state: EditorState, node: SyntaxNodeRef): Callout | null {
  const mark = node.node.firstChild;
  if (mark?.name !== "QuoteMark") return null;
  const content: SyntaxNode | null = mark.nextSibling;
  if (content?.name !== "Paragraph") return null;
  const headerLine = state.doc.lineAt(mark.from);
  if (content.from > headerLine.to) return null;
  const header = parseCalloutHeader(
    state.doc.sliceString(content.from, headerLine.to),
    content.from,
  );
  return header ? { header, markFrom: mark.from, headerLine } : null;
}

class FoldOverride extends RangeValue {
  constructor(readonly collapsed: boolean) {
    super();
  }

  override eq(other: RangeValue): boolean {
    return other instanceof FoldOverride && other.collapsed === this.collapsed;
  }
}

const collapsedOverride = new FoldOverride(true);
const expandedOverride = new FoldOverride(false);

/**
 * `at` の `>` に続く見出しのタイプと `+`/`-`。見出しでなければ null。
 * 上書きを残すかの比較にだけ使う。構文木を見ないので、段落の中の `[!type]` のような
 * callout にならない行も見出しとして読むが、比較の両側で同じように読むので結果は変わらない。
 */
function foldingOf(doc: Text, at: number): string | null {
  if (doc.sliceString(at, at + 1) !== ">") return null;
  const text = doc.sliceString(at + 1, doc.lineAt(at).to).replace(/^[ \t]*/, "");
  const header = parseCalloutHeader(text, 0);
  return header ? `${header.type}${header.fold ?? ""}` : null;
}

const setCalloutFold = StateEffect.define<{ readonly at: number; readonly collapsed: boolean }>({
  map: (value, mapping) => ({ at: mapping.mapPos(value.at), collapsed: value.collapsed }),
});

/**
 * 開閉ボタンで切り替えた状態。callout の `>` の位置をキーに、記法の `+`/`-` より優先する。
 *
 * 文書には書き戻さない。Obsidian も開閉で本文を書き換えず、書き戻すと読むための操作が
 * 本文の変更と revision を生む。view ごとの一時的な状態なので、undo にも載せない。
 */
export const calloutFolds = StateField.define<RangeSet<FoldOverride>>({
  create: () => RangeSet.empty,
  update(folds, tr) {
    let next = folds;
    if (tr.docChanged) {
      // 見出しの `+`/`-` かタイプが変わったときだけ上書きを捨てる。`-` を `+` に書き換えても
      // クリックで決めた状態が残ると、記法と見た目が食い違う。タイトルだけの書き換えでは残す。
      // タイトルを直すたびに、読んでいる人の開閉が記法の状態へ戻らないように。
      const { changes } = tr;
      const before = tr.startState.doc;
      const after = tr.newDoc;
      next = next
        .update({
          filter: (from) => {
            const line = before.lineAt(from);
            if (!changes.touchesRange(line.from, line.to)) return true;
            const to = changes.mapPos(from, 1, MapMode.TrackDel);
            return to !== null && foldingOf(before, from) === foldingOf(after, to);
          },
        })
        .map(changes);
    }
    for (const effect of tr.effects) {
      if (!effect.is(setCalloutFold)) continue;
      const { at, collapsed } = effect.value;
      next = next.update({
        filter: (from) => from !== at,
        filterFrom: at,
        filterTo: at,
        add: [(collapsed ? collapsedOverride : expandedOverride).range(at)],
      });
    }
    return next;
  },
});

/** 開閉ボタンの上書きを反映した、記法上の開閉状態（カーソルによる一時的な展開は含まない） */
export function isCalloutCollapsed(state: EditorState, callout: Callout): boolean {
  let collapsed = callout.header.fold === "-";
  state.field(calloutFolds, false)?.between(callout.markFrom, callout.markFrom, (from, _to, v) => {
    if (from === callout.markFrom) collapsed = v.collapsed;
  });
  return collapsed;
}

/** `line` を見出しに持つ callout のうち最も内側のもの。入れ子の callout は同じ行に `>` を重ねる */
function calloutOnLine(state: EditorState, line: Line): (Callout & { to: number }) | null {
  let found: (Callout & { to: number }) | null = null;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (node.name !== "Blockquote") return true;
      const callout = calloutOf(state, node);
      if (callout && callout.headerLine.from === line.from) found = { ...callout, to: node.to };
      return true;
    },
  });
  return found;
}

function toggleFold(view: EditorView, dom: HTMLElement, collapse: boolean): void {
  // クリックは通常 composition を確定させてから届くが、確定文字列を読み込む前に
  // dispatch すると確定文字列が消えるので、その間は何もしない（IME 不変条件 1）。
  if (isCompositionUnsettled(view)) return;
  const { state } = view;
  const line = state.doc.lineAt(view.posAtDOM(dom));
  const callout = calloutOnLine(state, line);
  if (!callout) return;
  const effects = setCalloutFold.of({ at: callout.markFrom, collapsed: collapse });
  // 畳んだ本文にカーソルを残すと、見えない行へ入力することになる。見出し行の末尾へ逃がす。
  const bodyFrom = line.to + 1;
  const inBody =
    collapse &&
    state.selection.ranges.some((range) => range.to >= bodyFrom && range.from <= callout.to);
  view.dispatch(inBody ? { effects, selection: { anchor: line.to } } : { effects });
}

/** `>`、`[!type]`、`+`/`-` を置き換えるアイコンと、タイトル省略時の既定のタイトル */
export class CalloutTitleWidget extends WidgetType {
  constructor(readonly defaultTitle: string | null) {
    super();
  }

  override eq(other: CalloutTitleWidget): boolean {
    return other.defaultTitle === this.defaultTitle;
  }

  override toDOM(): HTMLElement {
    const title = document.createElement("span");
    title.className = "cm-lp-callout-marker";
    // アイコンは CSS の疑似要素で描く。文字として置くと、行のテキストに記法でない文字が混ざる
    const icon = document.createElement("span");
    icon.className = "cm-lp-callout-icon";
    icon.setAttribute("aria-hidden", "true");
    title.append(icon);
    if (this.defaultTitle !== null) title.append(this.defaultTitle);
    return title;
  }

  // 既定の true だとクリックを editor が無視し、見出し行にカーソルを置いて source を出せない。
  override ignoreEvent(): boolean {
    return false;
  }
}

/** 見出し行の末尾に置く開閉ボタン。`collapsed` は見た目の状態（カーソルによる展開を含む） */
export class CalloutFoldWidget extends WidgetType {
  constructor(readonly collapsed: boolean) {
    super();
  }

  override eq(other: CalloutFoldWidget): boolean {
    return other.collapsed === this.collapsed;
  }

  override toDOM(view: EditorView): HTMLElement {
    const button = document.createElement("span");
    button.className = "cm-lp-callout-fold";
    button.setAttribute("role", "button");
    button.setAttribute("aria-expanded", String(!this.collapsed));
    button.setAttribute("aria-label", this.collapsed ? "展開する" : "折りたたむ");
    // mousedown で処理する。click まで待つと editor がカーソルを見出し行へ動かし、source が出る。
    button.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      toggleFold(view, button, !this.collapsed);
    });
    return button;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}
