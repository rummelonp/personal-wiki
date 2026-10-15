import { Facet, StateEffect } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";

/*
 * IME 不変条件。packages/editor のコメント（「IME 不変条件 N」）とテスト名（「IME invariant N」）が
 * 番号で参照する。
 *
 * 変換中（composition 中）のブラウザは、確定前の文字列を contenteditable の DOM に直接書き、
 * CodeMirror はその DOM を変換の終わりに読み取って doc へ入れる。変換中に editor 側が DOM や
 * doc を書き換えるとブラウザの変換状態とずれ、確定した文字が消える、二重に入る、変換候補が
 * 閉じる、カーソルが飛ぶ、といった壊れ方をする。再現が IME、OS、ブラウザの組み合わせに
 * 依存して後から追いにくいので、次の 4 つは例外なく守る。
 *
 * 1. 変換中は decoration を組み直さず、editor の外から dispatch しない。組み直しと保留した
 *    dispatch は `compositionSettled` の後に 1 回だけ行う。`compositionend` の直後も確定文字列が
 *    doc に入るまでは `isCompositionUnsettled` で待つ。
 * 2. selection に触れる範囲（両端を含む）を `Decoration.replace` で隠さない。replace の中や
 *    境界にカーソルがあると、IME が確定前の文字列を置く場所を DOM に見つけられない。
 *    判定は `reveal.ts` の `shouldRevealSource` に集める。
 * 3. 変換中の Enter、Tab、Shift+Enter を keymap が取らない。これらは IME 自身の確定や操作に
 *    使われる。handler は `isComposing` なら false を返す。
 * 4. 変換中の入力で autocomplete を開かない。候補 UI の開閉は tooltip の DOM 追加と dispatch を
 *    伴い、1 を破る。落ち着いた後に開き直す。
 *
 * 単体テストは本物の IME を動かせず、`CompositionEvent` や `input.type.compose` の transaction で
 * 状態の遷移を模すだけである。`ime-cdp.test.ts` は CDP で実際の変換に近い入力を流し、1 と 4 を
 * 確かめる。3 については、変換中の keydown を CodeMirror が keymap より前に捨てる挙動を見張るだけで、
 * handler の guard は単体テストが合成の compositionstart で確かめる。CDP の変換も Chromium のものに
 * 限られ、compositionstart と最初の変更が同じ task で届くので、その間に keydown が来る場合や、
 * Safari の compositionend と Enter の keydown の逆転は再現できない。
 */

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

const settleMeasureKey = Symbol("compositionSettled");

/**
 * `compositionend` の後、確定分の DOM 変更を CodeMirror が読み終えてから `compositionSettled` を
 * 1 回 dispatch する。連続入力で次の composition がすでに始まっていれば何もしない（その composition の
 * 終了時に送る）。
 *
 * 確定分を読む時期はブラウザで違う。iOS Safari は確定の間際に文字列をいったん消して入れ直すので、
 * CodeMirror はその DOM 変更を次の frame まで読まない。setTimeout はその frame より先に来ることがあり、
 * そこで dispatch すると、未読の DOM 変更と確定後の選択が捨てられ、古い選択（確定前の文字列全体）が
 * DOM に書き戻される。続けて打つと、その選択ごと確定文字列が置き換わる。
 * そこで measure の後ろへ回す。@codemirror/view の measure は、frame から走るときは read の前に
 * 保留中の DOM 変更を読む。measure の中では dispatch できないので、dispatch は microtask へ送る。
 * microtask は write ではなく read の中で頼む。read の後の更新が例外で抜けると write は呼ばれず、
 * request も measure から外れる。write で頼むと settle が来ず、次の `compositionend` まで `settling`
 * が残る。microtask は measure 全体が（例外で抜ける場合も）終わってから走るので、read で頼んでも
 * dispatch の時期は変わらない。
 * ただし、frame の前に `posAtCoords` などの読み取りが measure を同期に走らせると、その measure は
 * DOM 変更を読まないので、settle が遅れた flush より先に走りうる。
 *
 * ページが非表示の間は frame が止まるので、settle も保留した外からの dispatch も表示に戻るまで待つ。
 * 非表示の間だけ frame を待たずに settle する逃げ道は作らない。iOS の遅れた flush も frame 待ちで、
 * その前に settle すると同じように未読の DOM 変更を捨てうる。
 * そのため、settle を待つ処理（web の `whenSettled`）の後ろに並んだ保存も、表示に戻るまで送られない。
 */
export const compositionSettledNotifier = ViewPlugin.fromClass(
  class {
    private destroyed = false;

    constructor(private readonly view: EditorView) {}

    compositionEnded(): void {
      settling.add(this.view);
      this.view.requestMeasure({
        key: settleMeasureKey,
        read: () => {
          queueMicrotask(() => this.settle());
          return null;
        },
      });
    }

    private settle(): void {
      if (this.destroyed) return;
      // 次の composition の間は isComposing が保留を担う。ここで外しておかないと、その
      // composition の終わりが DOM の compositionend を伴わない場合（Safari）に残り続ける。
      settling.delete(this.view);
      if (isComposing(this.view)) return;
      this.view.dispatch({ effects: compositionSettled.of(null) });
    }

    destroy(): void {
      this.destroyed = true;
      settling.delete(this.view);
    }
  },
  {
    eventHandlers: {
      compositionend() {
        this.compositionEnded();
        return false;
      },
    },
  },
);

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
 * 読まれていないことがある（CodeMirror が microtask で読む。iOS Safari では次の frame まで遅れる）。
 * その前に dispatch すると、`EditorView.update` が未読の DOM 変更を読まずに片付けて描き直すので、
 * 確定文字列や確定後の選択が消える。読むまでの間には fetch の応答やタイマーのような別の task も
 * 入り込むので、`compositionend` の handler など同じ task からの呼び出しに限らず控える。
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
