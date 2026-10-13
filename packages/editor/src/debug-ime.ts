import { completionStatus } from "@codemirror/autocomplete";
import { type Extension, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isInvalidateDecorationsTransaction } from "./decoration-plugin";
import { type ImeEvent, imeEventSink, imeViewLabel, reportImeEvent } from "./ime";

/**
 * composition の開始・更新・終了と transaction の発火を観測する。
 * decoration の再構築・スキップは `decoration-plugin` が同じ sink へ報告する。
 *
 * `viewLabel` は `ImeEvent.view` に載る値。title 欄と本文は 1 つの debug タイムラインを
 * 共有するため、呼び出し側（`create-editor`/`title-editor`）が自分の役割を示す文字列を渡す。
 */
export function imeDebug(onEvent: (event: ImeEvent) => void, viewLabel: string): Extension {
  return [
    imeEventSink.of(onEvent),
    imeViewLabel.of(viewLabel),
    EditorView.domEventHandlers({
      compositionstart(event, view) {
        reportImeEvent(view, "compositionstart", event.data);
        return false;
      },
      compositionupdate(event, view) {
        reportImeEvent(view, "compositionupdate", event.data);
        return false;
      },
      compositionend(event, view) {
        reportImeEvent(view, "compositionend", event.data);
        return false;
      },
    }),
    EditorView.updateListener.of((update) => {
      for (const tr of update.transactions) {
        const userEvent = tr.annotation(Transaction.userEvent);
        const detail =
          userEvent ??
          (tr.docChanged
            ? "doc"
            : tr.selection
              ? "selection"
              : isInvalidateDecorationsTransaction(tr)
                ? "invalidate-decorations"
                : completionStatus(tr.startState) !== null && completionStatus(tr.state) === null
                  ? "completion"
                  : "effect");
        reportImeEvent(update.view, "transaction", detail);
      }
    }),
  ];
}
