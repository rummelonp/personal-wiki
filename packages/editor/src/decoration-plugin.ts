import { syntaxTree } from "@codemirror/language";
import { type Extension, StateEffect, type Transaction } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  compositionSettledNotifier,
  isComposing,
  isCompositionUnsettled,
  reportImeEvent,
} from "./ime";

/**
 * 再構築を促すためだけの effect。export しない。Editor の外から直接 dispatch されると、
 * composition 中の保留（`invalidateDecorations`）を素通りする。
 */
const invalidated = StateEffect.define<null>();

/** view ごとの invalidate の累計。各 plugin は前回組んだ時点の値と比べ、増えていれば組み直す */
const invalidations = new WeakMap<EditorView, number>();

/**
 * decoration の builder が、CodeMirror の state/transaction を経由しない外部データ
 * （React ref 経由で非同期に更新される page title 一覧など）に依存する場合に、
 * その変化を伝えて再構築させる。builder 自身が何に依存しているかを
 * `ComposeSafeDecorations` は知らないため、呼び出し側が明示的に呼ぶ。
 *
 * composition 中は dispatch しない（IME 不変条件 1）。要求だけを覚え、composition の終了を
 * 知らせる `compositionSettled` の update で 1 回だけ組み直す。その間に何度呼ばれても 1 回になる。
 */
export function invalidateDecorations(view: EditorView): void {
  invalidations.set(view, (invalidations.get(view) ?? 0) + 1);
  if (isCompositionUnsettled(view)) {
    reportImeEvent(view, "decoration-invalidation-held");
    return;
  }
  view.dispatch({ effects: invalidated.of(null) });
}

/** debug タイムラインで、`invalidateDecorations` の transaction を見分けるために使う */
export function isInvalidateDecorationsTransaction(tr: Transaction): boolean {
  return tr.effects.some((effect) => effect.is(invalidated));
}

export interface BuiltDecorations {
  readonly decorations: DecorationSet;
  /** カーソル移動が飛び越えるべき範囲。隠した記法だけを入れる。 */
  readonly atomic?: DecorationSet;
}

/**
 * `view.visibleRanges` の外を走査してはいけない。全文走査の builder を書かないこと。
 *
 * `previous` は直前に組んだ decoration を今の doc の位置へ写したもの（初回は空）。直前に何を
 * 描いていたかで今回の描き方を決める builder（embed）が読む。
 */
export type DecorationBuilder = (view: EditorView, previous: DecorationSet) => BuiltDecorations;

export interface DecorationPluginOptions {
  /** debug タイムラインに出る名前 */
  readonly name: string;
  readonly build: DecorationBuilder;
  /**
   * doc・selection・viewport・focus・構文木の変化のほかに組み直す条件。builder が
   * StateField のような view 内の状態を読むときに渡す。composition 中はこれが true でも組み直さない。
   */
  readonly rebuildWhen?: (update: ViewUpdate) => boolean;
}

class ComposeSafeDecorations implements PluginValue {
  decorations: DecorationSet;
  atomic: DecorationSet;
  private stale = false;
  private invalidation: number;

  constructor(
    private readonly name: string,
    private readonly builder: DecorationBuilder,
    private readonly rebuildWhen: ((update: ViewUpdate) => boolean) | undefined,
    view: EditorView,
  ) {
    this.invalidation = invalidations.get(view) ?? 0;
    const built = builder(view, Decoration.none);
    this.decorations = built.decorations;
    this.atomic = built.atomic ?? Decoration.none;
  }

  update(update: ViewUpdate): void {
    if (isComposing(update.view)) {
      // IME 不変条件 1。composition 中の DOM は IME が握っているので、decoration を
      // 差し替えると CodeMirror がその範囲を描き直し、未確定文字の消失や
      // 変換候補ウィンドウの位置ずれを起こす。位置の写像だけ行い、再構築は composition
      // 終了後の最初の update に 1 回だけ持ち越す（stale フラグ）。
      if (update.docChanged) {
        this.decorations = this.decorations.map(update.changes);
        this.atomic = this.atomic.map(update.changes);
      }
      this.stale = true;
      reportImeEvent(update.view, "decoration-skipped", this.name);
      return;
    }
    // effect ではなく累計で見る。composition 中に保留した invalidate は effect を伴わず、
    // composition 後の最初の update（通常は `compositionSettled`）でここに届く。
    const invalidation = invalidations.get(update.view) ?? 0;
    if (
      !this.stale &&
      invalidation === this.invalidation &&
      !update.docChanged &&
      !update.selectionSet &&
      !update.viewportChanged &&
      !update.focusChanged &&
      // background parser が進んだだけの update も拾う。拾わないと、parse が viewport に
      // 届く前に組んだ（記法をまだ認識していない）decoration が次の操作まで残る。
      syntaxTree(update.startState) === syntaxTree(update.state) &&
      // builder は readOnly で描き分ける（task のチェックボックス、embed の編集ボタン）
      update.startState.readOnly === update.state.readOnly &&
      !this.rebuildWhen?.(update)
    ) {
      return;
    }
    this.stale = false;
    this.invalidation = invalidation;
    // composition 中の update は上で写し済みなので、写すのはこの update の変更だけでよい
    const previous = update.docChanged ? this.decorations.map(update.changes) : this.decorations;
    const built = this.builder(update.view, previous);
    this.decorations = built.decorations;
    this.atomic = built.atomic ?? Decoration.none;
    reportImeEvent(update.view, "decoration-rebuild", this.name);
  }
}

export function decorationPlugin(options: DecorationPluginOptions): Extension {
  const plugin = ViewPlugin.define(
    (view) => new ComposeSafeDecorations(options.name, options.build, options.rebuildWhen, view),
    { decorations: (value) => value.decorations },
  );
  return [
    plugin,
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
    // 同一オブジェクトなので、decoration plugin が複数あっても 1 つだけ登録される
    compositionSettledNotifier,
  ];
}
