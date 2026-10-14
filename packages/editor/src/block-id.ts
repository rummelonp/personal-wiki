import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type Extension, Prec, StateEffect, StateField } from "@codemirror/state";
import {
  type Command,
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { Tree } from "@lezer/common";
import { extractBlockIds, taskListNodes } from "@personal-wiki/markdown";
import { compositionSettled, isComposing, isCompositionUnsettled } from "./ime";

/** 構文木の parse が間に合わなかった場合、その場では諦めて既存の（不完全な）木で妥協する。 */
const ENSURE_SYNTAX_TREE_TIMEOUT_MS = 100;

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateBlockId(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ID_CHARS[byte % ID_CHARS.length]).join("");
}

/** `generate` が文書中の既存 id と衝突する間、再生成する。 */
export function pickUniqueBlockId(
  existingIds: ReadonlySet<string>,
  generate: () => string = generateBlockId,
): string {
  let id = generate();
  while (existingIds.has(id)) id = generate();
  return id;
}

interface ParagraphRange {
  readonly from: number;
  readonly to: number;
}

/**
 * task list の項目の本文は、Editor の構文木では Paragraph でなく Task になる。抽出
 * （`extractBlockIds`）は task list を解析せずに段落として読むので、`- [x] 完了 ^id` の `^id` も
 * block id になる。Task も段落として扱わないと、task に付与できず参照先にも辿り着けない。
 */
const PARAGRAPH = new Set(["Paragraph", taskListNodes.task]);
/**
 * block id の参照先として移動できる block。抽出（`extractBlockIds`）は GFM Table を段落として
 * 解析するので、`| c | d | ^id` や表の直後の行の `^id` を block id と認める。一方 Editor の
 * 構文木ではそこが Table の中になり、Paragraph を探すだけでは参照先に辿り着けない。
 */
const REVEAL_TARGET = new Set([...PARAGRAPH, "Table"]);

/**
 * 選択位置を含む、`names` のいずれかの node の範囲。該当する block の外（空行など）では
 * undefined を返す。
 *
 * `resolveInner` の `side` は境界上での解決方向を決める：段落の先頭では `-1`（手前）が
 * 親（Document など）へ抜けてしまい、段落の末尾では `1`（後ろ）が次の block へ抜けてしまう。
 * 先に `1` を試し、それで該当 node に辿り着かなければ `-1` で試す。
 */
function findEnclosingParagraph(
  tree: Tree,
  pos: number,
  names: ReadonlySet<string> = PARAGRAPH,
): ParagraphRange | undefined {
  for (const side of [1, -1] as const) {
    let node = tree.resolveInner(pos, side);
    for (;;) {
      if (names.has(node.name)) return { from: node.from, to: node.to };
      const parent = node.parent;
      if (!parent) break;
      node = parent;
    }
  }
  return undefined;
}

/** 段落の末尾から空白文字を除いた位置。trailing whitespace は inline content の外扱いになる。 */
function trimTrailingWhitespace(text: string): number {
  let end = text.length;
  while (end > 0 && /\s/.test(text.charAt(end - 1))) end--;
  return end;
}

/**
 * 選択位置を含む段落の末尾に ` ^blockid` を付与する（手動付与のみで、
 * 自動採番しない）。既にその段落が block id を持つ場合は付け直さない
 * （`^a ^b` は末尾の 1 つしか `parseInline` に認識されないため、二重付与は壊れた記法を生む）。
 *
 * id は文書全体で重複しないものを生成する。重複解決規則（先勝ち）はあるが、
 * 新規付与時点では避けられる重複をあえて作らない。
 */
export const assignBlockId: Command = (view) => {
  if (isComposing(view)) return false;
  // Mod-Alt-b は Prec.highest の keymap で無条件に入るため、readOnly はここで自分で見る
  // 必要がある（`EditorState.readOnly` は CodeMirror 自身の入力経路しか拒まない）。
  if (view.state.readOnly) return false;

  const { state } = view;
  const paragraph = findEnclosingParagraph(syntaxTree(state), state.selection.main.head);
  if (!paragraph) return false;

  const rawText = state.doc.sliceString(paragraph.from, paragraph.to);
  const insertAt = paragraph.from + trimTrailingWhitespace(rawText);
  const paragraphText = rawText.slice(0, insertAt - paragraph.from);
  if (extractBlockIds(paragraphText).length > 0) return false;

  const existingIds = new Set(extractBlockIds(state.doc.toString()).map((ref) => ref.id));
  const id = pickUniqueBlockId(existingIds);

  const insertion = ` ^${id}`;
  view.dispatch({
    changes: { from: insertAt, insert: insertion },
    selection: { anchor: insertAt + insertion.length },
    scrollIntoView: true,
    userEvent: "input.blockid",
  });
  return true;
};

