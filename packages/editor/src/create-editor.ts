import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Language } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  type KeyBinding,
  keymap,
  type ViewUpdate,
} from "@codemirror/view";
import { Autolink, type MarkdownParser } from "@lezer/markdown";
import {
  BlockId,
  Frontmatter,
  Highlight,
  ObsidianComment,
  ObsidianTaskList,
  Tag,
  WikiLink,
} from "@personal-wiki/markdown";
import { attachmentUpload, type UploadAttachment } from "./attachment-upload";
import { blockIdAssignment, blockIdHighlight } from "./block-id";
import { imeDebug } from "./debug-ime";
import {
  type AttachmentUrlResolver,
  embeds,
  expandedEmbedKinds,
  type PageEmbedOptions,
  type PageEmbedResolver,
} from "./embed";
import { externalLinks } from "./external-link";
import { activeLine, focusRing } from "./focus";
import { frontmatterBlock } from "./frontmatter-block";
import type { ImeEvent } from "./ime";
import { linkActivation } from "./link-activation";
import { listKeymap } from "./list-keymap";
import { livePreview } from "./live-preview";
import type { PageIndex } from "./page-index";
import { readOnlyCompartment } from "./read-only";
import { docReplacement, resettableHistory } from "./replace-doc";
import { type RevealPolicy, revealPolicy } from "./reveal";
import { tables } from "./table";
import { type TagClickHandler, tags } from "./tag";
import { taskList } from "./task-list";
import { codeHighlighting, editorSurfaceTheme, livePreviewTheme, typographyTheme } from "./theme";
import {
  type WikiLinkClickHandler,
  type WikiLinkHref,
  type WikiLinkResolver,
  wikiLinks,
} from "./wikilink";
import { type LinkTargetSource, wikiLinkAutocomplete } from "./wikilink-autocomplete";

// Frontmatter の wrap は最初にかかる必要がある（packages/markdown の frontmatter.ts）。
// markdown() の `extensions` に渡すと、lang-markdown が同じ configure で足す fenced code 用の
// wrap が内側に来るので、base の parser に先に configure しておく。markdown() が base から
// 使うのは parser だけ。
const markdownWithFrontmatter = new Language(
  markdownLanguage.data,
  (markdownLanguage.parser as MarkdownParser).configure(Frontmatter),
  [],
  "markdown",
);

// historyKeymap の undoSelection と redoSelection（Mod-u など）は state.readOnly を見ず、
// changeFilter も通さずに doc を戻す。readOnly の間に本文が戻らないよう、readOnly ではどれも動かさない。
const readOnlySafeHistoryKeymap: readonly KeyBinding[] = historyKeymap.map((binding) => {
  const run = binding.run;
  return run ? { ...binding, run: (view) => !view.state.readOnly && run(view) } : binding;
});

