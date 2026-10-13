import {
  copyLineDown,
  copyLineUp,
  defaultKeymap,
  historyKeymap,
  insertBlankLine,
  insertNewlineAndIndent,
  splitLine,
} from "@codemirror/commands";
import { EditorSelection, EditorState, type Extension, Prec, Transaction } from "@codemirror/state";
import { type Command, drawSelection, EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { imeDebug } from "./debug-ime";
import { focusRing } from "./focus";
import { type ImeEvent, isComposing } from "./ime";
import { docReplacement, resettableHistory } from "./replace-doc";
import { editorSurfaceTheme } from "./theme";

export interface CreateTitleEditorOptions {
  /** 最初の title。作った後に外から差し替えるときは `replaceDoc` を使う */
  readonly doc?: string;
  /** Enter と ↓ で移る先の本文の view */
  readonly bodyView?: () => EditorView | null;
  readonly readOnly?: boolean;
  /** 渡したときだけ IME の観測を有効にする */
  readonly onImeEvent?: (event: ImeEvent) => void;
  /** 基本構成の後段に足す extension */
  readonly extensions?: Extension;
  readonly onUpdate?: (update: ViewUpdate) => void;
  /**
   * Enter で title を打ち終えたとみなしたとき、本文へ移る前に呼ぶ。
   * 本文を 1 文字も書かずに title だけ打った人にも page を作らせるための合図で、
   * 変換の確定に使われた Enter では呼ばない。
   */
  readonly onCommit?: () => void;
}

/**
 * この view への入力（貼り付け、drop、改行を入れる command）に含まれる改行を空白に置き換える。
 * userEvent を持たない transaction は書き換えない。ホストからの差し替え（`replaceDoc`）は
 * ホストが正規化した title を渡す取り決めで、ここで書き換えると保存済みの title と doc が食い違う。
 * composition の transaction も書き換えない。変換中に doc を書き換えると確定前の文字列が壊れる。
 */
const newlinesToSpaces = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent("input") || tr.isUserEvent("input.type.compose")) {
    return tr;
  }
  let multiline = false;
  tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (inserted.lines > 1) multiline = true;
  });
  if (!multiline) return tr;

  const changes: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    changes.push({ from, to, insert: inserted.sliceString(0, inserted.length, " ") });
  });
  return {
    changes,
    // 改行も空白も 1 文字なので、変更後の selection はそのまま使える
    selection: tr.newSelection,
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    userEvent: tr.annotation(Transaction.userEvent) ?? "input",
  };
});

const TITLE_LABEL = "タイトル";
/** 空の欄に出す誘い。ラベル（`TITLE_LABEL`）と別にするのは、欄の名前ではなく「ここに打て」を伝えるため */
const TITLE_PLACEHOLDER = "タイトルを入力";

/**
 * 空の title 欄の placeholder の目印。CodeMirror の `placeholder()` は、空かどうかで widget の
 * decoration を張り外しする。空の欄で変換を始めると、最初の compose の transaction で
 * 未確定文字列の隣の widget が contentDOM から外れる（IME 不変条件 1）。
 * ここでは contentDOM の外にある `view.dom` の class だけを切り替え、文字は行の `::before` に
 * 描くので、composition 中でも contentDOM の node は変わらない。
 * 書けない欄には出さない。今は editable が変わるとホストが view を作り直すが、option ではなく
 * state の facet から判定するので、Compartment で切り替えるようにしても追従する
 * （attributes は update ごとに取り直される）。
 */
const emptyTitleClass = EditorView.editorAttributes.of((view) =>
  view.state.doc.length === 0 && view.state.facet(EditorView.editable)
    ? { class: "cm-title-empty" }
    : null,
);

/** 疑似要素の文字は a11y ツリーに出さないので、支援技術には placeholder を属性で伝える */
const titlePlaceholderAttribute = EditorView.contentAttributes.of((view) =>
  view.state.facet(EditorView.editable) ? { "aria-placeholder": TITLE_PLACEHOLDER } : null,
);

/**
 * 本文の見出しより一段大きく見せ、本文の view と余白を揃えて 1 枚の文書に見せる。
 * 28px 固定で、本文の見出しの頂点（`.cm-lp-h1` の 1.5em = 24px、theme.ts）より確実に大きい値にして、
 * title が見出しより上位に見える階層を保つ。
 *
 * `em` にせず px にしているのは、本文（`theme.ts` の `typographyTheme`）と同じ理由に加えて、
 * title の view には `typographyTheme` を入れていないため。`em` だと基準が本文の固定 16px ではなく
 * ホストの root の font-size になり、ホストが 16px 未満だと title が見出しの頂点を割り込みうる
 * （`typography.test.ts` が守る階層）。
 *
 * `.cm-scroller` に書体を当て直すのは、CodeMirror の既定（`font-family: monospace`）が
 * `.cm-scroller` に直書きされていて `&` からの継承では上書きできないため（theme.ts の
 * `typographyTheme` と同じ理由）。大きさと太さは継承で足りるので `&` のままにしてある。
 */
