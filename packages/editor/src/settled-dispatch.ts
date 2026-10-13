import { type EditorView, type PluginValue, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { compositionSettledNotifier, isCompositionUnsettled } from "./ime";

class SettledDispatcher implements PluginValue {
  private readonly pending = new Map<unknown, () => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly view: EditorView) {}

  run(key: unknown, action: () => void): void {
    if (isCompositionUnsettled(this.view)) {
      this.pending.set(key, action);
      return;
    }
    this.pending.delete(key);
    action();
  }

  update(update: ViewUpdate): void {
    if (this.pending.size === 0 || isCompositionUnsettled(update.view)) return;
    // update の最中は dispatch できないので、次の task へ回す。
    // 通常は `compositionSettled` の update がここに来る。Safari のように compositionend を
    // 伴わずに composition が終わった場合も、その後の最初の update で拾える。
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 0);
  }

  destroy(): void {
    clearTimeout(this.timer);
    this.pending.clear();
  }

  private flush(): void {
    // 1 つずつ取り出して実行する。先に全部を写し取ると、実行中の action が同じ key で
    // `run` し直した（新しい内容で即時に実行した）後に、写し取った古い action が上書きしてしまう。
    // timer を待つ間に次の composition が始まっていれば、その終わりの update まで持ち越す。
    while (this.pending.size > 0 && !isCompositionUnsettled(this.view)) {
      const [key, action] = this.pending.entries().next().value as [unknown, () => void];
      this.pending.delete(key);
      action();
    }
  }
}

const settledDispatcher = ViewPlugin.fromClass(SettledDispatcher);

/**
 * `dispatchWhenSettled` が使う extension。`createEditor` と `createTitleEditor` の view には
 * 最初から入っている（`docReplacement` に含まれる）。
 */
export const settledDispatch = [settledDispatcher, compositionSettledNotifier];

/**
 * editor の外から view を dispatch する処理を、IME の変換が落ち着いてから実行する（IME 不変条件 1）。
 * 落ち着いていれば、その場で同期に実行する。
 *
 * 変換中と確定文字列を読み込むまでの間に呼ばれた `action` は、`key` ごとに最後の 1 つだけを覚え、
 * 落ち着いた後の最初の update から次の task で 1 回だけ実行する。実行の順は、その `key` が
 * 最初に保留された順である。view を破棄すると、保留していた `action` は捨てる。
 *
 * `key` は値の同一性で比べる。他の呼び出し元と衝突しないよう、モジュールごとの定数
 * （`Symbol` など）を渡す。
 */
export function dispatchWhenSettled(view: EditorView, key: unknown, action: () => void): void {
  const dispatcher = view.plugin(settledDispatcher);
  if (!dispatcher) {
    throw new Error("dispatchWhenSettled には settledDispatch extension を入れた view が必要です");
  }
  dispatcher.run(key, action);
}