export interface CreateEditorOptions {
  /** 最初の本文。作った後に外から差し替えるときは `replaceDoc` を使う */
  readonly doc?: string;
  /** false で記法を隠さない（IME の不具合を Live Preview と切り分ける比較用）。既定 true */
  readonly livePreview?: boolean;
  readonly revealPolicy?: RevealPolicy;
  /** 渡したときだけ `[[` の autocomplete を有効にする */
  readonly pageIndex?: PageIndex;
  /**
   * `[[Title#` と `[[Title#^` で候補にする、他の page の見出しと block id の取得元。
   * `pageIndex` と一緒に渡したときだけ働く。今の page の `[[#` と `[[#^` は渡さなくても出る。
   */
  readonly linkTargets?: LinkTargetSource;
  readonly onWikiLinkClick?: WikiLinkClickHandler;
  /**
   * 渡したときだけ WikiLink を `<a href>` にする。素のクリックは `onWikiLinkClick` の
   * ままで、href は修飾クリック・中クリック・リンクのコピー・hover の遷移先表示に使う。
   */
  readonly hrefForWikiLink?: WikiLinkHref;
  /** 渡したときだけ unresolved link のスタイルを適用する */
  readonly resolveWikiLink?: WikiLinkResolver;
  readonly onTagClick?: TagClickHandler;
  /** 渡したときだけクリップボード貼り付け/ドラッグ&ドロップでの画像アップロードを有効にする */
  readonly onUploadAttachment?: UploadAttachment;
  /** `![[image.png]]` の画像の URL。渡さないと画像 embed は未解決として表示する */
  readonly resolveAttachmentUrl?: AttachmentUrlResolver;
  /**
   * `![[Title]]` の表示内容。渡したときだけページ embed を展開し、渡さないと WikiLink として表示する。
   * 展開した本文を描く view には渡さないので、埋め込んだ本文の中の embed は展開しない（1 段まで）。
   */
  readonly resolvePageEmbed?: PageEmbedResolver;
  /** 渡したときだけ IME の観測を有効にする */
  readonly onImeEvent?: (event: ImeEvent) => void;
  readonly onCompletionLatency?: (ms: number) => void;
  /**
   * CodeMirror の `history()` を使うか。既定 true。
   * 編集しない view（ページ embed の本文）や、undo を外で持つときは false にする。
   */
  readonly history?: boolean;
  /**
   * 基本構成の後段に足す extension。
   * 後段に置くので、同じ facet の値は基本構成より後に並ぶ。優先させたい keymap は
   * 呼び出し側で `Prec` を付けること。
   */
  readonly extensions?: Extension;
  /**
   * すべての `updateListener` の最後に呼ばれる。keypress latency の計測用で、
   * ここに届いた時点で decoration の構築は終わっている。
   */
  readonly onUpdate?: (update: ViewUpdate) => void;
  /**
   * true でこの EditorView への入力を止める。書き込みを拒む本当の境界はサーバー側で、
   * ここでの制御は UX 上の裏付け（保存されない編集を作らせない）にすぎない。
   * 作った後に権限が変わったら `setReadOnly` で切り替える（作り直すと変換中の文字が消える）。
   *
   * `EditorView.editable` は既定で true のままにする（false にすると `contenteditable` が
   * 外れて focus できなくなり、閲覧者がカーソルを置けず Live Preview の reveal（`reveal.ts`）も
   * 一生使えなくなる）。focus 自体を止めたい呼び出し元は `readOnlyFocusable: false` を渡す。
   *
   * `EditorState.readOnly` が拒むのは CodeMirror 自身の入力経路（コマンド、貼り付け、drop、
   * IME の確定）だけで、`EditorView.domEventHandlers` などで doc を直接書く自前の extension
   * には関与しない。そうした extension の doc の変更は changeFilter（`read-only.ts`）が落とすが、
   * アップロードのような変更の前の副作用は止まらないので、各自 `state.readOnly` を見て自分で拒む
   * （`attachment-upload.ts` の paste/drop、`block-id.ts` の `assignBlockId` はこれを見ている）。
   */
  readonly readOnly?: boolean;
  /**
   * readOnly な view を focus 可能にするか。既定 true。`options.readOnly` と併用したときだけ
   * 効き、`readOnly: false`（既定）のときは無視される。
   * ページ embed の中身を描く nested view だけ false にして focus できないようにする
   * （埋め込みのクリックで外側の view から focus が奪われ、記法表示や本文の縦位置が
   * 乱れるのを防ぐ。埋め込みを直接編集する経路は widget 右上の「編集」ボタンに絞り、
   * 本文自体はクリックできないままにする）。
   */
  readonly readOnlyFocusable?: boolean;
}

