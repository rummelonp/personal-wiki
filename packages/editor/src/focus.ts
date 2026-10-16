import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import { decorationPlugin } from "./decoration-plugin";

/**
 * 直前の操作が keyboard だったか。focus が pointer と keyboard のどちらで入ったかを決めるのに使う。
 *
 * `:focus-visible` では分けられない。Chromium は contenteditable（CodeMirror の contentDOM）を
 * 「キーボード入力を受ける要素」として扱い、click で focus したときも一致させる
 * （この repo の chromium で実測。click 直後に `contentDOM.matches(":focus-visible")` が true）。
 * そのため、focus-visible の polyfill と同じく直前の操作の種類を自分で覚える。
 *
 * view ごとではなく module 全体で 1 つなのは、focus の移り先を決めた操作（Tab の keydown）が
 * 移る前の要素、つまり別の view や editor の外で起きるためである。
 */
let lastInputWasKeyboard = false;
let trackers = 0;

const rememberKeyboard = (event: KeyboardEvent) => {
  // 修飾キーを伴う打鍵は除く。Cmd+Tab でアプリを切り替えて戻ると、ブラウザが元の要素へ
  // focus を戻すので、これを keyboard と数えると pointer で入った view に枠が出る。
  // これで防げるのは修飾キーを使う切り替えだけで、修飾キーを使わない切り替えの後は誤差が残る
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  lastInputWasKeyboard = true;
};
const rememberPointer = () => {
  lastInputWasKeyboard = false;
};

/**
 * 操作の種類を覚える window の listener。view が 1 つでも生きている間だけ張る。
 * capture 相で聞くのは、途中の handler が `stopPropagation` しても種類を取り逃さないため。
 */
const inputModalityTracker = ViewPlugin.define(() => {
  if (trackers++ === 0) {
    window.addEventListener("keydown", rememberKeyboard, true);
    window.addEventListener("pointerdown", rememberPointer, true);
  }
  return {
    destroy() {
      if (--trackers === 0) {
        window.removeEventListener("keydown", rememberKeyboard, true);
        window.removeEventListener("pointerdown", rememberPointer, true);
      }
    },
  };
});

const setKeyboardFocus = StateEffect.define<boolean>();

/**
 * keyboard で focus が入ったか。focus した時点の操作の種類をここに固定する。
 *
 * `editorAttributes` から直接 `lastInputWasKeyboard` を読まないのは、attribute が update のたびに
 * 計算し直されるためである。pointer で入った後に文字を打つと keyboard の操作になり、枠が出てしまう。
 */
const keyboardFocus = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setKeyboardFocus)) return effect.value;
    return value;
  },
});

/**
 * focus の出入りで `keyboardFocus` を更新する。CodeMirror が focus の変化を view へ反映するときの
 * transaction に effect を載せるだけで、こちらからは dispatch しない（IME 不変条件 1）。
 * 値が変わらないときは effect を返さず、transaction 自体を起こさせない。
 */
const trackKeyboardFocus = EditorView.focusChangeEffect.of((state, focusing) => {
  const next = focusing && lastInputWasKeyboard;
  return state.field(keyboardFocus) === next ? null : setKeyboardFocus.of(next);
});

const keyboardFocusAttribute = EditorView.editorAttributes.of((view) =>
  view.state.field(keyboardFocus) ? { class: "cm-focus-keyboard" } : null,
);

/**
 * class を重ねて詳細度を上げてあるのは、消す相手が CodeMirror 自身の base theme の
 * `&.cm-focused { outline: 1px dotted }` で、どちらも base theme として注入されるためである
 * （`editorSurfaceTheme` と同じ理由。適用順に頼らない）。
 */
const noOutlineTheme = EditorView.baseTheme({
  "&.cm-focused.cm-focused": { outline: "none" },
});

// 枠を消す規則に確実に勝つよう、class をさらに 1 つ重ねる
const keyboardRingTheme = EditorView.baseTheme({
  // 枠は Tab で飛んだ先を示すためのもの。欄が小さく、どの部品に focus が入ったかを caret だけでは
  // 追えない。太さと色はホストのフォーム部品の focus 表示に揃える
  "&.cm-focused.cm-focused.cm-focus-keyboard": {
    outline: "2px solid var(--ui-color-accent)",
    outlineOffset: "1px",
  },
});

