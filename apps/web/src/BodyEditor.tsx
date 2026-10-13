import { closeCompletion } from "@codemirror/autocomplete";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import {
  createEditor,
  isCompositionUnsettled,
  isDocReplacement,
  type LinkTargetSource,
  type PageIndex,
  replaceDoc,
  wikiLinkAutocomplete,
} from "@personal-wiki/editor";
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";

export interface BodyEditorHandle {
  /** 本文の `offset` の位置にカーソルを置き、見える位置までスクロールする。 */
  jumpTo: (offset: number) => void;
}

export interface BodyEditorProps {
  /**
   * 表示する本文。外（保存結果、衝突の解決、退避の復元など）で変わったときは、エディタの中身を
   * これに合わせる。onChange で返した値がそのまま戻ってくる分は何もしない。
   */
  value: string;
  /** 読み取り専用の表示では渡さなくてよい。 */
  onChange?: (value: string) => void;
  onBlur?: () => void;
  /** true で入力をすべて止める。カーソルを置いて記法を見る、選択してコピーすることはできる。 */
  readOnly?: boolean;
  /** `[[` の title の候補。作った時点のものを使い続けるので、中身を差し替えられる形で渡す。 */
  pageIndex?: PageIndex;
  /** `[[Title#` と `[[Title#^` の候補の取得元。pageIndex と一緒に渡したときだけ働く。 */
  linkTargets?: LinkTargetSource;
  ref?: Ref<BodyEditorHandle>;
}

/**
 * changeFilter は、`state.readOnly` を見ずに doc を書く extension が後から増えても入力を通さない
 * ための裏付け。replaceDoc（データ側からの差し替え）だけは通す。
 */
function modeExtensions(readOnly: boolean): Extension {
  if (!readOnly) return [];
  return [EditorState.readOnly.of(true), EditorState.changeFilter.of((tr) => isDocReplacement(tr))];
}

/**
 * 補完は readOnly の Compartment に入れず、ずっと積んでおく。補完の ViewPlugin は destroy で
 * debounce の timer を止めないので、入力直後や取得の途中に extension ごと外すと、残った timer が
 * 外れた StateField を読んで例外を投げる。
 *
 * そのため読み取り専用でも補完は生きている。打鍵では開かないが、明示の起動（Ctrl-Space など）と
 * 変換の確定後の再開では候補が開き、`[[Title#` なら linkTargets の取得も走る。開いていた候補は
 * 切り替え時に閉じ、候補の適用は wikiLinkAutocomplete 自身と changeFilter が拒むので、doc は
 * 変わらない。読み取り専用で候補自体を出さないには、補完の source 側で readOnly を見る必要がある。
 */
function completionExtensions(
  pageIndex: PageIndex | undefined,
  linkTargets: LinkTargetSource | undefined,
): Extension {
  if (pageIndex === undefined) return [];
  return wikiLinkAutocomplete({
    index: pageIndex,
    ...(linkTargets === undefined ? {} : { linkTargets }),
  });
}

/**
 * IME の変換中（確定文字列を読み込むまでを含む）は、エディタの外から dispatch しない
 * （packages/editor の ime.ts の IME 不変条件 1）。変換中に来た操作は種類ごとに最後の 1 つだけを
 * 覚えておき、落ち着いた後の最初の update から次の task で 1 回だけ実行する。
 * replaceDoc は自分で同じ保留をするので、ここに通すのはそれ以外の dispatch（readOnly の積み替え、
 * jumpTo の selection）だけ。
 */
class SettledDispatcher {
  private readonly pending = new Map<string, () => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;

  constructor(private readonly view: EditorView) {}

  run(key: string, action: () => void): void {
    if (isCompositionUnsettled(this.view)) {
      this.pending.set(key, action);
      return;
    }
    this.pending.delete(key);
    action();
  }

  update(update: ViewUpdate): void {
    if (this.pending.size === 0 || isCompositionUnsettled(update.view)) return;
    // update の最中は dispatch できない
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 0);
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.timer);
    this.pending.clear();
  }

  private flush(): void {
    if (this.destroyed || isCompositionUnsettled(this.view)) return;
    const actions = [...this.pending.values()];
    this.pending.clear();
    for (const action of actions) action();
  }
}

