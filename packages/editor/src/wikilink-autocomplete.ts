import {
  acceptCompletion,
  autocompletion,
  type Completion,
  type CompletionResult,
  type CompletionSource,
  closeCompletion,
  completionStatus,
  moveCompletionSelection,
  pickedCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import {
  EditorState,
  type Extension,
  Prec,
  type StateEffect,
  type TransactionSpec,
} from "@codemirror/state";
import { type Command, type EditorView, keymap, ViewPlugin } from "@codemirror/view";
import { compositionSettled, compositionSettledNotifier, isComposing } from "./ime";
import type { PageCandidate, PageIndex } from "./page-index";

export interface WikiLinkAutocompleteOptions {
  readonly index: PageIndex;
  /**
   * 候補解決（`PageIndex.search` から `CompletionResult` を返すまで）の所要時間を ms で受け取る。
   * 計測用。
   */
  readonly onLatency?: (ms: number) => void;
  /**
   * `activateOnTypingDelay`。既定 0。
   * 候補解決が同期なので、打鍵の debounce を挟む理由が無い。
   * 0 より大きくすると、composition の直前の打鍵で予約した query が composition 中に走り、
   * autocomplete の dispatch を招く窓が広がる（IME 不変条件 1）。
   */
  readonly typingDelay?: number;
}

/** 行頭方向に `[[` があり、まだ `]]` も `|` も打たれていない位置 */
const OPEN_LINK = /\[\[[^[\]|\n]*/;
const OPEN_LINK_AT_END = new RegExp(`${OPEN_LINK.source}$`);

/** `[[` の後ろを `title` にして `]]` で閉じ、caret を `]]` の後ろへ置く */
function applyTitle(title: string) {
  return (view: EditorView, completion: Completion, from: number, to: number): void => {
    // create-editor.ts は readOnly なら wikiLinkAutocomplete 自体を積まないが、tooltip の
    // mousedown（`applyCompletion`）はキーボード経路の `acceptCompletion` と違い readOnly を
    // 見ないので、extension の積み方に依存しない防御としてここでも見る。
    if (view.state.readOnly) return;
    const { doc } = view.state;
    const closed = doc.sliceString(to, Math.min(doc.length, to + 2)) === "]]";
    view.dispatch({
      changes: { from, to, insert: closed ? title : `${title}]]` },
      selection: { anchor: from + title.length + 2 },
      annotations: pickedCompletion.of(completion),
      userEvent: "input.complete",
    });
  };
}

function candidateOption(candidate: PageCandidate): Completion {
  return { label: candidate.title, type: "text", apply: applyTitle(candidate.title) };
}

/**
 * 候補が 1 つも無いときに出す「「…」を作成」。選ぶと候補と同じく link を閉じるだけで、page は
 * まだ作らない。存在しない page への link は書いてよく、page は
 * 未解決の link を開いたときにホストが作る（`onWikiLinkClick`）。ここで作ると、書いている
 * 途中で使わないかもしれない page が増える。
 * title には query の前後の空白を除いたものを使う（`[[ foo` は `[[foo]]` になる）。
 * `#` と `^` を含む query は見出しとブロックの参照で、page の title にならないので出さない。
 */
function createOptions(query: string): Completion[] {
  const title = query.trim();
  if (title === "" || /[#^]/.test(title)) return [];
  return [
    { label: title, displayLabel: `「${title}」を作成`, type: "text", apply: applyTitle(title) },
  ];
}

export function wikiLinkCompletionSource(options: WikiLinkAutocompleteOptions): CompletionSource {
  return (context): CompletionResult | null => {
    // IME 不変条件 4。composition の入力では `closeOnComposition` が source を起動させない。
    // ここに来るのは、compose の userEvent を伴わない入力と、composition の開始前に予約された
    // query（`typingDelay` や `startCompletion` の遅延）が最初の compose の入力より先に走った
    // 場合だけである。null を返すと autocomplete が後始末の transaction を dispatch するが、
    // 読みに対して候補 UI を開くよりはよい。
    if (context.view && isComposing(context.view)) return null;
    const match = context.matchBefore(OPEN_LINK);
    if (!match) return null;

    const started = performance.now();
    const query = match.text.slice(2);
    const candidates = options.index.search(query);
    const result: CompletionResult = {
      from: match.from + 2,
      to: context.pos,
      // 並び順は PageIndex の scoring に任せる。autocomplete 側の fuzzy で並べ替えさせない。
      filter: false,
      options: candidates.length > 0 ? candidates.map(candidateOption) : createOptions(query),
    };
    options.onLatency?.(performance.now() - started);
    return result;
  };
}

/**
 * IME 不変条件 3。CodeMirror は composition 中の keydown を keymap に渡さないが、
 * Safari は compositionend と Enter の keydown の順序が入れ替わることがある。
 * 候補確定の側でも composition を確認しておく。
 */
const acceptUnlessComposing: Command = (view) => {
  if (isComposing(view)) return false;
  return acceptCompletion(view);
};

/**
 * `completionKeymap` の Enter を `acceptUnlessComposing` に差し替えたもの。
 * 既定の keymap を残すと Enter が素の `acceptCompletion` に先に拾われるので、
 * `defaultKeymap: false` にしてこちらだけを登録する。
 * Tab は既定の keymap に無いが、候補の確定に使う（IME 不変条件 3）。候補が開いていないときは
 * false を返すので、リスト項目の Tab（`list-keymap`、Prec.high）にはそのとき初めて届く。
 */
const imeSafeCompletionKeymap = [
  { key: "Ctrl-Space", run: startCompletion },
  { key: "Escape", run: closeCompletion },
  { key: "ArrowDown", run: moveCompletionSelection(true) },
  { key: "ArrowUp", run: moveCompletionSelection(false) },
  { key: "PageDown", run: moveCompletionSelection(true, "page") },
  { key: "PageUp", run: moveCompletionSelection(false, "page") },
  { key: "Enter", run: acceptUnlessComposing },
  { key: "Tab", run: acceptUnlessComposing },
];

/**
 * `@codemirror/autocomplete` は completion を閉じる `StateEffect` を export していないので、
 * `closeCompletion` が dispatch する effect を使い捨ての state で取り出す。取り出せない版に
 * 上がったときに IME 不変条件 4 を黙って破らないよう、ここで落とす。
 */
function captureCloseCompletionEffects(): StateEffect<unknown> | readonly StateEffect<unknown>[] {
  let state = EditorState.create({ extensions: autocompletion({ override: [() => null] }) });
  let effects: TransactionSpec["effects"];
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec) {
      effects = spec.effects;
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
  // 何も起動していない間は closeCompletion が dispatch しない
  startCompletion(view);
  closeCompletion(view);
  if (effects === undefined || completionStatus(state) !== null) {
    throw new Error("closeCompletion did not dispatch an effect that closes the completion");
  }
  return effects;
}

/**
 * IME 不変条件 1 と 4。composition の入力（userEvent が `input.type.compose`）も
 * `activateOnTyping` の対象で、source を起動し、開いている候補も取り直させる。source が
 * null を返すと autocomplete は pending を解く transaction を自分で dispatch するので、
 * composition の transaction そのものに completion を閉じる effect を足して、source を
 * 起動させない。開いていた候補 UI もこの transaction で閉じる。
 */
let closeCompletionEffects: ReturnType<typeof captureCloseCompletionEffects> | undefined;

function closeOnComposition(): Extension {
  closeCompletionEffects ??= captureCloseCompletionEffects();
  const effects = closeCompletionEffects;
  return EditorState.transactionExtender.of((tr) =>
    tr.isUserEvent("input.type.compose") ? { effects } : null,
  );
}

/**
 * 確定文字列を入れる transaction も composition の入力なので、`closeOnComposition` が
 * 候補を閉じたままにする。autocomplete 自身の再開処理は
 * composition の後にカーソル移動が挟まった場合（`ChangedAndMoved`）にしか働かない。
 * composition が落ち着いた時点で `[[` の中にいれば、ここで開き直す。
 */
const restartAfterComposition = ViewPlugin.define((view) => ({
  update(update) {
    const settled = update.transactions.some((tr) =>
      tr.effects.some((effect) => effect.is(compositionSettled)),
    );
    if (!settled) return;
    const { head } = update.state.selection.main;
    const line = update.state.doc.lineAt(head);
    if (!OPEN_LINK_AT_END.test(line.text.slice(0, head - line.from))) return;
    // update 中の dispatch は禁止されている
    queueMicrotask(() => startCompletion(view));
  },
}));

export function wikiLinkAutocomplete(options: WikiLinkAutocompleteOptions): Extension {
  return [
    compositionSettledNotifier,
    closeOnComposition(),
    restartAfterComposition,
    autocompletion({
      override: [wikiLinkCompletionSource(options)],
      defaultKeymap: false,
      activateOnTypingDelay: options.typingDelay ?? 0,
      icons: false,
    }),
    Prec.highest(keymap.of(imeSafeCompletionKeymap)),
  ];
}