/**
 * CodeMirror 既定の点線の focus 枠を消す。本文の view に入れる。
 *
 * 本文は枠を出さない。focus の有無と居場所は caret とカーソル行の地（`activeLine`）が示す。
 * 別のタブやウィンドウから戻ると、ブラウザが元の要素へ focus を戻すが、そのとき直前の操作は
 * 打鍵のままなので、keyboard で入ったと見なして枠を出すと、本文の全体が不意に囲まれる。
 */
export function noFocusOutline(): Extension {
  return noOutlineTheme;
}

/**
 * 既定の点線の枠を消し、keyboard で入ったときだけ accent の枠を出す。title 欄に入れる。
 * pointer で入ったときは自分で置いた場所が分かるので、枠を出さない。
 */
export function focusRing(): Extension {
  return [
    inputModalityTracker,
    keyboardFocus,
    trackKeyboardFocus,
    keyboardFocusAttribute,
    noOutlineTheme,
    keyboardRingTheme,
  ];
}

const activeLineDecoration = Decoration.line({ class: "cm-active-line" });

const activeLineTheme = EditorView.baseTheme({
  // accent をごく薄く混ぜる。本文と地のコントラスト（`focus.test.ts` が測る 4.5:1）を
  // 落とさない濃さにする。
  // 地は半透明にする。選択範囲の地は行より下の層に描かれるので、不透明にすると行の中の選択が隠れる。
  // `.cm-line` と重ねずクラス 1 つで書いてあるのは、callout の行の地（`.cm-line.cm-lp-callout`）に
  // 負けるようにするためである。行の種類を示す地のほうが、カーソルの居場所より情報量が多い。
  // class 名を CodeMirror の `highlightActiveLine` と同じ `cm-activeLine` にしないのは、
  // あれの base theme（水色の地）まで当たってしまうため。
  ".cm-active-line": {
    backgroundColor: "color-mix(in srgb, var(--ui-color-accent) 7%, transparent)",
  },
  // 地の左端を本文の文字の左端に揃える。行の箱は content の左端から始まるので、そのままでは地が
  // 既定の左 padding の分（6px）だけ文字の左へはみ出す。コードブロックの地は margin で箱ごと寄せるが
  // （`theme.ts`）、ここでは margin を使わず、地を content-box で切る。margin で寄せると、CodeMirror が
  // 複数行の選択範囲の矩形を最初の行の padding-left から計算するため、文書の 1 行目が active のとき
  // 選択範囲が 6px 左にずれる。active line は本文の行なので padding を変えずに済む。
  // 引用と callout の行は、バーを background-image で描いており、background-clip は背景の層ごとに
  // 決まって地の層だけ切れないので、揃えない。コードと frontmatter の source は地が自前。
  ".cm-active-line:not(.cm-lp-code, .cm-lp-blockquote, .cm-frontmatter-source)": {
    backgroundClip: "content-box",
  },
});

/**
 * カーソルのある行に淡い地を敷く。focus のある view にだけ出す。
 *
 * `@codemirror/view` の `highlightActiveLine` を使わないのは、あれが composition 中の
 * `docChanged` でも decoration を組み直すためである（IME 不変条件 1）。`decorationPlugin` に
 * 載せると、composition 中は位置の写像だけを行い、終了後に 1 回だけ組み直す。
 */
export function activeLine(): Extension {
  return [
    activeLineTheme,
    decorationPlugin({
      name: "active-line",
      build: (view) => {
        // focus の無い view にはカーソルが無いので敷かない（readonly のページ embed も focus できるので対象）。
        // `decorationPlugin` は focus の変化でも組み直すので、出入りに追従する
        if (!view.hasFocus) return { decorations: Decoration.none };
        const lineStarts = new Set<number>();
        for (const range of view.state.selection.ranges) {
          lineStarts.add(view.state.doc.lineAt(range.head).from);
        }
        return {
          decorations: Decoration.set(
            [...lineStarts].map((from) => activeLineDecoration.range(from)),
            true,
          ),
        };
      },
    }),
  ];
}
