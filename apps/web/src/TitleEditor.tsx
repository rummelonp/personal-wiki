import { EditorView } from "@codemirror/view";
import {
  createTitleEditor,
  dispatchWhenSettled,
  isDocReplacement,
  replaceDoc,
  setReadOnly,
} from "@personal-wiki/editor";
import { type Ref, useImperativeHandle, useLayoutEffect, useRef } from "react";

export interface TitleEditorHandle {
  /**
   * IME の変換が落ち着いたら resolve する。落ち着いていればすぐに resolve する。
   * エディタを破棄したときも resolve する（待つ側が止まり続けないように）。
   */
  whenSettled: () => Promise<void>;
}

export interface TitleEditorProps {
  /**
   * 表示する title。外（リンクの書き換えによる改名、衝突の解決、フォーカス復帰の取り込みなど）で
   * 変わったときは、エディタの中身をこれに合わせる。onChange で返した値がそのまま戻ってくる分は
   * 何もしない。改行を含めない（外からの差し替えは改行を空白に直さない）。
   */
  value: string;
  onChange: (value: string) => void;
  /** Enter で打ち終えたとき。変換を確定する Enter では呼ばない。呼んだ後に本文へ移る */
  onCommit: () => void;
  onBlur: () => void;
  readOnly: boolean;
  /** Enter と ↓ で移る先の本文の view */
  bodyView: () => EditorView | null;
  /** 作った時点で 1 度だけ、エディタに focus する（新規作成の画面）。読み取り専用なら focus しない */
  autoFocus?: boolean;
  ref?: Ref<TitleEditorHandle>;
}

const settledKey = Symbol("whenSettled");

/**
 * title 欄。packages/editor の title エディタを React に載せる。長い title は折り返して全文を出す。
 *
 * BodyEditor と同じく、EditorView は mount で 1 回だけ作り、title は replaceDoc、readOnly は
 * setReadOnly で届ける（作り直すと変換中の未確定文字が消える）。onChange は変換中の入力でも呼ぶ。
 */
export function TitleEditor({
  value,
  onChange,
  onCommit,
  onBlur,
  readOnly,
  bodyView,
  autoFocus = false,
  ref,
}: TitleEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  /** whenSettled を待っている resolve。破棄したときは dispatchWhenSettled が捨てるので、ここで呼ぶ */
  const settledWaiters = useRef<(() => void)[]>([]);

  // EditorView の listener は作ったときに 1 度だけ結ぶので、最新の props は ref から読む
  const latest = useRef({ value, onChange, onCommit, onBlur, readOnly, bodyView, autoFocus });
  latest.current = { value, onChange, onCommit, onBlur, readOnly, bodyView, autoFocus };

  // 開く操作（flushSync）の中で autoFocus まで済ませるため、layout effect で作る。iOS の Safari は
  // 操作の中で focus した入力欄にだけキーボードを出す。後に続く readOnly と value の layout effect は、
  // 作った時点と同じ値なので何も dispatch しない
  useLayoutEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const initial = latest.current;
    let created: EditorView | null = null;
    const editor = createTitleEditor(parent, {
      doc: initial.value,
      readOnly: initial.readOnly,
      bodyView: () => latest.current.bodyView(),
      onCommit: () => latest.current.onCommit(),
      extensions: EditorView.domEventHandlers({
        blur: () => {
          latest.current.onBlur();
          return false;
        },
      }),
      onUpdate: (update) => {
        if (!update.docChanged) return;
        const doc = update.state.doc.toString();
        if (update.transactions.some((tr) => tr.docChanged && !isDocReplacement(tr))) {
          latest.current.onChange(doc);
          return;
        }
        // 差し替えを保留している間に持ち主の title が先へ進んでいれば、適用した差し替えは古い。
        // 持ち主の title に合わせ直す
        if (created !== null && doc !== latest.current.value) {
          const target = created;
          setTimeout(() => {
            if (view.current === target) replaceDoc(target, latest.current.value);
          }, 0);
        }
      },
    });
    created = editor;
    view.current = editor;
    if (initial.autoFocus && !initial.readOnly) editor.focus();
    const waiters = settledWaiters.current;
    return () => {
      view.current = null;
      editor.destroy();
      for (const resolve of waiters.splice(0)) resolve();
    };
  }, []);

  // useLayoutEffect にするのは、持ち主の状態が変わってから次の入力が届く前に、エディタへ反映するため
  useLayoutEffect(() => {
    const editor = view.current;
    if (editor === null) return;
    setReadOnly(editor, readOnly);
    // 変換中に持ち主が読み取り専用になると、切り替わるまでに確定した文字は持ち主に受け取られない。
    // 切り替えと同じく落ち着いてから、持ち主の title へ戻す
    replaceDoc(editor, latest.current.value);
  }, [readOnly]);

  // doc と同じ value でも replaceDoc に渡す。変換中は保留した差し替えを最後の value で上書きさせる
  useLayoutEffect(() => {
    const editor = view.current;
    if (editor === null) return;
    replaceDoc(editor, value);
  }, [value]);

  useImperativeHandle(ref, () => ({
    whenSettled() {
      const editor = view.current;
      if (editor === null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const waiters = settledWaiters.current;
        waiters.push(resolve);
        // 同じ key の保留は最後の 1 つに畳まれるので、待っている全員をまとめて起こす
        dispatchWhenSettled(editor, settledKey, () => {
          for (const wake of waiters.splice(0)) wake();
        });
      });
    },
  }));

  return <div ref={host} className="title-input" />;
}