/** 段落への block id 付与を `Mod-Alt-b` に割り当てる。 */
export function blockIdAssignment(): Extension {
  return Prec.highest(keymap.of([{ key: "Mod-Alt-b", run: assignBlockId }]));
}

const setHighlight = StateEffect.define<{ from: number; to: number } | null>();

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setHighlight)) continue;
      next = effect.value
        ? Decoration.set([
            Decoration.mark({ class: "cm-block-ref-highlight" }).range(
              effect.value.from,
              effect.value.to,
            ),
          ])
        : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const HIGHLIGHT_DURATION_MS = 2000;

/**
 * ハイライトを一定時間後に消す。setTimeout の callback で直接 dispatch すると、
 * ハイライト中に他ページへ遷移して view が破棄された場合に破棄済みの view へ
 * dispatch してしまうため、plugin の destroy でタイマーを解除する。
 *
 * タイマー発火時に composition 中、または確定文字列を doc に読み込む前だと、dispatch が
 * 確定前の文字列や未読の DOM 変更を壊し、IME 不変条件 1（ime.ts）を破る。
 * その場合は dispatch を見送り、`compositionSettled`（ime.ts、composition 終了を通知する
 * 空の transaction）を待って 1 回だけ flush する。
 */
const clearHighlightOnTimeout = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | undefined;
    settleTimer: ReturnType<typeof setTimeout> | undefined;
    pendingClear = false;

    update(update: ViewUpdate): void {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(setHighlight) && effect.value !== null) {
            clearTimeout(this.timer);
            clearTimeout(this.settleTimer);
            this.pendingClear = false;
            this.timer = setTimeout(() => this.clear(update.view), HIGHLIGHT_DURATION_MS);
          }
          if (effect.is(compositionSettled) && this.pendingClear) {
            this.pendingClear = false;
            // ViewPlugin.update() の最中は view.dispatch を呼べない
            // （"Calls to EditorView.update are not allowed while an update is in progress"）。
            this.settleTimer = setTimeout(
              () => update.view.dispatch({ effects: setHighlight.of(null) }),
              0,
            );
          }
        }
      }
    }

    clear(view: EditorView): void {
      if (isCompositionUnsettled(view)) {
        this.pendingClear = true;
        return;
      }
      view.dispatch({ effects: setHighlight.of(null) });
    }

    destroy(): void {
      clearTimeout(this.timer);
      clearTimeout(this.settleTimer);
    }
  },
);

/** block reference の遷移先で対象段落を一時的にハイライトする表示のための extension。 */
export function blockIdHighlight(): Extension {
  return [highlightField, clearHighlightOnTimeout];
}

/**
 * 文書内から block id `blockId` を探し、それを含む段落へカーソルを移してスクロールし、
 * 一時的にハイライトする。同じ id が複数あるときは、文書の中で先に現れるほうを選ぶ
 * （`extractBlockIds` は出現順に返す）。
 */
export function revealBlockId(view: EditorView, blockId: string): boolean {
  const ref = extractBlockIds(view.state.doc.toString()).find(
    (candidate) => candidate.id === blockId,
  );
  if (!ref) return false;

  // 大きな文書では viewport 外がまだ parse されておらず、そのまま syntaxTree() を読むと
  // ref.from が未parse領域に落ちて resolveInner が top-level node しか返さない
  // （@codemirror/language の incremental parse）。ref.to まで強制的に parse させる。
  const tree =
    ensureSyntaxTree(view.state, ref.to, ENSURE_SYNTAX_TREE_TIMEOUT_MS) ?? syntaxTree(view.state);
  const paragraph = findEnclosingParagraph(tree, ref.from, REVEAL_TARGET);
  if (!paragraph) return false;

  view.dispatch({
    selection: { anchor: paragraph.from },
    effects: [
      setHighlight.of({ from: paragraph.from, to: paragraph.to }),
      EditorView.scrollIntoView(paragraph.from, { y: "center" }),
    ],
  });
  return true;
}
