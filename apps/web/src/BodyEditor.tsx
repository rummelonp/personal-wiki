import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  createEditor,
  dispatchWhenSettled,
  invalidateDecorations,
  isDocReplacement,
  type LinkTargetSource,
  type PageEmbedContent,
  type PageIndex,
  replaceDoc,
  setReadOnly,
  type WikiLinkClick,
} from "@personal-wiki/editor";
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { WikiLinkSources } from "./wiki-links";

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
  /**
   * wikilink の存在の印と `![[ページ]]` の展開の取得元。渡すと印と embed が働く。
   * 作った時点のものを使い続けるので、ページが変わるときは BodyEditor ごと作り直す。
   */
  links?: WikiLinkSources;
  /**
   * wikilink と、展開した embed の title のクリック。渡したときだけ素のクリックで呼ぶ（作った時点で
   * 渡されているかを見る）。呼ぶ関数は最新のものを使う。
   */
  onWikiLinkClick?: (link: WikiLinkClick) => void;
  ref?: Ref<BodyEditorHandle>;
}

/** `links` が外れた後に残った embed の表示。取得元が無いので未解決として出す。 */
const NO_EMBED: PageEmbedContent = { kind: "unresolved" };

const jumpKey = Symbol("jumpTo");

/**
 * 本文の編集部品。packages/editor の Live Preview を React に載せる。
 *
 * EditorView は mount で 1 回だけ作り、再描画では作り直さない（作り直すと変換中の未確定文字が
 * 消える）。props の変化は、本文なら replaceDoc、readOnly なら setReadOnly で届ける。
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
  links,
  onWikiLinkClick,
  ref,
}: BodyEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  // EditorView の listener は作ったときに 1 度だけ結ぶので、最新の props は ref から読む
  const latest = useRef({
    value,
    onChange,
    onBlur,
    readOnly,
    pageIndex,
    linkTargets,
    links,
    onWikiLinkClick,
  });
  latest.current = {
    value,
    onChange,
    onBlur,
    readOnly,
    pageIndex,
    linkTargets,
    links,
    onWikiLinkClick,
  };

  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const initial = latest.current;
    let created: EditorView | null = null;
    const editor = createEditor(parent, {
      doc: initial.value,
      readOnly: initial.readOnly,
      // 補完は readOnly の間も積まれたままで、readOnly の間は候補を出さない（createEditor が担う）
      ...(initial.pageIndex === undefined ? {} : { pageIndex: initial.pageIndex }),
      ...(initial.linkTargets === undefined ? {} : { linkTargets: initial.linkTargets }),
      // resolvePageEmbed を渡すと `![[ページ]]` を展開する表示に変わるので、取得元があるときだけ渡す
      ...(initial.links === undefined
        ? {}
        : {
            resolveWikiLink: (target: string) =>
              latest.current.links?.resolveWikiLink(target) ?? true,
            resolvePageEmbed: (target: string) =>
              latest.current.links?.resolvePageEmbed(target) ?? NO_EMBED,
          }),
      ...(initial.onWikiLinkClick === undefined
        ? {}
        : { onWikiLinkClick: (link: WikiLinkClick) => latest.current.onWikiLinkClick?.(link) }),
      extensions: [
        EditorView.contentAttributes.of({ "aria-label": "本文" }),
        EditorView.domEventHandlers({
          blur: () => {
            latest.current.onBlur?.();
            return false;
          },
        }),
      ],
      onUpdate: (update) => {
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
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, []);

  // 取得が終わって印や embed の内容が変わったら、装飾を組み直させる。変換中は editor が保留する
  useEffect(() => {
    if (links === undefined) return;
    return links.subscribe(() => {
      const editor = view.current;
      if (editor !== null) invalidateDecorations(editor);
    });
  }, [links]);

  // useLayoutEffect にするのは、持ち主の状態が変わってから次の入力が届く前に、エディタへ反映するため
  useLayoutEffect(() => {
    const editor = view.current;
    if (editor === null) return;
    setReadOnly(editor, readOnly);
    // 変換中に持ち主が読み取り専用になると、切り替わるまでに確定した文字は持ち主に受け取られない。
    // 切り替えと同じく落ち着いてから、持ち主の本文へ戻す
    replaceDoc(editor, latest.current.value);
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
      if (editor === null) return;
      dispatchWhenSettled(editor, jumpKey, () => {
        const at = Math.min(offset, editor.state.doc.length);
        editor.dispatch({ selection: EditorSelection.cursor(at), scrollIntoView: true });
        editor.focus();
      });
    },
  }));

  return <div ref={host} className="body-editor" />;
}
