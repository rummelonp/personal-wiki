import {
  acceptCompletion,
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  closeCompletion,
  completionStatus,
  moveCompletionSelection,
  pickedCompletion,
  selectedCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import {
  EditorState,
  type Extension,
  Prec,
  type StateEffect,
  type TransactionSpec,
} from "@codemirror/state";
import {
  type Command,
  type EditorView,
  keymap,
  repositionTooltips,
  tooltips,
  ViewPlugin,
} from "@codemirror/view";
import { extractLinkTargets, type LinkTargets } from "@personal-wiki/markdown";
import { compositionSettled, compositionSettledNotifier, isComposing } from "./ime";
import type { PageCandidate, PageIndex } from "./page-index";

/**
 * `[[Title#` と `[[Title#^` の候補になる、page の見出しと block id の取得元。
 *
 * `PageIndex.search` と違って非同期にする。見出しと block id は page の本文から取り出すので、
 * 本文を持っていなければ round trip が要る。`#` は意図して打つ区切りで、`[[` の 1 文字目のように
 * 打鍵の度に待たされることがない。取得済みの内容をキャッシュしておくのは呼び出し側の役目
 * （`createPageEmbedCache` と同じ分担）。`validFor` で、同じ `[[Title#` の中の打鍵は取り直さない。
 */
export interface LinkTargetSource {
  /**
   * title の page の見出しと block id。page が無いか読めない場合は null を返す。
   * `extractLinkTargets`（`@personal-wiki/markdown`）に本文を渡せば得られる。
   * 候補が要らなくなると（カーソルが link の外へ出る、選択が動くなど）`signal` が中断される。
   * 続けて打った文字では中断されず、結果は打鍵の分だけ絞り込まれて使われる。
   * reject は候補なしとして扱う。
   */
  load(title: string, signal: AbortSignal): Promise<LinkTargets | null>;
}

export interface WikiLinkAutocompleteOptions {
  readonly index: PageIndex;
  /**
   * `[[Title#` と `[[Title#^` の候補の取得元。渡さないと、他の page の見出しと block id は出ない。
   * 今の page の `[[#` と `[[#^` は、editor の本文から求めるので渡さなくても出る。
   */
  readonly linkTargets?: LinkTargetSource;
  /**
   * 候補解決（`PageIndex.search` から `CompletionResult` を返すまで）の所要時間を ms で受け取る。
   * 計測用。同期に解決したときだけ呼ぶ。インデックスの取り直しを待った場合は、待ちが利用者の打鍵の
   * 応答ではないので呼ばない。
   */
  readonly onLatency?: (ms: number) => void;
  /**
   * `activateOnTypingDelay`。既定 0。
   * title の候補は `PageIndex.search` が同期に返すので、打鍵の debounce を挟む理由が無い。
   * 0 より大きくすると、composition の直前の打鍵で予約した query が composition 中に走り、
   * autocomplete の dispatch を招く窓が広がる（IME 不変条件 1）。
   */
  readonly typingDelay?: number;
}

/** 行頭方向に `[[` があり、まだ `]]` も `|` も打たれていない位置 */
const OPEN_LINK = /\[\[[^[\]|\n]*/;
const OPEN_LINK_AT_END = new RegExp(`${OPEN_LINK.source}$`);

/**
 * `[[Title#見出し` の、`#` までと `#` の後ろ。target に `#` と `^` は含まれない
 * （`splitWikiLinkContent` が最初の `#` か `^` で target を切る）。`#^` の後ろは block id の query、
 * それ以外は見出しの query。見出しの途中の `^`（`A^b`）は query の一部として許す。
 * 見出しを `A#B` と重ねる書き方（`extractHeadingSection`）は、候補を出す対象にしない。
 */
const LINK_SECTION = /\[\[([^[\]|#^\n]*)#(\^?)([^[\]|#\n]*)/;

/**
 * query が続く間、同じ候補を使い続けてよい入力。
 * 先頭の空白と、見出しの query の先頭の `^` は、候補の種類か `from` が変わる入力なので
 * 含めない。`validFor` を外れた入力は source が再実行され、`[[Note#` の後ろの `^` で block の
 * 一覧に、空白で query の頭を飛ばした `from` に切り替わる。再利用すると、`^` や空白が絞り込みの
 * 文字として扱われて 0 件になり、候補が閉じる。
 */
const HEADING_QUERY = /^(?:[^\s[\]|#^][^[\]|#\n]*)?$/;
const BLOCK_QUERY = /^(?:[^\s[\]|#^][^[\]|#^\n]*)?$/;

/**
 * 見出しと block id の候補の、本文での並び。絞り込みの点数が同じ候補（query が空のときは全部）の
 * 順を、autocomplete の既定（label の文字順）でなく本文の順にするために `compareCompletions` が読む。
 */
const documentOrder = new WeakMap<Completion, number>();

function inDocumentOrder(completions: Completion[]): Completion[] {
  completions.forEach((completion, index) => {
    documentOrder.set(completion, index);
  });
  return completions;
}

/** `[[` や `#` の後ろを `text` にして `]]` で閉じ、caret を `]]` の後ろへ置く */
function applyText(text: string) {
  return (view: EditorView, completion: Completion, from: number, to: number): void => {
    // readOnly の間は source が候補を出さないが、候補を開いたまま readOnly に切り替わることがある。
    // tooltip の mousedown（`applyCompletion`）はキーボード経路の `acceptCompletion` と違い
    // readOnly を見ないので、ここで見る。
    if (view.state.readOnly) return;
    const { doc } = view.state;
    const closed = doc.sliceString(to, Math.min(doc.length, to + 2)) === "]]";
    view.dispatch({
      changes: { from, to, insert: closed ? text : `${text}]]` },
      selection: { anchor: from + text.length + 2 },
      annotations: pickedCompletion.of(completion),
      userEvent: "input.complete",
    });
  };
}

function candidateOption(candidate: PageCandidate): Completion {
  return { label: candidate.title, type: "text", apply: applyText(candidate.title) };
}

/**
 * 選べない案内の行。選択の見た目（theme.ts）と、Enter と Tab を取らない扱い（`acceptUnlessComposing`）は
 * この集合で見分ける。
 * CodeMirror は先頭の行に `aria-selected` を付けるが、案内の行は選べないので、描いた後で `deselectNotices` が外す。
 * 付ける前に止める手段は無い。行の属性は `optionClass` では変えられず、選択なしで開く設定（`selectOnOpen`）は
 * 通常の候補の先頭選択まで外してしまう。
 */
const notices = new WeakSet<Completion>();

/**
 * 案内の行から `aria-selected` を外し、`aria-disabled` を付ける。選べない行を、読み上げが選べる候補と
 * 誤認しないようにする。CodeMirror は選択が変わる更新の度に `aria-selected` を付け直すので、
 * 更新の度に、DOM が落ち着いた後の write で外す。
 */
const deselectNotices = ViewPlugin.define(() => ({
  update(update) {
    const selected = selectedCompletion(update.state);
    if (selected === null || !notices.has(selected)) return;
    update.view.requestMeasure({
      key: deselectNotices,
      read: () => null,
      write: (_, view) => {
        for (const row of view.dom.querySelectorAll(".cm-completion-notice[aria-selected]")) {
          row.removeAttribute("aria-selected");
          row.setAttribute("aria-disabled", "true");
        }
      },
    });
  },
}));

/**
 * 候補の取得に失敗して候補が空のときに出す案内。何も出さないと、失敗なのか一致なしなのか区別できない。
 * 選んでも何も書かず、閉じるだけにする。
 */
function failureNotice(): Completion {
  const notice: Completion = {
    label: "候補を取得できませんでした。少し待って、打ち直してください。",
    type: "text",
    apply: (view) => {
      closeCompletion(view);
    },
  };
  notices.add(notice);
  return notice;
}

/**
 * 候補が 1 つも無いときに出す「「…」へリンク（まだ無いページ）」。選ぶと候補と同じく link を閉じるだけで、page は
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
    {
      label: title,
      displayLabel: `「${title}」へリンク（まだ無いページ）`,
      type: "text",
      apply: applyText(title),
    },
  ];
}

/**
 * `[[Title#` と `[[Title#^` の候補。Title が空なら今の page（editor の本文）、あれば `linkTargets` から
 * 取る。絞り込みは autocomplete の fuzzy に任せる（page の title と違い、順位付けの規則を
 * 持たない）。page が無いか候補が 0 件のときは null にして、候補 UI を開かない。
 */
async function sectionCompletion(
  options: WikiLinkAutocompleteOptions,
  context: CompletionContext,
  match: { from: number; text: string },
): Promise<CompletionResult | null> {
  const parts = LINK_SECTION.exec(match.text);
  if (!parts) return null;
  const title = (parts[1] ?? "").trim();
  const block = parts[2] === "^";
  const rest = parts[3] ?? "";
  // query の先頭の空白は、置き換える範囲に含めない
  const lead = /^\s*/.exec(rest)?.[0].length ?? 0;
  const from = match.from + parts[0].length - rest.length + lead;

  let targets: LinkTargets | null;
  if (title === "") {
    targets = extractLinkTargets(context.state.doc.toString());
  } else if (options.linkTargets) {
    const controller = new AbortController();
    context.addEventListener("abort", () => controller.abort());
    try {
      targets = await options.linkTargets.load(title, controller.signal);
    } catch {
      // 取得の失敗は候補なしとして扱う。補完のために入力を妨げる通知は出さない
      return null;
    }
    // IME 不変条件 4。待っている間に composition が始まっていれば、結果を受け取らせない
    if (context.aborted || (context.view && isComposing(context.view))) return null;
  } else {
    return null;
  }
  if (!targets) return null;

  const completions: Completion[] = block
    ? targets.blocks.map((target) => ({
        label: target.id,
        detail: target.preview,
        type: "text",
        apply: applyText(target.id),
      }))
    : targets.headings.map((heading) => ({
        label: heading,
        type: "text",
        apply: applyText(heading),
      }));
  if (completions.length === 0) return null;

  return {
    from,
    to: context.pos,
    options: inDocumentOrder(completions),
    validFor: block ? BLOCK_QUERY : HEADING_QUERY,
  };
}

/**
 * `[[Title` の候補。取得前に「まだ無いページ」の行を出すと、既にあるページを無いと見せる偽の
 * 候補になる。取得に失敗して空のままのときも同じなので、その行の代わりに失敗を案内する。
 * 取得が済んでいない間は何も出さない。
 */
function titleOptions(index: PageIndex, query: string, candidates: PageCandidate[]): Completion[] {
  if (candidates.length > 0) return candidates.map(candidateOption);
  if (index.settled?.() === false) return [];
  return index.failed?.() ? [failureNotice()] : createOptions(query);
}

export function wikiLinkCompletionSource(options: WikiLinkAutocompleteOptions): CompletionSource {
  const { index } = options;
  return (context): CompletionResult | null | Promise<CompletionResult | null> => {
    // readOnly の view では候補を選んでも書けないので、明示の起動（Ctrl-Space）や変換後の再開でも
    // 候補を出さず、linkTargets の取得（ホストの API 呼び出し）も走らせない
    if (context.state.readOnly) return null;
    // IME 不変条件 4。composition の入力では `closeOnComposition` が source を起動させない。
    // ここに来るのは、compose の userEvent を伴わない入力と、composition の開始前に予約された
    // query（`typingDelay` や `startCompletion` の遅延）が最初の compose の入力より先に走った
    // 場合だけである。null を返すと autocomplete が後始末の transaction を dispatch するが、
    // 読みに対して候補 UI を開くよりはよい。
    if (context.view && isComposing(context.view)) return null;
    const section = context.matchBefore(LINK_SECTION);
    if (section) return sectionCompletion(options, context, section);
    const match = context.matchBefore(OPEN_LINK);
    if (!match) return null;

    const started = performance.now();
    const query = match.text.slice(2);
    const result = (candidates: PageCandidate[]): CompletionResult => ({
      from: match.from + 2,
      to: context.pos,
      // 並び順は PageIndex の scoring に任せる。autocomplete 側の fuzzy で並べ替えさせない。
      filter: false,
      options: titleOptions(index, query, candidates),
    });

    const candidates = index.search(query);
    const unavailable = !(index.settled?.() ?? true) || (index.failed?.() ?? false);
    if (candidates.length === 0 && unavailable && index.retry) {
      // 最初の取得が失敗したまま、別のページへ移るまで候補が出ない状態にしない。取り直しが済むまで待ち、
      // 取れていれば候補を、まだ失敗していれば案内を出す
      return index.retry().then(() => {
        // IME 不変条件 4。待っている間に composition が始まっていれば、結果を受け取らせない
        if (context.aborted || (context.view && isComposing(context.view))) return null;
        return result(index.search(query));
      });
    }
    const resolved = result(candidates);
    options.onLatency?.(performance.now() - started);
    return resolved;
  };
}

/**
 * IME 不変条件 3。CodeMirror は composition 中の keydown を keymap に渡さないが、
 * Safari は compositionend と Enter の keydown の順序が入れ替わることがある。
 * 候補確定の側でも composition を確認しておく。
 */
const acceptUnlessComposing: Command = (view) => {
  if (isComposing(view)) return false;
  // 案内の行は選べない。Enter と Tab を取らず、改行やリスト項目の操作に渡す
  const selected = selectedCompletion(view.state);
  if (selected !== null && notices.has(selected)) return false;
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
    if (!settled || update.state.readOnly) return;
    const { head } = update.state.selection.main;
    const line = update.state.doc.lineAt(head);
    if (!OPEN_LINK_AT_END.test(line.text.slice(0, head - line.from))) return;
    // update 中の dispatch は禁止されている
    queueMicrotask(() => startCompletion(view));
  },
}));

/**
 * tooltip を置ける範囲。iOS のソフトキーボードは layout viewport を縮めず visual viewport だけを
 * 縮めるので、既定の `documentElement.clientHeight` のままだと、キーボードに隠れる下側にも
 * 余地があると見なされて候補が caret の下に開く。visual viewport の範囲を返せば、下が狭いとき
 * CodeMirror が広い側（caret の上）へ開く。visual viewport の座標は layout viewport からの
 * 位置（offsetTop / offsetLeft）で、tooltip の座標系（client 座標）と揃う。
 * 右端は本文の列の右端で切り詰めるので、画面の右端より内側になることがある。
 */
export function tooltipSpace(view: EditorView): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  const win = view.dom.ownerDocument.defaultView;
  const viewport = win?.visualViewport;
  const root = view.dom.ownerDocument.documentElement;
  const space = viewport
    ? {
        top: viewport.offsetTop,
        bottom: viewport.offsetTop + viewport.height,
        left: viewport.offsetLeft,
        right: viewport.offsetLeft + viewport.width,
      }
    : { top: 0, left: 0, bottom: root.clientHeight, right: root.clientWidth };
  // 窓の枠（ul）の右端を本文の列の右端に収める。tooltip の箱は枠の右に余白（theme.ts の
  // AUTOCOMPLETE_EDGE_GAP）を持つので、箱の右端の上限は、その実測値だけ列の右端より外に置く。
  // 画面の右端まで許すと、列の右に余白のある画面で枠が列からはみ出す。
  const tooltip = view.dom.querySelector(".cm-tooltip-autocomplete");
  const edgeGap = tooltip ? Number.parseFloat(getComputedStyle(tooltip).paddingRight) || 0 : 0;
  const columnRight = view.contentDOM.getBoundingClientRect().right;
  return { ...space, right: Math.min(space.right, columnRight + edgeGap) };
}

/**
 * visual viewport が動いたら tooltip を置き直す。CodeMirror は window の resize や本文のスクロール、
 * 本文の更新などで測り直すが、visual viewport の変化は拾わない。iOS では窓を開いた後に
 * キーボードの高さが変わったり画面がずれたりして、visual viewport だけが動くことがある。
 * 置き直さないと、窓は古い範囲に合わせた位置に残ってキーボードの裏に切れる。
 */
const followVisualViewport = ViewPlugin.define((view) => {
  const viewport = view.dom.ownerDocument.defaultView?.visualViewport;
  const reposition = () => repositionTooltips(view);
  viewport?.addEventListener("resize", reposition);
  viewport?.addEventListener("scroll", reposition);
  return {
    destroy() {
      viewport?.removeEventListener("resize", reposition);
      viewport?.removeEventListener("scroll", reposition);
    },
  };
});

export function wikiLinkAutocomplete(options: WikiLinkAutocompleteOptions): Extension {
  return [
    compositionSettledNotifier,
    closeOnComposition(),
    restartAfterComposition,
    autocompletion({
      override: [wikiLinkCompletionSource(options)],
      compareCompletions: (a, b) => (documentOrder.get(a) ?? 0) - (documentOrder.get(b) ?? 0),
      defaultKeymap: false,
      optionClass: (completion) => (notices.has(completion) ? "cm-completion-notice" : ""),
      activateOnTypingDelay: options.typingDelay ?? 0,
      icons: false,
    }),
    tooltips({ tooltipSpace }),
    followVisualViewport,
    deselectNotices,
    Prec.highest(keymap.of(imeSafeCompletionKeymap)),
  ];
}