export function createEditor(parent: HTMLElement, options: CreateEditorOptions = {}): EditorView {
  const useHistory = options.history ?? true;
  const pageEmbeds = pageEmbedOptions(options);
  const extensions: Extension[] = [
    markdown({
      base: markdownWithFrontmatter,
      codeLanguages: languages,
      // ObsidianTaskList は markdownLanguage に入っている GFM の TaskList を置き換える
      extensions: [WikiLink, Tag, Autolink, BlockId, Highlight, ObsidianComment, ObsidianTaskList],
      completeHTMLTags: false,
    }),
    codeHighlighting,
    drawSelection(),
    EditorView.lineWrapping,
    useHistory ? resettableHistory() : [],
    keymap.of([...defaultKeymap, ...(useHistory ? readOnlySafeHistoryKeymap : [])]),
    listKeymap(),
    editorSurfaceTheme,
    typographyTheme,
    livePreviewTheme,
    focusRing(),
    activeLine(),
    wikiLinks(
      options.onWikiLinkClick,
      options.resolveWikiLink,
      expandedEmbedKinds(pageEmbeds),
      options.hrefForWikiLink,
    ),
    embeds(options.resolveAttachmentUrl, pageEmbeds),
    tags(options.onTagClick),
    externalLinks(),
    linkActivation(),
    blockIdAssignment(),
    blockIdHighlight(),
    docReplacement,
  ];
  // frontmatter を畳むのは記法を隠す表示なので、livePreview を切ったときは source のまま出す
  if (options.livePreview ?? true) {
    extensions.push(livePreview(), tables(), taskList(), frontmatterBlock());
  }
  if (options.revealPolicy) extensions.push(revealPolicy.of(options.revealPolicy));
  // readOnly でも積む。`setReadOnly` の切り替えのたびに積み外しすると、completionPlugin が
  // destroy で debounce の timer を止めないため、残った timer が外れた StateField を読んで
  // 例外を投げる（@codemirror/autocomplete 6.20 の dist/index.js、completionPlugin の accept）。
  // readOnly の間は source が候補を出さない。
  if (options.pageIndex) {
    extensions.push(
      wikiLinkAutocomplete({
        index: options.pageIndex,
        ...(options.linkTargets ? { linkTargets: options.linkTargets } : {}),
        ...(options.onCompletionLatency ? { onLatency: options.onCompletionLatency } : {}),
      }),
    );
  }
  if (options.onUploadAttachment) extensions.push(attachmentUpload(options.onUploadAttachment));
  if (options.onImeEvent) extensions.push(imeDebug(options.onImeEvent, "body"));
  extensions.push(readOnlyCompartment(options.readOnly ?? false));
  // editable の facet 既定値はすでに true なので、focus を許すだけなら何も足さない。
  // false にする（nested embed 用）ときだけ明示的に extension を積む。
  if (options.readOnly && options.readOnlyFocusable === false) {
    extensions.push(EditorView.editable.of(false));
  }
  if (options.extensions) extensions.push(options.extensions);
  // updateListener は登録順に呼ばれるので、計測用は必ず最後に置く
  if (options.onUpdate) extensions.push(EditorView.updateListener.of(options.onUpdate));

  return new EditorView({
    parent,
    state: EditorState.create({ doc: options.doc ?? "", extensions }),
  });
}

/**
 * ページ embed の本文は、埋め込み元と同じ記法の見え方になるよう、同じ装飾の読み取り専用 view に描く。
 * その view に `resolvePageEmbed` を渡さないことで、展開を 1 段に限る（循環参照もここで止まる）。
 * WikiLink の遷移と解決、添付の URL は埋め込み元のものを使う。埋め込み先は埋め込み元と
 * 同じ wiki の page なので、同じ解決で正しい。
 */
function pageEmbedOptions(options: CreateEditorOptions): PageEmbedOptions | undefined {
  const {
    resolvePageEmbed,
    onWikiLinkClick,
    hrefForWikiLink,
    resolveWikiLink,
    onTagClick,
    resolveAttachmentUrl,
  } = options;
  if (!resolvePageEmbed) return undefined;
  return {
    resolve: resolvePageEmbed,
    render: (parent, text, onResize) =>
      createEditor(parent, {
        doc: text,
        readOnly: true,
        readOnlyFocusable: false,
        history: false,
        ...(options.livePreview === undefined ? {} : { livePreview: options.livePreview }),
        ...(onWikiLinkClick ? { onWikiLinkClick } : {}),
        ...(hrefForWikiLink ? { hrefForWikiLink } : {}),
        ...(resolveWikiLink ? { resolveWikiLink } : {}),
        ...(onTagClick ? { onTagClick } : {}),
        ...(resolveAttachmentUrl ? { resolveAttachmentUrl } : {}),
        extensions: EditorView.updateListener.of((update) => {
          if (update.geometryChanged) onResize();
        }),
      }),
    ...(onWikiLinkClick
      ? { open: (target: string) => onWikiLinkClick({ target, label: null, blockId: null }) }
      : {}),
  };
}
