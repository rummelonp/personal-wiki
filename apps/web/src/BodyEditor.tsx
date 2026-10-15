import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  type AcceptAttachment,
  type AttachmentUrlResolver,
  createEditor,
  dispatchWhenSettled,
  invalidateDecorations,
  isDocReplacement,
  type LinkTargetSource,
  type PageEmbedContent,
  type PageIndex,
  parseAhead,
  replaceDoc,
  revealBlockId,
  setReadOnly,
  type TagClick,
  type UploadAttachment,
  type WikiLinkClick,
} from "@personal-wiki/editor";
import { extractBlockIds, findHeadingOffset } from "@personal-wiki/markdown";
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { bodyScrollAnchor } from "./body-scroll-anchor";
import { NOTICE_DOCK_RESIZE, noticeDockRect } from "./notice-dock";
import type { PageFragment } from "./page-fragment";
import { tagHref } from "./route";
import { registerScrollAnchor } from "./scroll-restore";
import { scrollBelowStickyHeader } from "./sticky-header";
import type { WikiLinkSources } from "./wiki-links";

export interface BodyEditorHandle {
  /**
   * 本文の `offset` の行を画面の上の方に見えるまでスクロールする。編集部品に focus しない。
   * focus 中なら外す（読むために移るので、キーボードと Live Preview の記号を出さない）。
   */
  jumpTo: (offset: number) => void;
  /**
   * URL の fragment が指す見出しか block へ、`jumpTo` と同じく移る。見つからなければ何もしない。
   * block は対象の段落を一時的にハイライトする。
   */
  jumpToFragment: (fragment: PageFragment) => void;
  /**
   * IME の変換が落ち着いたら resolve する。落ち着いていればすぐに resolve する。
   * エディタを破棄したときも resolve する（待つ側が止まり続けないように）。
   */
  whenSettled: () => Promise<void>;
  /** title 欄の Enter と ↓ が移る先。破棄した後は null */
  view: () => EditorView | null;
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
   * wikilink の存在の印、リンクの URL、`![[ページ]]` の展開の取得元。渡すと印と embed が働く。
   * 作った時点のものを使い続けるので、ページが変わるときは BodyEditor ごと作り直す。
   */
  links?: WikiLinkSources;
  /**
   * wikilink と、展開した embed の title のクリック。渡したときだけ素のクリックで呼ぶ（作った時点で
   * 渡されているかを見る）。呼ぶ関数は最新のものを使う。
   */
  onWikiLinkClick?: (link: WikiLinkClick) => void;
  /**
   * 本文の `#tag` と frontmatter の tag の素のクリック（`onWikiLinkClick` と同じく、作った時点で
   * 渡されているかを見て、呼ぶ関数は最新のものを使う）。渡すと本文の `#tag` は tag の一覧を指す
   * `<a href>` になり、修飾クリックと中クリックで新しいタブなどに開ける。
   */
  onTagClick?: (tag: TagClick) => void;
  /**
   * 渡すと、貼り付けと drop の画像をアップロードする。作った時点のものを使い続ける。
   * 失敗の通知は渡す関数の中で行う（reject すると編集部品は placeholder を黙って除く）。
   */
  onUploadAttachment?: UploadAttachment;
  /** アップロードで受け付ける File の判定。`onUploadAttachment` と一緒に渡す（省略すると `image/*`） */
  acceptAttachment?: AcceptAttachment;
  /**
   * `![[画像]]` の URL。渡さないと画像は未解決として表示する。作った時点のものを使い続けるので、
   * ページが変わるときは BodyEditor ごと作り直す。
   */
  resolveAttachmentUrl?: AttachmentUrlResolver;
  /** 作った時点で 1 度だけ、エディタに focus する。ページを開いただけでキーボードを出さないため既定は立てない。 */
  autoFocus?: boolean;
  ref?: Ref<BodyEditorHandle>;
}

/** `links` が外れた後に残った embed の表示。取得元が無いので未解決として出す。 */
const NO_EMBED: PageEmbedContent = { kind: "unresolved" };

const jumpKey = Symbol("jumpTo");
const revealKey = Symbol("revealCaret");
const settledKey = Symbol("whenSettled");

/**
 * focus を外す。リンクや目次から見出しへ移るのは読むためで、focus が残ると iOS のキーボードが
 * 画面の半分を隠し、カーソルの行の Live Preview の記号（`## `）も現れる。
 * 続けて編集するには、本文をクリックかタップする。
 * focus を残してカーソルだけ別の所に置く案は、画面の外にカーソルがあるまま打てるので採らなかった。
 */
function leaveEditing(editor: EditorView): void {
  if (editor.hasFocus) editor.contentDOM.blur();
}

/** カーソルの行が、画面に見えていて、通知の台に重なっているか。描画の外（coords が無い）なら false。 */
function caretUnderNoticeDock(editor: EditorView): boolean {
  const dock = noticeDockRect();
  const caret = editor.coordsAtPos(editor.state.selection.main.head);
  if (dock === null || caret === null) return false;
  return caret.bottom > dock.top && caret.top < dock.bottom;
}

/**
 * `offset` の行を画面の上端の近くまでスクロールする。見出しへの移動は行頭が見えれば足りるわけ
 * ではなく、その先を読み進めるので、最小限のスクロールにはしない。
 * カーソルは行頭に置くが focus は取らない（focus の無い view は記法を隠すので、記号は出ない）。
 */
