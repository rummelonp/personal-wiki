import { closeCompletion } from "@codemirror/autocomplete";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { isDocReplacement } from "./replace-doc";
import { dispatchWhenSettled } from "./settled-dispatch";

const readOnlyMode = new Compartment();

/**
 * `EditorState.readOnly` が拒むのは CodeMirror 自身の入力経路だけなので、changeFilter で
 * `state.readOnly` を見ずに doc を書く extension が後から増えても入力を通さない。
 * `replaceDoc`（ホストからの差し替え）だけは通す。`replaceDoc` と `setReadOnly` はどちらも変換が
 * 落ち着くまで保留され、最初に保留した順に実行されるので、readOnly に切り替えた後に差し替えが
 * 届くことがある。ここで差し替えを落とすと、ホストの本文と view の doc がずれたまま残る。
 */
const readOnlyOn: Extension = [
  EditorState.readOnly.of(true),
  EditorState.changeFilter.of((tr) => isDocReplacement(tr)),
];
const readOnlyOff: Extension = [];

/** `createEditor` が積む、`setReadOnly` で切り替えられる readOnly の指定 */
export function readOnlyCompartment(readOnly: boolean): Extension {
  return readOnlyMode.of(readOnly ? readOnlyOn : readOnlyOff);
}

const readOnlyKey = Symbol("setReadOnly");

/**
 * `createEditor` で作った view の readOnly を切り替える。権限の変化で view を作り直すと
 * 変換中の文字が消えるので、作り直さずにこれを使う。
 *
 * - 変換中と確定文字列を読み込むまでの間は切り替えず、落ち着いてから最後の指定だけを適用する
 *   （IME 不変条件 1）。そのため、変換中に readOnly にしても、落ち着くまでに確定した文字は doc に入る。
 *   ホストがその文字を受け取らないなら、続けて `replaceDoc` で自分の本文に戻す。
 * - readOnly にするときは、開いている `[[` の候補を閉じる。
 * - readOnly の間も `replaceDoc` は適用する。
 * - `readOnlyFocusable: false` で作った view の、focus できない状態は変えない。
 */
export function setReadOnly(view: EditorView, readOnly: boolean): void {
  if (readOnlyMode.get(view.state) === undefined) {
    throw new Error("setReadOnly は createEditor で作った view にだけ使える");
  }
  dispatchWhenSettled(view, readOnlyKey, () => {
    const target = readOnly ? readOnlyOn : readOnlyOff;
    if (readOnlyMode.get(view.state) === target) return;
    view.dispatch({ effects: readOnlyMode.reconfigure(target) });
    if (readOnly) closeCompletion(view);
  });
}