/**
 * 本文の編集部品。packages/editor の Live Preview を React に載せる。
 *
 * EditorView は mount で 1 回だけ作り、再描画では作り直さない（作り直すと変換中の未確定文字が
 * 消える）。props の変化は、本文なら replaceDoc、readOnly なら Compartment の積み替えで届ける。
 *
 * onChange は変換中の未確定文字を含む入力でも呼ぶ。textarea と同じく、保存と退避が常に画面の
 * 文字を写すようにするためで、変換中にタブが隠れても未確定文字まで退避に残る。
 */
export function BodyEditor({
  value,
  onChange,
  onBlur,
  readOnly = false,
  pageIndex,
  linkTargets,
  ref,
}: BodyEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const dispatcher = useRef<SettledDispatcher | null>(null);
  const mode = useRef(new Compartment());

  // EditorView の listener は作ったときに 1 度だけ結ぶので、最新の props は ref から読む
  const latest = useRef({ value, onChange, onBlur, readOnly, pageIndex, linkTargets });
  latest.current = { value, onChange, onBlur, readOnly, pageIndex, linkTargets };

  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const initial = latest.current;
    let created: EditorView | null = null;
    const editor = createEditor(parent, {
      doc: initial.value,
      extensions: [
        mode.current.of(modeExtensions(initial.readOnly)),
        completionExtensions(initial.pageIndex, initial.linkTargets),
        EditorView.contentAttributes.of({ "aria-label": "本文" }),
        EditorView.domEventHandlers({
          blur: () => {
            latest.current.onBlur?.();
            return false;
          },
        }),
      ],
      onUpdate: (update) => {
        dispatcher.current?.update(update);
        if (!update.docChanged) return;
        const doc = update.state.doc.toString();
        if (update.transactions.some((tr) => tr.docChanged && !isDocReplacement(tr))) {
          latest.current.onChange?.(doc);
          return;
        }
        // 差し替えを保留している間に持ち主の本文が先へ進んでいれば（保留中の入力を持ち主が受け取った
        // など）、適用した差し替えは古い。持ち主の本文に合わせ直す
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
    dispatcher.current = new SettledDispatcher(editor);
    return () => {
      dispatcher.current?.destroy();
      dispatcher.current = null;
      view.current = null;
      editor.destroy();
    };
  }, []);

  // useLayoutEffect にするのは、持ち主の状態が変わってから次の入力が届く前に、エディタへ反映するため
  useLayoutEffect(() => {
    const editor = view.current;
    const settled = dispatcher.current;
    if (editor === null || settled === null) return;
    settled.run("mode", () => {
      editor.dispatch({ effects: mode.current.reconfigure(modeExtensions(readOnly)) });
      if (readOnly) closeCompletion(editor);
      // 変換中に持ち主が読み取り専用になると、その後に確定した文字は持ち主に受け取られない。
      // 積み替えと一緒に持ち主の本文へ戻す
      replaceDoc(editor, latest.current.value);
    });
  }, [readOnly]);

  // doc と同じ value でも replaceDoc に渡す。変換中は保留した差し替えを最後の value で上書きさせ、
  // 途中の値（A → S → A の S）を落ち着いた後に一度入れることを防ぐ。doc と同じ本文の適用は
  // replaceDoc が何もしない
  useLayoutEffect(() => {
    const editor = view.current;
    if (editor === null) return;
    replaceDoc(editor, value);
  }, [value]);

  useImperativeHandle(ref, () => ({
    jumpTo(offset) {
      const editor = view.current;
      const settled = dispatcher.current;
      if (editor === null || settled === null) return;
      settled.run("jump", () => {
        const at = Math.min(offset, editor.state.doc.length);
        editor.dispatch({ selection: EditorSelection.cursor(at), scrollIntoView: true });
        editor.focus();
      });
    },
  }));

  return <div ref={host} className="body-editor" />;
}