function moveTo(editor: EditorView, offset: number): void {
  const at = Math.min(offset, editor.state.doc.length);
  leaveEditing(editor);
  // 遠くの見出しへ移ると、背景の解析が追いつくまで Markdown の記号のまま見えるので、先に解析しておく
  parseAhead(editor, at);
  editor.dispatch({
    selection: EditorSelection.cursor(at),
    effects: EditorView.scrollIntoView(at, { y: "start", yMargin: 16 }),
  });
}

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
  onTagClick,
  onUploadAttachment,
  acceptAttachment,
  resolveAttachmentUrl,
  autoFocus = false,
  ref,
}: BodyEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  /** whenSettled を待っている resolve。破棄したときは dispatchWhenSettled が捨てるので、ここで呼ぶ */
  const settledWaiters = useRef<(() => void)[]>([]);

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
    onTagClick,
    onUploadAttachment,
    acceptAttachment,
    resolveAttachmentUrl,
    autoFocus,
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
    onTagClick,
    onUploadAttachment,
    acceptAttachment,
    resolveAttachmentUrl,
    autoFocus,
  };

  // 開く操作（flushSync）の中で autoFocus まで済ませるため、layout effect で作る。iOS の Safari は
  // 操作の中で focus した入力欄にだけキーボードを出す。後に続く readOnly と value の layout effect は、
  // 作った時点と同じ値なので何も dispatch しない
  useLayoutEffect(() => {
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
            hrefForWikiLink: (link: WikiLinkClick) => latest.current.links?.hrefFor(link) ?? null,
          }),
      ...(initial.onWikiLinkClick === undefined
        ? {}
        : { onWikiLinkClick: (link: WikiLinkClick) => latest.current.onWikiLinkClick?.(link) }),
      // href は修飾クリックと中クリックで新しいタブに開くためのもの。素のクリックの遷移先と同じ一覧を指す
      ...(initial.onTagClick === undefined
        ? {}
        : {
            onTagClick: (tag: TagClick) => latest.current.onTagClick?.(tag),
            hrefForTag: (tag: TagClick) => tagHref(tag.name),
          }),
      // 渡さなければ貼り付けと drop に触れない。どちらも作った時点のものを使い続ける
      ...(initial.onUploadAttachment === undefined
        ? {}
        : { onUploadAttachment: initial.onUploadAttachment }),
      ...(initial.acceptAttachment === undefined
        ? {}
        : { acceptAttachment: initial.acceptAttachment }),
      ...(initial.resolveAttachmentUrl === undefined
        ? {}
        : { resolveAttachmentUrl: initial.resolveAttachmentUrl }),
      extensions: [
        EditorView.contentAttributes.of({ "aria-label": "本文" }),
        scrollBelowStickyHeader,
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
    // 作った直後の 1 回だけ。focus は DOM の focus を移すだけで、doc や selection には dispatch しない
    if (initial.autoFocus && !initial.readOnly) editor.focus();
    const waiters = settledWaiters.current;
    const unregisterAnchor = registerScrollAnchor(bodyScrollAnchor(editor));
    return () => {
      unregisterAnchor();
      view.current = null;
      editor.destroy();
      for (const resolve of waiters.splice(0)) resolve();
    };
  }, []);

  // 通知の台が本文を覆う範囲が変わったとき、見えているカーソルが台に覆われたなら、台の上へスクロールで
  // 逃がす。上の方を読んでいる人を、画面の外のカーソルまで引き戻さないため、見えていない場合は動かさない。
  // 台の高さは scrollMargins が見る。selection と doc は変えず、変換中は落ち着くまで保留する
  useEffect(() => {
    const reveal = () => {
      const editor = view.current;
      if (editor === null || !editor.hasFocus) return;
      dispatchWhenSettled(editor, revealKey, () => {
        if (!caretUnderNoticeDock(editor)) return;
        editor.dispatch({
          effects: EditorView.scrollIntoView(editor.state.selection.main.head, { y: "nearest" }),
        });
      });
    };
    document.addEventListener(NOTICE_DOCK_RESIZE, reveal);
    return () => document.removeEventListener(NOTICE_DOCK_RESIZE, reveal);
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
      dispatchWhenSettled(editor, jumpKey, () => moveTo(editor, offset));
    },
    jumpToFragment(fragment) {
      const editor = view.current;
      if (editor === null) return;
      // 位置は動かす時点の本文で求める。変換が落ち着くまでに本文が変わっていても、その本文の位置に移る
      dispatchWhenSettled(editor, jumpKey, () => {
        if (fragment.kind === "block") {
          // focus を持ったまま selection を動かすと、iOS が native のカーソルへスクロールして
          // 中央への scroll を崩すので、見出しと同じく先に外す。見つからないリンクでは外さない
          const id = fragment.id;
          if (!extractBlockIds(editor.state.doc.toString()).some((ref) => ref.id === id)) return;
          leaveEditing(editor);
          revealBlockId(editor, id);
          return;
        }
        const offset = findHeadingOffset(editor.state.doc.toString(), fragment.heading);
        if (offset !== null) moveTo(editor, offset);
      });
    },
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
    view: () => view.current,
  }));

  return <div ref={host} className="body-editor" />;
}
