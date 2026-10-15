import type { Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { isComposing } from "./ime";

/**
 * iOS Safari のかなキーボードで、変換を確定した直後に「改行」を押すと、keydown が keymap に
 * 届かない（keyCode 229 で届くか、composition 中として捨てられる）。CodeMirror は iOS の
 * keyCode 13 の keydown だけ保留して keymap へ流すので、この改行は保留されず、WebKit が
 * `insertLineBreak` で DOM に書いた内容をそのまま読む。WebKit は行末の改行を、pre-wrap の
 * ために空行を描く 2 つ目の `\n` ごと書くので、doc に改行が 2 つ入る。Chrome 向けの同種の補正
 * （keyCode 13 のときだけ 1 文字減らす）は iOS では働かない。
 *
 * この変更を Enter の 1 回分とみなして keymap に流すので、リストの行頭記号の継続も
 * キーボードの Enter と揃う。WebKit が 2 つ目の `\n` を足すのは行末だけなので、行の途中の
 * 改行は既定の挿入のまま。選択の置き換えと変換中は、Enter と同じ意味にならないので除く。
 * beforeinput で止める案は採らない。iOS で Enter を止めるとキーボードの大文字と小文字の
 * 状態が戻らなくなる（CodeMirror のコメントにある既知の挙動）。
 *
 * 貼り付けは CodeMirror の paste handler が直接 doc を書くので、この経路に来ない。
 */
export function lineBreakInput(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== "\n\n" || from !== to || isComposing(view)) return false;
    const { selection, doc } = view.state;
    if (selection.ranges.length !== 1) return false;
    const { head, empty } = selection.main;
    if (!empty || head !== from || doc.lineAt(head).to !== head) return false;
    return runScopeHandlers(
      view,
      new KeyboardEvent("keydown", { key: "Enter", cancelable: true }),
      "editor",
    );
  });
}
