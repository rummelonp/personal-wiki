import { Facet, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * composition が終わったことを知らせる空の transaction の目印。
 *
 * 確定文字列を入れる transaction は `compositionend` より前に届き、その時点ではまだ
 * `compositionStarted` が true なので decoration の再構築は見送られる。確定後に
 * ユーザーが何もしなければ次の update が来ず、隠すべき記法が出たまま残ってしまう。
 */
export const compositionSettled = StateEffect.define<null>();

/** `compositionend` を受けてから、`compositionSettled` を dispatch するまでの view */
const settling = new WeakSet<EditorView>();

/**
 * `compositionend` の後に `compositionSettled` を 1 回 dispatch する。
 * CodeMirror は確定分の DOM 変更を microtask で flush するので、setTimeout でその後ろへ回す。
 * 連続入力で次の composition がすでに始まっていれば何もしない（その composition の終了時に送る）。
 */
export const compositionSettledNotifier = EditorView.domEventHandlers({
  compositionend(_event, view) {
    settling.add(view);
    setTimeout(() => {
      // 次の composition の間は isComposing が保留を担う。ここで外しておかないと、その
      // composition の終わりが DOM の compositionend を伴わない場合（Safari）に残り続ける。
      settling.delete(view);
      if (isComposing(view)) return;
      view.dispatch({ effects: compositionSettled.of(null) });
    }, 0);
    return false;
  },
});

export type ImeEventKind =
  | "compositionstart"
  | "compositionupdate"
  | "compositionend"
  | "transaction"
  | "decoration-rebuild"
  | "decoration-skipped"
  /** `invalidateDecorations` を composition の後へ持ち越した */
  | "decoration-invalidation-held";

export interface ImeEvent {
  /** `performance.now()` の値 */
  readonly at: number;
  readonly kind: ImeEventKind;
  readonly composing: boolean;
  readonly detail?: string;
  /** どの view の発火か（`imeDebug` の呼び出し側が付ける）。title 欄と本文は 1 つの debug
   * タイムラインを共有するので、これが無いと片方の composition 中に起きたもう片方の
   * （正当な）decoration 再構築を、同じ composition への違反と誤認しうる。 */
  readonly view: string;
}

/**
 * IME の観測点。debug 用パネルがここに関数を登録する。
 * 登録が無ければ `reportImeEvent` は何もしないので、本番構成でも extension を外す必要がない。
 */
export const imeEventSink = Facet.define<(event: ImeEvent) => void>();

/** `reportImeEvent` が `ImeEvent.view` に詰める値。`imeDebug` の呼び出し側が登録する。 */
export const imeViewLabel = Facet.define<string, string>({
  combine: (values) => values[0] ?? "unknown",
});

/**
 * composition 中かどうか。decoration を再構築してよいかの判定はすべてこれを通す。
 *
 * `view.composing` は composition 開始後に最初の変更が入って初めて true になる。
 * decoration の再構築を止めるのはその 1 手前（`compositionstart` の直後）でなければ
 * 間に合わないので、`compositionStarted` も見る。
 */
export function isComposing(view: EditorView): boolean {
  return view.compositionStarted || view.composing;
}

/**
 * composition が始まってから、`compositionSettled` を dispatch するまで。Editor の外から
 * 来る dispatch はこの間ずっと控える。
 *
 * `compositionend` の直後は `isComposing` が false に戻るが、確定文字列の DOM 変更はまだ
 * 読まれていない（CodeMirror が microtask で読む）。その前に dispatch すると、
 * `EditorView.update` が未読の DOM 変更を読まずに片付けて描き直すので、確定文字列が消える。
 * fetch の応答のような別の task からの呼び出しはこの間に入り込めないが、`compositionend` の
 * handler など同じ task から同期に呼ばれる場合に備える。
 */
export function isCompositionUnsettled(view: EditorView): boolean {
  return isComposing(view) || settling.has(view);
}

export function reportImeEvent(view: EditorView, kind: ImeEventKind, detail?: string): void {
  const sinks = view.state.facet(imeEventSink);
  if (sinks.length === 0) return;
  // compositionend では CodeMirror 自身の observer が handler より先に composition の状態を
  // 落としているため、ここで読む composing は確定文字列を読み込む前でも false になる。
  // composition の区切りは kind の方を信じること。
  const event: ImeEvent = {
    at: performance.now(),
    kind,
    composing: isComposing(view),
    view: view.state.facet(imeViewLabel),
    ...(detail === undefined ? {} : { detail }),
  };
  for (const sink of sinks) sink(event);
}
