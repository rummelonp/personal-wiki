import { Annotation, type EditorState, Transaction } from "@codemirror/state";
import { type EditorView, type PluginValue, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { compositionSettledNotifier, isCompositionUnsettled } from "./ime";

const docReplaced = Annotation.define<true>();

class DocReplacer implements PluginValue {
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly view: EditorView) {}

  request(text: string): void {
    if (isCompositionUnsettled(this.view)) {
      this.pending = text;
      return;
    }
    this.pending = null;
    apply(this.view, text);
  }

  update(update: ViewUpdate): void {
    if (this.pending === null || isCompositionUnsettled(update.view)) return;
    // update の最中は dispatch できないので、次の task へ回す。
    // 通常は `compositionSettled` の update がここに来る。Safari のように compositionend を
    // 伴わずに composition が終わった場合も、その後の最初の update で拾える。
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 0);
  }

  destroy(): void {
    clearTimeout(this.timer);
    this.pending = null;
  }

  private flush(): void {
    // timer を待つ間に次の composition が始まっていれば、その終わりの update まで持ち越す
    if (this.pending === null || isCompositionUnsettled(this.view)) return;
    const text = this.pending;
    this.pending = null;
    apply(this.view, text);
  }
}

const docReplacer = ViewPlugin.fromClass(DocReplacer);

/**
 * `replaceDoc` が使う extension。`createEditor` と `createTitleEditor` の view には最初から入っている。
 * それ以外の EditorView で `replaceDoc` を使うときだけ自分で足す。
 */
export const docReplacement = [docReplacer, compositionSettledNotifier];

/**
 * ホストが持つ最新の本文（サーバーから取り直した内容など）で view の doc を差し替える。
 * ホストが doc を書き換えるときは、`view.dispatch` を直接呼ばずにこれを通す。
 *
 * - IME の変換中と確定文字列を読み込むまでの間は適用せず、落ち着いてから 1 回だけ適用する。
 *   変換中に doc を書き換えると、確定前の文字列や確定した文字列が消えるためである。
 *   保留中に何度呼ばれても、最後に渡した `text` だけを適用する。
 * - 変わった範囲だけを書き換えるので、変わっていない部分の selection と装飾はそのまま残る。
 *   selection は変更に沿って写す。
 * - undo の履歴には積まない。ユーザーが undo しても、差し替える前の内容には戻らない。
 * - `readOnly` の view にも適用する（readOnly が止めるのはユーザーの入力だけ）。
 *
 * 保留している間にユーザーが入力した内容は、適用時に `text` で上書きされる。上書きしてよいかは
 * 呼び出し側が決める（未保存の編集がある間は呼ばない、など）。
 * title の view では改行を空白に直さないので、呼び出し側が正規化した title を渡す。
 */
export function replaceDoc(view: EditorView, text: string): void {
  const replacer = view.plugin(docReplacer);
  if (!replacer) {
    throw new Error("replaceDoc には docReplacement extension を入れた view が必要です");
  }
  replacer.request(text);
}

/** `replaceDoc` が出した transaction か。`onUpdate` で保存の対象から外すときに使う */
export function isDocReplacement(tr: Transaction): boolean {
  return tr.annotation(docReplaced) === true;
}

function apply(view: EditorView, text: string): void {
  const change = changedRange(view.state, text);
  if (!change) return;
  view.dispatch({
    changes: change,
    annotations: [Transaction.addToHistory.of(false), docReplaced.of(true)],
  });
}

/**
 * 今の doc と `text` の共通の先頭と末尾を除いた範囲。同じなら null。
 * `text` の改行は state の規則で揃えてから比べる（`\r\n` だけの違いを変更とみなさない）。
 */
export function changedRange(
  state: EditorState,
  text: string,
): { from: number; to: number; insert: string } | null {
  const current = state.doc.toString();
  const next = state.toText(text).toString();
  if (current === next) return null;
  const shorter = Math.min(current.length, next.length);
  let start = 0;
  while (start < shorter && current.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < shorter - start &&
    current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
  ) {
    end++;
  }
  // サロゲートペアの途中で切ると、変更の境界に半端な code unit が残る
  if (start > 0 && isHighSurrogate(current.charCodeAt(start - 1))) start--;
  if (end > 0 && isLowSurrogate(current.charCodeAt(current.length - end))) end--;
  return {
    from: start,
    to: current.length - end,
    insert: next.slice(start, next.length - end),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
