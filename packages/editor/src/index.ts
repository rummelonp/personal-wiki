/**
 * @packageDocumentation
 * CodeMirror 6 の Live Preview エディタ。React には依存しない。
 *
 * 色と書体はホストの CSS 変数から受け取るので、ホストは editor の祖先（通常は `:root`）に次を置く。
 * - 色: `--ui-color-background`、`-surface`、`-text`、`-muted`、`-border`、`-accent`、
 *   `-accent-soft`、`-on-accent`、`-danger`
 * - 書体: `--ui-font-body`、`--ui-font-heading`、`--ui-font-mono`
 * - 明暗の切り替え: ライトでは `--ui-light: initial; --ui-dark: ;`、ダークでは逆にする。
 *   editor の一部の色は `var(--ui-light, 明) var(--ui-dark, 暗)` の形で、`initial` にした側の
 *   値が残り、空にした側は消える。
 * - 任意（無ければ既定値）: `--ui-radius-sm`、`--ui-space-2`、`-3`、`-4`、`-6`
 *
 * 値の出発点は `test-tokens.ts` のテスト用ホストにある（`data-ui-scheme` と `--ui-editor-hue` は
 * そのホストの切り替え方で、editor 自身は読まない）。
 *
 * doc を外から差し替えるときは `view.dispatch` ではなく `replaceDoc` を使う（IME 不変条件 1）。
 * それ以外の外からの dispatch（selection の移動など）は `dispatchWhenSettled` を通す。
 */
export type { EditorView, ViewUpdate } from "@codemirror/view";
export {
  attachmentUpload,
  type UploadAttachment,
  type UploadedAttachment,
} from "./attachment-upload";
export { assignBlockId, generateBlockId, revealBlockId } from "./block-id";
export { type CreateEditorOptions, createEditor } from "./create-editor";
export { imeDebug } from "./debug-ime";
export {
  type BuiltDecorations,
  type DecorationBuilder,
  decorationPlugin,
  invalidateDecorations,
} from "./decoration-plugin";
export {
  type AttachmentUrlResolver,
  embeds,
  type PageBodyRenderer,
  type PageEmbedContent,
  type PageEmbedOptions,
  type PageEmbedResolver,
  type RenderedPageBody,
} from "./embed";
export {
  compositionSettled,
  type ImeEvent,
  type ImeEventKind,
  imeEventSink,
  isComposing,
  isCompositionUnsettled,
} from "./ime";
export { livePreview } from "./live-preview";
export {
  createPageEmbedCache,
  type PageEmbedCache,
  type PageEmbedCacheOptions,
  type PageEmbedPage,
} from "./page-embed-cache";
export {
  createMemoryPageIndex,
  type MemoryPageIndexOptions,
  type PageCandidate,
  type PageIndex,
} from "./page-index";
export { setReadOnly } from "./read-only";
export { docReplacement, isDocReplacement, replaceDoc } from "./replace-doc";
export { createRevealTest, type RevealPolicy, revealPolicy, shouldRevealSource } from "./reveal";
export { dispatchWhenSettled } from "./settled-dispatch";
export { type TagClick, type TagClickHandler, tags } from "./tag";
export { type CreateTitleEditorOptions, createTitleEditor } from "./title-editor";
export {
  type WikiLinkClick,
  type WikiLinkClickHandler,
  type WikiLinkResolver,
  wikiLinkResolver,
  wikiLinks,
} from "./wikilink";
export {
  type LinkTargetSource,
  type WikiLinkAutocompleteOptions,
  wikiLinkAutocomplete,
  wikiLinkCompletionSource,
} from "./wikilink-autocomplete";
