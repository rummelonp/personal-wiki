import { EditorView } from "@codemirror/view";
import { MAX_TITLE_BYTES, utf8ByteLength } from "@personal-wiki/domain/page-input";
import { singleLineTitle, titleInputText, wikiLinkUnsafeChars } from "@personal-wiki/domain/title";
import {
  createTitleEditor,
  dispatchWhenSettled,
  isDocReplacement,
  replaceDoc,
  setReadOnly,
} from "@personal-wiki/editor";
import { type Ref, useId, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { InputMeter, METER_SHOW_RATIO } from "./InputMeter";

export interface TitleEditorHandle {
  /**
   * IME の変換が落ち着いたら resolve する。落ち着いていればすぐに resolve する。
   * エディタを破棄したときも resolve する（待つ側が止まり続けないように）。
   */
  whenSettled: () => Promise<void>;
  /** 入力欄にカーソルを置く。選択範囲は前のまま。 */
  focus: () => void;
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
  /**
   * 欄を空にしたときに残る title。空の title は確定しても入らず、この title のまま保存されるので、
   * 帯でそれを伝える。作る前のページは残る title が無い（作成が title を待つだけ）ので、空にする
   */
  keptTitle?: string;
  /**
   * 保存を止めている（title の重複や上限の超過など）。keptTitle はサーバーに入っていない draft の
   * title なので、「そのまま」とは言えない。欄を空にしたときの文は、保存しないことだけを伝える
   */
  saveHeldBack?: boolean;
  ref?: Ref<TitleEditorHandle>;
}

const settledKey = Symbol("whenSettled");

/**
 * title 欄。packages/editor の title エディタを React に載せる。長い title は折り返して全文を出す。
 *
 * BodyEditor と同じく、EditorView は mount で 1 回だけ作り、title は replaceDoc、readOnly は
 * setReadOnly で届ける（作り直すと変換中の未確定文字が消える）。onChange は変換中の入力でも呼ぶ。
 *
 * 欄の下の余白に、欄を空にしたときに保存される title、リンクに書けない文字、上限に近づいた長さを
 * 出す。余白に重ねるので、出入りしても本文の位置は動かない。
 */
export function TitleEditor({
  value,
  onChange,
  onCommit,
  onBlur,
  readOnly,
  bodyView,
  autoFocus = false,
  keptTitle = "",
  saveHeldBack = false,
  ref,
}: TitleEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const hintId = useId();
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
      // 保存で拒まれる制御文字は、貼った時点で取り除く。見えない文字を後から探させない
      normalizeInput: titleInputText,
      extensions: [
        EditorView.domEventHandlers({
          blur: () => {
            latest.current.onBlur();
            return false;
          },
        }),
        // 案内の要素は空の間も置いておくので、作ったときの id のまま指し続けられる
        EditorView.contentAttributes.of({ "aria-describedby": hintId }),
      ],
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
  }, [hintId]);

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
    focus() {
      view.current?.focus();
    },
  }));

  const title = singleLineTitle(value);
  const unsafe = wikiLinkUnsafeChars(title);
  const bytes = utf8ByteLength(title);
  // title が空なら unsafe も空なので、文は同時に 2 つ出ない。可変の部分と前後に分けるのは、CSS で
  // 可変の部分だけを省略するため
  const hint: { head: string; variable: string; tail: string; chars?: true } =
    title === "" && keptTitle !== ""
      ? saveHeldBack
        ? { head: "空のタイトルは保存しません。", variable: "", tail: "" }
        : { head: "空のタイトルは保存しません。「", variable: keptTitle, tail: "」のままです。" }
      : unsafe.length > 0
        ? {
            head: "",
            variable: unsafe.map((ch) => `「${ch}」`).join(""),
            chars: true,
            tail: "を含むタイトルには、[[ ]] でリンクできません。",
          }
        : { head: "", variable: "", tail: "" };
  return (
    <div className="title-field">
      <div ref={host} className="title-input" />
      <p id={hintId} className="title-hint">
        {/*
         * 文だけを live region にする。帯ごと読み上げると、打つたびに変わる長さの数まで読まれる。
         * 要素は文が無いときも残す。後から role を付けて出した要素は、最初の文が読まれない読み上げがある
         */}
        <span role="status" className="title-hint-text">
          <span>{hint.head}</span>
          <span
            className={hint.chars ? "title-hint-variable title-hint-chars" : "title-hint-variable"}
          >
            {hint.variable}
          </span>
          <span>{hint.tail}</span>
        </span>
        {bytes >= MAX_TITLE_BYTES * METER_SHOW_RATIO && (
          <InputMeter label="タイトルの長さ" bytes={bytes} max={MAX_TITLE_BYTES} />
        )}
      </p>
    </div>
  );
}