const titleTheme = EditorView.theme({
  "&": { fontSize: "28px", fontWeight: "700" },
  ".cm-scroller": { fontFamily: "var(--ui-font-heading)" },
  // 絶対配置で行の中に場所を取らせないので、出入りしても caret と本文の位置は動かない
  "&.cm-title-empty .cm-line::before": {
    // 空の alt text を付け、読み上げで title の本文として読まれないようにする。alt text の構文を
    // 解さないブラウザ（Firefox 128 未満、Safari 17.4 未満）は後の宣言だけを捨てて前の宣言を使う。
    // `@supports` で分けないのは、theme の中の @ ブロックでは `&` を view の scope に展開できないから。
    // style-mod は `_` 以降を捨てるので、2 つとも `content` として出力される
    content: `"${TITLE_PLACEHOLDER}"`,
    content_alt: `"${TITLE_PLACEHOLDER}" / ""`,
    position: "absolute",
    color: "var(--ui-color-muted)",
    pointerEvents: "none",
  },
});

function titleKeymap(
  bodyView: (() => EditorView | null) | undefined,
  onCommit: (() => void) | undefined,
): Extension {
  const moveToBody = (place: (body: EditorView) => number): boolean => {
    const body = bodyView?.();
    if (!body) return false;
    body.focus();
    body.dispatch({
      selection: EditorSelection.cursor(place(body)),
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  };
  // 本文が無くても Enter は改行を入れない。composition 中の Enter は変換の確定なので IME に渡す
  const enter: Command = (view) => {
    if (isComposing(view)) return false;
    // 本文へ移る前に呼ぶ。移った先の focus が先に動くと、onCommit が起こす描画の更新が
    // 本文の focus を奪い返しうる
    onCommit?.();
    moveToBody((body) => body.state.doc.line(1).to);
    return true;
  };
  // 折り返した title の中では行を移る。本文へ移るのは最後の表示行からだけ
  const down: Command = (view) => {
    if (isComposing(view)) return false;
    const lineEnd = view.moveToLineBoundary(view.state.selection.main, true, true).head;
    return lineEnd === view.state.doc.length && moveToBody(() => 0);
  };
  return Prec.high(
    keymap.of([
      { key: "Enter", run: enter, shift: enter },
      { key: "Mod-Enter", run: enter },
      { key: "ArrowDown", run: down },
    ]),
  );
}

/**
 * 行を足す command。title 欄では newlinesToSpaces を通って、空白の挿入や title の複製になる。
 * Enter と Mod-Enter は titleKeymap が先に取るが、修飾キーの組み合わせで漏れないよう一緒に外す。
 */
const lineCommands = new Set<unknown>([
  insertNewlineAndIndent,
  insertBlankLine,
  splitLine,
  copyLineUp,
  copyLineDown,
]);
const titleDefaultKeymap = defaultKeymap.filter((binding) => !lineCommands.has(binding.run));

/**
 * page の title を編集する単一行の EditorView を作る。title は本文と別の field なので、
 * 本文の view とは別の view にする。
 * 本文から矢印キーで戻る経路は持たない（クリックか Shift+Tab で移る）。
 */
export function createTitleEditor(
  parent: HTMLElement,
  options: CreateTitleEditorOptions = {},
): EditorView {
  const extensions: Extension[] = [
    newlinesToSpaces,
    titleKeymap(options.bodyView, options.onCommit),
    resettableHistory(),
    keymap.of([...titleDefaultKeymap, ...historyKeymap]),
    drawSelection(),
    EditorView.lineWrapping,
    editorSurfaceTheme,
    // カーソル行の地（`activeLine`）は入れない。1 行しか無いので欄全体が塗られ、
    // 本文との境目が「選択されている」ように見える
    focusRing(),
    titleTheme,
    EditorView.editorAttributes.of({ class: "cm-title-editor" }),
    emptyTitleClass,
    EditorView.contentAttributes.of({ "aria-label": TITLE_LABEL, "aria-multiline": "false" }),
    titlePlaceholderAttribute,
    docReplacement,
  ];
  if (options.onImeEvent) extensions.push(imeDebug(options.onImeEvent, "title"));
  if (options.readOnly) {
    extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
  }
  if (options.extensions) extensions.push(options.extensions);
  if (options.onUpdate) extensions.push(EditorView.updateListener.of(options.onUpdate));

  return new EditorView({
    parent,
    state: EditorState.create({ doc: options.doc ?? "", extensions }),
  });
}
