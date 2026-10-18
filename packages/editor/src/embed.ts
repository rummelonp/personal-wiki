import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  type EditorState,
  type Extension,
  Facet,
  type Range,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { Tree } from "@lezer/common";
import {
  type EmbedKind,
  embedKindOf,
  type ImageEmbedLabel,
  isEmbedWikiLink,
  type MediaEmbedKind,
  parseImageEmbedLabel,
  splitWikiLinkContent,
  type WikiLinkParts,
  wikiLinkNodes,
} from "@personal-wiki/markdown";
import { isUploadingTarget, uploadsChanged } from "./attachment-upload";
import {
  type BuiltDecorations,
  decorationPlugin,
  registerNestedInvalidator,
} from "./decoration-plugin";
import { ALLOWED_SCHEMES, schemeOf } from "./external-link";
import { isCompositionUnsettled } from "./ime";
import { linkSyntaxParts } from "./link-syntax";
import { createRevealTest } from "./reveal";
import { SectionContents } from "./section-content";
import { createDraftBadge, draftBadgeTheme, type WikiLinkDraftTest } from "./wikilink";

/**
 * 添付のファイル名（`![[filename]]` の target）から、ブラウザが読む URL を返す。
 *
 * 同期で返す。decoration の構築は同期で、ネットワークを待てない。
 * URL は認可を通す経路（API の attachment 解決）を指すだけでよく、添付が実在するかは
 * ブラウザがその URL を読んだ結果で分かる。読めなければ未解決として表示する。
 * null は URL を作れないことを表し、これも未解決として表示する。
 *
 * `embedTarget` は、ページ embed の本文の中に書かれた添付のとき、その埋め込み先の title
 * （埋め込み元に書かれたまま）。添付の配信 URL はページ単位で、埋め込み先のページが参照している
 * 添付だけを返すので、埋め込み先のページで解決するために渡す。ページ自身の本文では undefined。
 */
export type AttachmentUrlResolver = (filename: string, embedTarget?: string) => string | null;

const attachmentUrlResolver = Facet.define<AttachmentUrlResolver, AttachmentUrlResolver | null>({
  combine: (values) => values[0] ?? null,
});

/**
 * ページ embed（`![[Title]]`）の表示内容。
 *
 * - `loading`：取得中。取得に失敗して再試行を待つ間もこれで、`unresolved` にはしない
 * - `resolved`：埋め込み先の現在の title と本文
 * - `unresolved`：page が無い、または閲覧者に読めない。どちらなのかは閲覧者に区別させない
 *   （非公開 page の存在を漏らさない）ので、ここにも理由を持たせない
 * - `self`：埋め込み元の page 自身。展開しない（自分自身の展開は無限に入れ子になる）
 */
export type PageEmbedContent =
  | { readonly kind: "loading" }
  | { readonly kind: "resolved"; readonly title: string; readonly text: string }
  | { readonly kind: "unresolved" }
  | { readonly kind: "self" };

/**
 * target（`![[Title]]` の Title）の表示内容を同期で返す。取得はホストが裏で行い、内容が
 * 変わったら `invalidateDecorations` で組み直させる（`createPageEmbedCache` がその実装）。
 * 内容が変わらない間は同じオブジェクトを返すこと。widget はオブジェクトの同一性で DOM を
 * 使い回すので、毎回新しいオブジェクトを返すと、組み直しのたびに本文の view を作り直す。
 */
export type PageEmbedResolver = (target: string) => PageEmbedContent;

export interface RenderedPageBody {
  destroy(): void;
  /**
   * 外側の editor で `invalidateDecorations` が呼ばれたときに呼ぶ。本文の view が、外側と同じ
   * 外部データ（wikilink の存在など）に依存する装飾を組み直すために使う。
   */
  invalidate?(): void;
}

/**
 * 埋め込み先の本文を `parent` に描き、描いたものの後始末を返す。`onResize` は描いた本文の
 * 高さが変わったときに呼ぶ。create-editor が読み取り専用の EditorView を作る関数を渡す
 * （この extension が create-editor を import すると循環する）。
 * `target` は埋め込み先を指す、埋め込み元に書かれたままの title。本文中の `[[#見出し]]` のように
 * target を省いた link が、埋め込み元ではなく埋め込み先のページを指すために使う。
 */
export type PageBodyRenderer = (
  parent: HTMLElement,
  text: string,
  onResize: () => void,
  target: string,
) => RenderedPageBody;

export interface PageEmbedOptions {
  readonly resolve: PageEmbedResolver;
  readonly render: PageBodyRenderer;
  /** title（未解決なら target）のクリックで呼ぶ。無ければクリックで何もしない */
  readonly open?: (target: string) => void;
  /**
   * 渡したときだけ、解決先が draft の embed のタイトルに「下書き」の印を付ける。
   * 展開した embed は widget に置き換わり、WikiLink の装飾（と印）が付かないための代わり。
   * embed の target は `WikiLinkResolver` に渡らないので、host は解決先の取得をこの中で始める。
   */
  readonly isDraft?: WikiLinkDraftTest;
}

const MEDIA_EMBED_KINDS: ReadonlySet<EmbedKind> = new Set<EmbedKind>(["image", "video"]);
const ALL_EMBED_KINDS: ReadonlySet<EmbedKind> = new Set<EmbedKind>(["image", "video", "page"]);

/**
 * `embeds(resolveUrl, page)` が widget に置き換える embed の種類。`wikilink` extension に同じ値を
 * 渡し、ここに入る種類を装飾させない。
 */
export function expandedEmbedKinds(page: PageEmbedOptions | undefined): ReadonlySet<EmbedKind> {
  return page ? ALL_EMBED_KINDS : MEDIA_EMBED_KINDS;
}

const TARGET_ATTR = "data-embed-target";
const STATE_ATTR = "data-embed-state";
/** 読み込んだ画像の描いた高さが 1 行以下のときに wrapper に付く */
const COMPACT_ATTR = "data-embed-compact";
/**
 * 行にその embed しか無いとき（block の接頭辞と空白は除く）に wrapper に付く。上下の余白を取る目印。
 * 文の中の embed は行を広げない。
 */
const BLOCK_CLASS = "cm-embed-block";

/**
 * 空白の無い名前の幅がこれを超えると、375px の幅の本文（約 335px）に 1 行で入らない。
 * 幅は、半角を 1、それ以外を 2 として数える（16px の書体で半角は約 8px、全角は約 16px）。
 */
const LONG_NAME_WIDTH = 40;

function nameWidth(name: string): number {
  let width = 0;
  for (const char of name) width += char.charCodeAt(0) < 0x80 ? 1 : 2;
  return width;
}

/** 折り返せる位置が無く、行に入りきらない名前。空白があれば、そこで折り返せる */
function isLongName(name: string): boolean {
  return !/\s/.test(name) && nameWidth(name) > LONG_NAME_WIDTH;
}

function nameElement(className: string, target: string): HTMLElement {
  const element = document.createElement("span");
  element.className = className;
  if (isLongName(target)) element.classList.add("cm-embed-long-name");
  element.textContent = target;
  return element;
}

/**
 * 名前だけを描く widget の中身。編集ボタンを重ねる余地が無いので、ボタンは名前の下に出す
 * （`embedTheme`）。
 */
const TEXT_ONLY_NAMES = [".cm-embed-unresolved", ".cm-embed-page-pending", ".cm-embed-page-self"];

function unresolvedElement(target: string): HTMLElement {
  return nameElement("cm-embed-unresolved", target);
}

/**
 * `<img src>` に許可する scheme。`ALLOWED_SCHEMES` は外部リンクのクリック（新規タブで開く）用の
 * allowlist で `mailto:` を含むが、`<img src="mailto:...">` は画像を読み込めず、ナビゲーションと
 * 画像読み込みで許可基準を分ける理由が無いのに `mailto:` だけ意味を持たないまま許可してしまう。
 * 画像は `ALLOWED_SCHEMES` から `mailto:` を除いた部分集合に限る。
 */
const IMAGE_ALLOWED_SCHEMES: ReadonlySet<string> = new Set(
  [...ALLOWED_SCHEMES].filter((scheme) => scheme !== "mailto:"),
);

/**
 * `rawUrl` が同一 origin の絶対パス（`/help/foo.png` のように `/` 1 つから始まり `//` ではないもの）かを
 * 判定する。文字列の見た目だけで `/` 1 つから始まり `//` でないことを見ると、`/\evil.example/a.png` のように
 * `\` を混ぜたものが崩れる（URL 仕様は特別 scheme で `\` を `/` と同じに扱うため、ブラウザは
 * `//evil.example/a.png` と同じ protocol-relative URL として host を `evil.example` に解決する）。
 * `new URL` に実際に解決させ、結果の origin で判定することでこれを避ける。
 */
function isSameOriginAbsolutePath(rawUrl: string): boolean {
  if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) return false;
  if (typeof location === "undefined") return false;
  try {
    return new URL(rawUrl, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * markdown 標準の画像記法（`![alt](url)`）の URL を `<img src>` にそのまま使ってよいか判定する。
 * scheme の扱いは `IMAGE_ALLOWED_SCHEMES`（`javascript:`/`data:` などを拒否）に限る。
 * 同一 origin の絶対パスは scheme を持たないので別枠で許可する。
 * 許可できない URL は widget を作らせず、呼び出し側は記法をそのまま source として見せる。
 */
function markdownImageSrc(rawUrl: string): string | null {
  if (isSameOriginAbsolutePath(rawUrl)) return rawUrl;
  const scheme = schemeOf(rawUrl);
  return scheme && IMAGE_ALLOWED_SCHEMES.has(scheme) ? rawUrl : null;
}

function sameLabel(a: ImageEmbedLabel, b: ImageEmbedLabel): boolean {
  if (a.kind === "size" && b.kind === "size") return a.width === b.width && a.height === b.height;
  if (a.kind === "alt" && b.kind === "alt") return a.text === b.text;
  return a.kind === b.kind;
}

class ImageEmbedWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly src: string | null,
    readonly label: ImageEmbedLabel,
    readonly block: boolean,
  ) {
    super();
  }

  // カーソル移動のたびに decoration は組み直されるが、ここが true なら DOM を作り直さず、
  // 画像の再読み込み（と、それに伴う行の高さの揺れ）が起きない。
  override eq(other: WidgetType): boolean {
    return (
      other instanceof ImageEmbedWidget &&
      other.target === this.target &&
      other.src === this.src &&
      other.block === this.block &&
      sameLabel(other.label, this.label)
    );
  }

  // 既定の true のままだが、編集ボタンを足した以上ここに書いて明示する。false にすると
  // ボタンの外側のクリックで editor がカーソルを embed に置き、画像を選ぶたびに source が重なって出る。
  override ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-embed cm-embed-image";
    wrapper.setAttribute(TARGET_ATTR, this.target);
    if (this.src === null) {
      wrapper.append(unresolvedElement(this.target));
      appendEditButton(wrapper, view, this.target);
      return wrapper;
    }

    if (this.block) wrapper.classList.add(BLOCK_CLASS);
    const img = document.createElement("img");
    img.alt = this.label.kind === "alt" ? this.label.text : this.target;
    // markdown image（`![alt](url)`）は任意の host の URL を描くので、読み込みリクエストで
    // 埋め込み元ページの URL を相手に渡さない（外部画像は許容するが、リンク元は渡さない）。
    // 添付の画像には不要だが、widget を共有するのでどちらの src にも同じ属性を付ける。
    img.referrerPolicy = "no-referrer";
    // widget は画面内の decoration の範囲にしか作らないが、editor 自体が画面外（下方向）にあると
    // 作られた直後にはまだ描画領域の外なことがある。本文を開いただけで全画像を一斉に取得しない。
    img.loading = "lazy";
    // 属性でなく inline style で指定する。ホストの CSS reset（Tailwind の preflight など）が
    // `img { height: auto }` を当てると、height 属性は上書きされて `|300x200` の高さが消える。
    if (this.label.kind === "size") {
      img.style.width = `${this.label.width}px`;
      if (this.label.height !== null) img.style.height = `${this.label.height}px`;
    }
    // widget の内側の DOM 変化は CodeMirror が読まない（DOMObserver が widget の mutation を
    // 捨てる）ので、ここでの差し替えは transaction にならず、composition 中でも IME を乱さない。
    // 行の高さが変わるので、測り直しだけを頼む（dispatch ではない）。
    // 描いた高さが 1 行以下なら、source を重ねずに流れへ戻す印を付ける（embedTheme）。
    // 読み込んだときの幅で決めるので、後から editor の幅が変わっても付け直さない。
    img.addEventListener("load", () =>
      view.requestMeasure({
        read: () =>
          img.isConnected ? img.getBoundingClientRect().height <= view.defaultLineHeight : null,
        write: (compact) => {
          if (compact !== null) wrapper.toggleAttribute(COMPACT_ATTR, compact);
        },
      }),
    );
    img.addEventListener("error", () => {
      img.replaceWith(unresolvedElement(this.target));
      wrapper.classList.remove(BLOCK_CLASS);
      view.requestMeasure();
    });
    img.src = this.src;
    wrapper.append(img);
    appendEditButton(wrapper, view, this.target);
    return wrapper;
  }
}

/** この view でアップロード中の仮の記法（attachment-upload.ts）を、仮のファイル名の代わりに描く表示 */
class UploadingEmbedWidget extends WidgetType {
  constructor(readonly target: string) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof UploadingEmbedWidget && other.target === this.target;
  }

  // 他の embed の widget と同じく、クリックを editor に渡さず source を出さない
  override ignoreEvent(): boolean {
    return true;
  }

  // 編集ボタンは付けない。仮の記法はアップロードの完了で置き換わるので、書き換える先にならない
  toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-embed cm-embed-image";
    wrapper.setAttribute(TARGET_ATTR, this.target);
    const label = document.createElement("span");
    label.className = "cm-embed-uploading";
    label.textContent = "画像を添付中…";
    wrapper.append(label);
    return wrapper;
  }
}

class VideoEmbedWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly src: string | null,
    readonly block: boolean,
  ) {
    super();
  }

  // eq が true なら DOM を作り直さないので、カーソル移動で再生位置が失われない
  override eq(other: WidgetType): boolean {
    return (
      other instanceof VideoEmbedWidget &&
      other.target === this.target &&
      other.src === this.src &&
      other.block === this.block
    );
  }

  // 既定の true のまま明示する。false にすると再生ボタンのクリックで editor がカーソルを
  // embed に置き、動画を操作するたびに source が重なって出る。
  override ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-embed cm-embed-video";
    wrapper.setAttribute(TARGET_ATTR, this.target);
    if (this.src === null) {
      wrapper.append(unresolvedElement(this.target));
      appendEditButton(wrapper, view, this.target);
      return wrapper;
    }

    if (this.block) wrapper.classList.add(BLOCK_CLASS);
    const video = document.createElement("video");
    video.controls = true;
    // 本文を開いただけで動画本体を読み始めない。大きさと長さが分かれば足りる
    video.preload = "metadata";
    video.setAttribute("aria-label", this.target);
    // 画像と同じく widget の内側の DOM 変化は transaction にならない。測り直しだけを頼む
    video.addEventListener("loadedmetadata", () => view.requestMeasure());
    video.addEventListener("error", () => {
      video.replaceWith(unresolvedElement(this.target));
      wrapper.classList.remove(BLOCK_CLASS);
      view.requestMeasure();
    });
    video.src = this.src;
    wrapper.append(video);
    // ボタンは右上、`<video controls>` の操作バーは下端なので重ならない
    appendEditButton(wrapper, view, this.target);
    return wrapper;
  }
}

/** PageEmbedWidget の DOM ごとの、描いた本文の後始末 */
const renderedBodies = new WeakMap<HTMLElement, RenderedPageBody>();

class PageEmbedWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly content: PageEmbedContent,
    readonly page: PageEmbedOptions,
    readonly draft: boolean,
  ) {
    super();
  }

  // 内容のオブジェクトが同じなら DOM（本文の view）を使い回す。カーソル移動や入力のたびに
  // 本文の view を作り直さないためで、大きな本文を埋め込んでも打鍵ごとの費用が増えない。
  override eq(other: WidgetType): boolean {
    return (
      other instanceof PageEmbedWidget &&
      other.target === this.target &&
      other.content === this.content &&
      other.page === this.page &&
      other.draft === this.draft
    );
  }

  // 既定の true のまま明示する。false にすると本文のクリックで外側の editor がカーソルを
  // embed に置き、本文を選ぶたびに source が重なって出る。本文の中のリンクも押せなくなる。
  override ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const { content } = this;
    const wrapper = document.createElement("span");
    wrapper.className = "cm-embed cm-embed-page";
    wrapper.setAttribute(TARGET_ATTR, this.target);
    wrapper.setAttribute(STATE_ATTR, content.kind);

    switch (content.kind) {
      case "loading": {
        const label = this.link(this.target);
        label.classList.add("cm-embed-page-pending");
        this.appendDraftBadge(label);
        wrapper.append(label);
        appendEditButton(wrapper, view, this.target);
        break;
      }
      case "unresolved": {
        const label = unresolvedElement(this.target);
        this.makeOpenable(label);
        wrapper.append(label);
        appendEditButton(wrapper, view, this.target);
        break;
      }
      case "self": {
        const label = this.link(this.target);
        label.classList.add("cm-embed-page-self");
        label.title = "このページ自身は埋め込めません";
        wrapper.append(label);
        appendEditButton(wrapper, view, this.target);
        break;
      }
      case "resolved": {
        // 本文には、外側の editor と同じ widget を内部で持つ nested EditorView が入る。ボタンを
        // 他の状態と同じく widget（.cm-embed）直下に position: absolute で重ねるには、この
        // widget 自身にも position: relative が要る（embedTheme）。しかし本文を持つ resolved
        // だけは、その position: relative そのものが nested view の ResizeObserver によるレイアウト
        // 測定を乱し、source を重ねている間の IME 変換で変換中の文字の text node を差し替える
        // （IME 不変条件 1 違反）。ボタンを本文と同じ重なりに置かず、タイトル行の中に flex で
        // 並べることで、resolved の widget に position を一切持たせずに済ませる
        // （embedTheme の `.cm-embed-page:not([data-embed-state="resolved"])` 参照）。
        const titleRow = document.createElement("span");
        titleRow.className = "cm-embed-page-header";
        const title = this.link(content.title);
        title.classList.add("cm-embed-page-title");
        this.appendDraftBadge(title);
        titleRow.append(title);
        // titleRow は wrapper（widget の root）の内側の要素なので、reveal 判定に使う root は
        // 明示的に wrapper を渡す（appendEditButton の doc comment 参照）
        appendEditButton(titleRow, view, this.target, wrapper);
        const body = document.createElement("span");
        body.className = "cm-embed-page-body";
        // 本文の高さが変わっても外側の editor には transaction にならない（widget の内側の
        // DOM 変化は読まれない）。行の高さの測り直しだけを頼む。画像の読み込み完了と同じ扱い。
        const rendered = this.page.render(
          body,
          content.text,
          () => view.requestMeasure(),
          this.target,
        );
        const unregister = rendered.invalidate
          ? registerNestedInvalidator(view, rendered.invalidate.bind(rendered))
          : () => {};
        renderedBodies.set(wrapper, {
          destroy: () => {
            unregister();
            rendered.destroy();
          },
        });
        wrapper.append(titleRow, body);
        break;
      }
    }
    return wrapper;
  }

  // 下書きの印だけが変わるときは、印を足し引きして DOM を使い回す。title の解決が本文より
  // 後に届く場合や公開範囲を切り替えた場合に作り直すと、本文の入れ子の view が壊れ、
  // 本文で選んでいた範囲が消える。
  override updateDOM(dom: HTMLElement, _view: EditorView, from: WidgetType): boolean {
    if (
      !(from instanceof PageEmbedWidget) ||
      from.target !== this.target ||
      from.content !== this.content ||
      from.page !== this.page
    ) {
      return false;
    }
    const host = dom.querySelector(
      ":scope > .cm-embed-page-pending, :scope > .cm-embed-page-header > .cm-embed-page-title",
    );
    if (!host) return true;
    const badge = host.querySelector(":scope > .cm-wikilink-draft-badge");
    if (this.draft && !badge) host.append(createDraftBadge());
    else if (!this.draft) badge?.remove();
    return true;
  }

  override destroy(dom: HTMLElement): void {
    renderedBodies.get(dom)?.destroy();
    renderedBodies.delete(dom);
  }

  // 印はタイトルの要素の中に置く。タイトル行では title が残り幅いっぱいに広がるので、外に並べると
  // 編集ボタン側へ離れる。
  private appendDraftBadge(element: HTMLElement): void {
    if (this.draft) element.append(createDraftBadge());
  }

  private link(text: string): HTMLElement {
    const element = nameElement("", text);
    this.makeOpenable(element);
    return element;
  }

  // 遷移先は WikiLink のクリックと同じく target で決める（alias 経由でも同じ page に着く）。
  // ignoreEvent が true なので、外側の editor の WikiLink のクリック処理はここに届かない。
  private makeOpenable(element: HTMLElement): void {
    const { open } = this.page;
    if (!open) return;
    element.classList.add("cm-embed-page-link");
    element.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      open(this.target);
    });
  }
}

/**
 * view ごとのセクション embed の表示内容。取得は page 単位のまま（同じ page の見出し違いは
 * 1 回の取得を分け合う）で切り出しは client で行うので、認可の経路はページ embed と変わらない。
 */
const sectionContents = new WeakMap<EditorView, SectionContents>();

type MediaWidgetFactory = (
  state: EditorState,
  parts: WikiLinkParts,
  resolveUrl: AttachmentUrlResolver | null,
  block: boolean,
) => WidgetType;

/**
 * 添付の種類ごとの widget。種類は `@personal-wiki/markdown` の `embedKindOf` が決める。
 * `MediaEmbedKind` に種類を足すと、ここに widget が無い限り型検査で落ちる。
 */
const mediaWidgetFactories: { readonly [K in MediaEmbedKind]: MediaWidgetFactory } = {
  image: (state, parts, resolveUrl, block) =>
    isUploadingTarget(state, parts.target)
      ? new UploadingEmbedWidget(parts.target)
      : new ImageEmbedWidget(
          parts.target,
          resolveUrl ? resolveUrl(parts.target) : null,
          parseImageEmbedLabel(parts.label),
          block,
        ),
  // `|` より後ろは読まない。Obsidian の help は動画のサイズ指定を定めていない
  video: (_state, parts, resolveUrl, block) =>
    new VideoEmbedWidget(parts.target, resolveUrl ? resolveUrl(parts.target) : null, block),
};

/** widget を組んだときの記法の文字列（`!` から `]]` まで） */
const widgetSources = new WeakMap<WidgetType, string>();

/**
 * `pos` から始まる embed の記法の終わり（`]]` または `)` の直後）を、`build` と同じ
 * Image／`!` 付き WikiLink の判定で求める。記法を隠している（`Decoration.replace`）間、
 * `editEmbedSource` はここで終わりを引き直す。
 */
function embedEndAt(state: EditorState, pos: number): number | null {
  const tree = syntaxTree(state);
  let to: number | null = null;
  tree.iterate({
    from: pos,
    to: Math.min(state.doc.length, pos + 2),
    enter: (node) => {
      if (to !== null) return false;
      if (node.name === "Image" && node.from === pos) {
        const parts = linkSyntaxParts(node.node, state.doc);
        if (parts && markdownImageSrc(parts.url) !== null) to = node.to;
        return false;
      }
      if (node.name === wikiLinkNodes.link && node.from === pos + 1) {
        if (!isEmbedWikiLink(state.doc.sliceString(pos, node.from))) return true;
        const parts = splitWikiLinkContent(state.doc.sliceString(node.from + 2, node.to - 2));
        if (parts && embedKindOf(parts) !== null) to = node.to;
        return false;
      }
      return true;
    },
  });
  return to;
}

/**
 * 編集ボタンから、embed の記法の終わり（閉じ括弧の直前）へカーソルを移す。
 *
 * widget は `WidgetType.eq` が真な限り同じ DOM が使い回され、その間 `widgetSources` の
 * 文字列は更新されない。alias を足す（`![[Note]]` → `![[Note|別名]]`）、前後の空白が trim
 * される（`splitWikiLinkContent`）などで `eq` が見ないフィールドだけが変わると、押した時点には
 * 記法の文字列がすでに違うので、キャッシュした文字列の長さから終わりを計算すると位置がずれる
 * （doc 先頭の embed では負の位置になり例外にもなる）。widget の from/to をフィールドに
 * 持たせていないのも同じ理由（doc が変わった後も同じ widget が eq で使い回される）で、
 * 範囲は押した時点の state と DOM から都度求め直す。
 *
 * `posAtDOM` は widget（`WidgetType`）の DOM を渡すと、その内部のどの要素を渡しても widget の
 * tile 自身の開始位置しか返さない（`WidgetType` の DOM の中に位置の粒度が無い）。widget は、
 * 記法を隠している間（`Decoration.replace`）は記法全体の先頭に、source を重ねている間
 * （`Decoration.widget`、side: -1）は記法の直後（＝終わりの位置）に置かれるので、この 1 点だけで
 * 「隠している間の先頭」と「出している間の終わり」の両方が求まる。ただし同じ記法の embed が
 * 隣接すると（`![[a.png]]![[a.png]]`）、前者の終わり（出している間）と後者の先頭（隠れている間）が
 * 同じ位置になり、値だけでは押したのがどちらの widget かを区別できない。source を重ねている間は
 * widget の直前の兄弟が記法を重ねた mark（`cm-embed-source`）になるので、この兄弟の有無を先に見て
 * 「出している」かどうかを判定する。出ていれば `wrapper` 自身への `posAtDOM` がそのまま終わりに
 * なり、隣の embed の先頭と衝突しない。隠れている場合だけ、得られた先頭から syntaxTree を引いて
 * 終わりを求める。
 */
function editEmbedSource(view: EditorView, wrapper: HTMLElement): void {
  // 確定文字列を読み込む前に dispatch すると確定文字列が消える（IME 不変条件 1）
  if (isCompositionUnsettled(view)) return;
  const overlay = wrapper.previousElementSibling;
  let to: number;
  if (overlay?.classList.contains("cm-embed-source")) {
    to = view.posAtDOM(wrapper);
  } else {
    const from = view.posAtDOM(wrapper);
    const end = embedEndAt(view.state, from);
    if (end === null) return;
    to = end;
  }
  const closingLength = view.state.doc.sliceString(to - 1, to) === ")" ? 1 : 2;
  view.dispatch({ selection: EditorSelection.cursor(to - closingLength), scrollIntoView: true });
  view.focus();
}

/**
 * embed の widget の右上に「記法を編集」ボタンを足す。押すと source を反転表示させ、閉じ括弧の
 * 直前へカーソルを置く（「本体のクリックは遷移だけ」という規則は変えず、直接編集の入口を
 * 別に設ける）。
 *
 * readOnly の view（閲覧用と、ページ embed の本文を描く nested view の両方）には
 * 足さない。nested view は編集内容が反映されない別 doc で、そこへの直接編集を許すと
 * 書いたはずの変更が消えたように見える。
 *
 * `container` はボタンの見た目上の親（widget の root、またはページ embed の resolved の
 * ようにタイトル行など root の内側の要素）。`root` は `editEmbedSource` に渡す widget の
 * root で、既定は `container` 自身だが、`container` が root の内側にあるときは呼び出し側が
 * 明示して渡す。`editEmbedSource` の reveal 判定（`previousElementSibling` に
 * `cm-embed-source` mark があるか）は widget の root（wrapper.append(titleRow, body) の
 * ように root の直下に並ぶ要素）でしか成り立たず、root の内側の要素（titleRow）を渡すと
 * 常に null になって「隠している」と誤判定する。
 */
function appendEditButton(
  container: HTMLElement,
  view: EditorView,
  target: string,
  root: HTMLElement = container,
): void {
  if (view.state.readOnly) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-embed-edit";
  button.setAttribute("aria-label", `「${target}」の埋め込み記法を編集`);
  button.textContent = "記法を編集";
  // Tab で止めない。キーボードでは、caret を embed の端へ動かせば記法が source で出て、同じ編集に入れる。
  // embed の数だけ、見えないボタンに Tab が止まるのを避ける
  button.tabIndex = -1;
  // click まで待つと、editor が先にボタンへカーソルを置こうとして selection が動く
  // （callout.ts の折りたたみ、task-list.ts のチェックボックスと同じ対処）
  button.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    editEmbedSource(view, root);
  });
  // 文字だけの widget のボタンは名前の下から右へ出る（embedTheme）。見せる直前に位置を合わせる。
  // - 名前が折り返すと、`left: 0` は最初の行の左端になり、最後の行の下から離れる。
  //   最後の行の左端へ寄せる。
  // - 行の右端に近い名前では editor の外へ切れるので、収まる分だけ左へ寄せる。
  // 画像と動画のボタンは右端に付くので、left を入れると横に伸びる
  root.addEventListener("pointerenter", () => {
    const name = TEXT_ONLY_NAMES.map((selector) => root.querySelector(`:scope > ${selector}`)).find(
      (element) => element !== null,
    );
    if (!name) return;
    button.style.removeProperty("left");
    const lastLine = [...name.getClientRects()].at(-1);
    const natural = button.getBoundingClientRect();
    let shift = lastLine ? lastLine.left - natural.left : 0;
    // 最後の行が「下書き」の印だけのとき、行の断片の左端は印の margin を含む。印の枠の左端へ寄せる
    const badge = name.querySelector(".cm-wikilink-draft-badge");
    if (lastLine && badge) {
      const badgeRect = badge.getBoundingClientRect();
      const margin = Number.parseFloat(getComputedStyle(badge).marginInlineStart);
      if (
        badgeRect.top >= lastLine.top - 1 &&
        Math.abs(badgeRect.left - lastLine.left - margin) < 0.5
      ) {
        shift += badgeRect.left - lastLine.left;
      }
    }
    shift -= Math.max(0, natural.right + shift - view.contentDOM.getBoundingClientRect().right);
    if (shift !== 0) button.style.left = `${shift}px`;
  });
  container.append(button);
}

const sourceOverlay = Decoration.mark({ class: "cm-embed-source cm-embed-source-overlay" });
const sourceInFlow = Decoration.mark({ class: "cm-embed-source" });
const sourceOverlayLine = Decoration.line({ class: "cm-embed-source-line" });

/**
 * 直前の build でこの embed に描いていた widget。描いていた形は 2 通りで、隠していたなら記法全体の
 * replace、source を出していたなら記法の直後の点に置いた widget になる。隣り合う embed の
 * widget を拾わないよう、端点が一致するものだけを見る。
 */
function drawnWidget(previous: DecorationSet, from: number, to: number): WidgetType | null {
  let found: WidgetType | null = null;
  previous.between(from, to, (rangeFrom, rangeTo, value) => {
    const widget: unknown = value.spec.widget;
    if (!(widget instanceof WidgetType)) return;
    if ((rangeFrom === from || rangeFrom === to) && rangeTo === to) {
      found = widget;
      return false;
    }
  });
  return found;
}

/**
 * 記法の前が、block の接頭辞（`- `、`1. `、`> `、`# `、`- [ ] `、引用の中の折り返し行の `> `）と
 * 空白だけか。接頭辞は折り返さないので、これだけなら embed は見た目の 1 行目に来て、行の上端に
 * 重ねた記法は widget を覆う。接頭辞の種類を並べる代わりに構文木で見る（接頭辞のノードは名前が
 * Mark か Marker で終わる）。
 */
function onlyBlockPrefixBefore(
  before: string,
  tree: Tree,
  lineFrom: number,
  embedFrom: number,
): boolean {
  // doc の位置と揃えるため code unit で分ける
  const chars = before.split("");
  tree.iterate({
    from: lineFrom,
    to: embedFrom,
    enter: (node) => {
      if (!/Mark(er)?$/.test(node.name)) return true;
      for (let pos = Math.max(node.from, lineFrom); pos < Math.min(node.to, embedFrom); pos += 1) {
        chars[pos - lineFrom] = " ";
      }
      return false;
    },
  });
  return chars.every((char) => /\s/.test(char));
}

/**
 * 記法（`from`..`to`）を widget に置き換えるか、source を出しつつ widget を記法の直後へ移すかを
 * 決める。WikiLink embed と markdown image（`![alt](url)`）は展開の見た目と reveal の振る舞いを
 * 揃えるので、この判定を共有する。
 */
function placeEmbed(
  state: EditorState,
  tree: Tree,
  previous: DecorationSet,
  reveal: (from: number, to: number) => boolean,
  decorations: Range<Decoration>[],
  atomic: Range<Decoration>[],
  from: number,
  to: number,
  render: (block: boolean) => WidgetType,
): void {
  const source = state.doc.sliceString(from, to);
  const line = state.doc.lineAt(from);
  // 見た目の 1 行目に来て（接頭辞と空白だけが前にある）、後ろにも文字が無い embed
  const prefixOnly = onlyBlockPrefixBefore(
    state.doc.sliceString(line.from, from),
    tree,
    line.from,
    from,
  );
  const block = prefixOnly && state.doc.sliceString(to, line.to).trim() === "";
  const createWidget = (): WidgetType => {
    const widget = render(block);
    widgetSources.set(widget, source);
    return widget;
  };

  // widget は記法全体を丸ごと置き換えるので、判定も記法全体で行う（IME 不変条件 2）
  if (!reveal(from, to)) {
    const replace = Decoration.replace({ widget: createWidget() }).range(from, to);
    decorations.push(replace);
    atomic.push(replace);
    return;
  }

  // source を出す間も、描いていた embed は残す。記法は replace せずに文字のまま置き、
  // widget は記法の直後の点に移す（replace ではないので selection と交差しない）。
  // 一度も描いていない embed（打ち込んでいる途中のもの）は、今までどおり source だけにする。
  const drawn = drawnWidget(previous, from, to);
  if (!drawn) return;
  // 記法を書き換えている間は、描いていた widget をそのまま使う。書きかけの記法で取得や読み込みを
  // 起こさず、embed の高さも変えない。記法が同じなら組み直し、取得の完了を映す
  // （内容が同じなら eq で DOM は変わらない）。
  // アップロードが済んだ「添付中」の widget は書きかけの記法ではなく古い表示なので、使い回さない。
  // 使い回すと、caret が記法の上にあるまま完了したとき、添付の画像に替わらない。
  const finishedUpload =
    drawn instanceof UploadingEmbedWidget && !isUploadingTarget(state, drawn.target);
  const widget = widgetSources.get(drawn) === source || finishedUpload ? createWidget() : drawn;
  // side を負にし、記法の直後に打った文字を widget の後ろに置く。正だと文字は widget の前、
  // つまり重ねた記法の真下に入り、変換中の文字が記法に隠れる（ページ embed なら行も増える）。
  decorations.push(Decoration.widget({ widget, side: -1 }).range(to));
  // 重ねる記法は行の上端に置くので、行が折り返して embed が 2 行目以降の見た目の行に来ると、
  // widget でなく 1 行目の本文を覆う。見た目の 1 行目から始まる embed だけを重ね、それ以外は
  // 記法を流れに置いて widget を後ろに残す（高さは widget が保つ）。
  if (prefixOnly) {
    decorations.push(sourceOverlay.range(from, to));
    decorations.push(sourceOverlayLine.range(line.from));
  } else {
    decorations.push(sourceInFlow.range(from, to));
  }
}

function build(
  view: EditorView,
  previous: DecorationSet,
  page: PageEmbedOptions | undefined,
): BuiltDecorations {
  const reveal = createRevealTest(view);
  const { state } = view;
  const resolveUrl = state.facet(attachmentUrlResolver);
  const expanded = expandedEmbedKinds(page);
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const seen = new Set<number>();
  const seenImages = new Set<number>();
  let sections = sectionContents.get(view);
  if (!sections) {
    sections = new SectionContents();
    sectionContents.set(view, sections);
  }
  sections.startBuild();

  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === "Image") {
          if (seenImages.has(node.from)) return false;
          seenImages.add(node.from);
          // reference 形式（`![alt][ref]`）は URL node を持たない。参照先の解決を持たないので
          // 装飾せず、通常の text として素通りさせる。
          const parts = linkSyntaxParts(node, state.doc);
          if (!parts) return true;
          const src = markdownImageSrc(parts.url);
          // 許可できない scheme と相対パスは widget を作らず、記法をそのまま素の text として見せる
          // （`javascript:` などを widget の src に渡さない）。
          if (src === null) return true;
          const alt = state.doc.sliceString(parts.open.to, parts.closeBracket.from);
          // Obsidian は `![[a.png|alias|300]]` と同じ規則で、markdown 標準の画像記法でも alt の
          // 最初の `|` から後ろをサイズ指定として読む（`![Engelbart|100x145](url)`）。`|` が無ければ
          // alt 全体をそのまま使う。`|` の後ろが size の形をしていなければ、その文字列をそのまま alt
          // にする（`parseImageEmbedLabel` の既定）。alt 本来の文字列と size の両立は
          // `ImageEmbedLabel` の型が持たない（alt か size の排他）ので、`![[...]]` の embed と同じ
          // 制約を受け入れる。
          const pipe = alt.indexOf("|");
          const label: ImageEmbedLabel =
            pipe < 0
              ? alt.length > 0
                ? { kind: "alt", text: alt }
                : { kind: "none" }
              : parseImageEmbedLabel(alt.slice(pipe + 1));
          placeEmbed(
            state,
            tree,
            previous,
            reveal,
            decorations,
            atomic,
            node.from,
            node.to,
            (block) => new ImageEmbedWidget(parts.url, src, label, block),
          );
          return false;
        }
        if (node.name !== wikiLinkNodes.link) return true;
        if (seen.has(node.from)) return false;
        seen.add(node.from);

        const embedFrom = node.from - 1;
        if (embedFrom < 0 || !isEmbedWikiLink(state.doc.sliceString(embedFrom, node.from))) {
          return false;
        }
        const parts = splitWikiLinkContent(state.doc.sliceString(node.from + 2, node.to - 2));
        if (!parts) return false;
        const kind = embedKindOf(parts);
        if (kind === null || !expanded.has(kind)) return false;
        let render: (block: boolean) => WidgetType;
        if (kind === "page") {
          // expanded に page が入るのは page を渡したときだけなので、ここで page は必ずある
          if (!page) return false;
          render = () =>
            new PageEmbedWidget(
              parts.target,
              sections.resolve(parts.target, page.resolve(parts.target), parts.heading),
              page,
              page.isDraft?.(parts.target) ?? false,
            );
        } else {
          render = (block) => mediaWidgetFactories[kind](state, parts, resolveUrl, block);
        }
        placeEmbed(state, tree, previous, reveal, decorations, atomic, embedFrom, node.to, render);
        return false;
      },
    });
  }

  return { decorations: Decoration.set(decorations, true), atomic: Decoration.set(atomic, true) };
}

const EMBED_GAP = "var(--ui-space-3, 0.75rem)";

const embedTheme = EditorView.baseTheme({
  // 編集ボタン（.cm-embed-edit、position: absolute）の containing block を作る。resolved な
  // ページ embed だけは除く。本文に持つ nested EditorView の ResizeObserver が、この
  // position: relative 自体をレイアウトの揺れとして拾い、source を重ねている間の IME 変換中に
  // 変換中の文字の text node を差し替える（IME 不変条件 1 違反）。resolved はボタンをタイトル行に
  // flex で並べ絶対配置の子を持たないので、position を与える必要も無い（PageEmbedWidget.toDOM の
  // resolved 分岐のコメント参照）。
  '.cm-embed-image, .cm-embed-video, .cm-embed-page:not([data-embed-state="resolved"])': {
    position: "relative",
  },
  ".cm-embed-edit": {
    position: "absolute",
    top: "0",
    right: "0",
    margin: "2px",
    padding: "0 0.4em",
    fontSize: "0.75em",
    lineHeight: "1.6",
    // 小さい画像の widget は、絶対配置のボタンの幅を画像の幅までに縮めて文字を折り返す。
    // 折り返さずに画像より広がると行頭では editor の外に切れるので、画像の幅で省略する。
    whiteSpace: "nowrap",
    maxWidth: "calc(100% - 4px)",
    boxSizing: "border-box",
    overflow: "hidden",
    textOverflow: "ellipsis",
    color: "var(--ui-color-muted)",
    backgroundColor: "var(--ui-color-surface)",
    border: "1px solid var(--ui-color-border)",
    borderRadius: "3px",
    cursor: "pointer",
    opacity: "0",
    pointerEvents: "none",
  },
  // 文字だけの widget（未解決、取得中、自分自身）は名前が短く、右上に重ねると名前がボタンに隠れる。
  // 幅を確保すると文の中に空白が残り、inline-block にすると長い名前が行の途中で折り返せなくなる。
  // そこで widget は inline のまま、ボタンを名前の下の左端から出して、次の行の文字に重ねる。
  // 見せるのは hover の間だけで、名前は読めたまま残る。幅は名前に縛られず、文字の分だけ取る。
  // 折り返した名前と行の右端に近い名前の位置合わせは、appendEditButton の pointerenter で行う。
  [TEXT_ONLY_NAMES.map((name) => `.cm-embed:has(> ${name}) > .cm-embed-edit`).join(", ")]: {
    top: "100%",
    right: "auto",
    left: "0",
    margin: "0",
    maxWidth: "none",
    zIndex: "1",
  },
  // hover できない端末では、タップのあとも :hover が残り、ボタンが次の行の文字の上に居座って、
  // 次の行へのタップが編集に化ける。caret を embed の端に置けば記法が source で出るので、そちらで編集する
  "@media (hover: none)": {
    [TEXT_ONLY_NAMES.map((name) => `.cm-embed:has(> ${name}) > .cm-embed-edit`).join(", ")]: {
      display: "none",
    },
  },
  // ページ embed のタイトル行に置くボタンだけは重ねない（下の `.cm-embed-page-header` 参照）。
  // position: static はタイトル行の flex の中で通常のアイテムとして並ぶことを意味する。
  ".cm-embed-page-header > .cm-embed-edit": { position: "static" },
  // hover か、widget の中（動画の操作など）に focus がある間だけ見せる
  ".cm-embed:hover .cm-embed-edit, .cm-embed:focus-within .cm-embed-edit": {
    opacity: "1",
    pointerEvents: "auto",
  },
  ".cm-embed-edit:hover": { color: "var(--ui-color-text)" },
  // `|300x200` で幅が行に収まらず縮んだときに、縦横比を崩さない
  ".cm-embed-image img": { maxWidth: "100%", objectFit: "contain", verticalAlign: "bottom" },
  ".cm-embed-video video": { maxWidth: "100%", verticalAlign: "bottom" },
  // 前後の行と離す。行にその embed しか無いとき（BLOCK_CLASS）だけ、wrapper を inline-block にして
  // padding で余白を取る。inline の wrapper の上下の余白は行の高さに数えられず、img への margin だと
  // 編集ボタンの基準（wrapper の上端と右端）が余白の分だけ画像からはみ出すため。
  // 文の中の embed は行を広げない。block かどうかは widget を作る時点で決めるので、読み込み後に
  // 行が伸び縮みしない。
  ".cm-embed-block": {
    display: "inline-block",
    verticalAlign: "bottom",
    maxWidth: "100%",
    paddingTop: EMBED_GAP,
    paddingBottom: EMBED_GAP,
  },
  // 編集ボタンは画像の右上（余白の内側）に置く
  ".cm-embed-block > .cm-embed-edit": { top: EMBED_GAP },
  // 未解決の WikiLink と同じ見せ方にそろえる（theme.ts の `.cm-wikilink-unresolved`）
  ".cm-embed-unresolved": {
    color: "var(--ui-color-muted)",
    textDecoration: "underline dashed",
    textDecorationColor: "var(--ui-color-accent)",
  },
  // 空白の無い、1 行より長い名前は、行頭の `img.cm-widgetBuffer` との間で折り返し、行の先頭に空行を作る。
  // どの字でも折り返せるようにして、名前を行の残りへ入れる。1 行に入る名前や、空白で折り返せる名前に
  // 付けると、行末で単語や名前の途中が切れる
  ".cm-embed-long-name": { wordBreak: "break-all" },
  ".cm-embed-uploading": { color: "var(--ui-color-muted)" },
  // 展開した本文は行の中で 1 行分の幅を取る。block の decoration は ViewPlugin から出せないので
  // inline の widget を行幅いっぱいの inline-block にする。
  '.cm-embed-page[data-embed-state="resolved"]': {
    display: "inline-block",
    boxSizing: "border-box",
    width: "100%",
    verticalAlign: "top",
    borderLeft: "3px solid var(--ui-color-border)",
    paddingLeft: "0.75em",
    // inline-block の margin は行の高さに数えられる
    marginTop: EMBED_GAP,
    marginBottom: EMBED_GAP,
  },
  // タイトルと編集ボタンを並べる行。本文（nested EditorView）を含む resolved の widget 自身には
  // position: absolute の子孫を作らない（下のコメント）ので、ボタンはこの行の中に流し込む。
  ".cm-embed-page-header": {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "0.5em",
  },
  ".cm-embed-page-title": { fontWeight: "600" },
  // タイトル行では flex item として残り幅いっぱいに広げる。他の場所（unresolved、pending、self の
  // 単独ラベル）は flex コンテナの外なので、flex 関連の指定はそこでは効かない。
  // クリック域をタイトルの見た目の幅いっぱいに保つ（Playwright の `.cm-embed-page-title` への
  // click は要素中央を狙うので、テキストがボタン側へ寄って中央から外れると拾えなくなる）。
  ".cm-embed-page-link": { cursor: "pointer", flex: "1 1 auto", minWidth: "0" },
  ".cm-embed-page-pending, .cm-embed-page-self": { color: "var(--ui-color-muted)" },
  ".cm-embed-page-body .cm-editor": { outline: "none" },
  // source を出している embed の記法を、行の上端から widget の上に重ねる。absolute にして流れから
  // 外すので、行の高さは widget だけで決まり、カーソルの出入りで高さが変わらない。left は指定せず
  // 流れの中の位置（widget の左端）に置き、幅は行の右端までで折り返す。
  // この mark が他の mark に分割されると、absolute の断片がどれも同じ位置に積み重なって崩れる。
  // 記法の一部だけにかかる mark（検索のハイライトなど）を足すときは、この mark を分割させない。
  ".cm-line.cm-embed-source-line": { position: "relative" },
  ".cm-embed-source-overlay": {
    position: "absolute",
    top: "0",
    zIndex: "1",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    backgroundColor: "var(--ui-color-background)",
    boxShadow: "0 0 0 1px var(--ui-color-border)",
  },
  // 1 行分しかない widget（未解決の表示、本文を描いていないページ embed、1 行以下の高さの画像）は
  // 重ねても高さを保つ役に立たず、記法より幅が狭いので、`]]` の直後に打つ文字が重ねた記法の下に
  // 隠れる。記法を流れに戻す（高さは 1 行のまま）。未解決かどうかは widget の DOM にしか出ないので
  // CSS で見る。widget は記法の mark の直後の兄弟に置かれる（side が負なので mark の終端より後）。
  '.cm-embed-source-overlay:has(+ .cm-embed > .cm-embed-unresolved), .cm-embed-source-overlay:has(+ .cm-embed > .cm-embed-uploading), .cm-embed-source-overlay:has(+ .cm-embed-page:not([data-embed-state="resolved"])), .cm-embed-source-overlay:has(+ .cm-embed[data-embed-compact])':
    { position: "static", backgroundColor: "transparent", boxShadow: "none" },
  // 文字だけの widget は記法と同じ target を並べるだけなので隠す。小さい画像は中身があるので残す。
  '.cm-embed-source + .cm-embed:has(> .cm-embed-unresolved), .cm-embed-source + .cm-embed-page:not([data-embed-state="resolved"])':
    { display: "none" },
  // drawSelection は選択を本文の下の層に描き、native の選択を透明にする。記法の地がその層を
  // 覆うので、重ねた記法の選択だけは native の選択で見せる。
  ".cm-line .cm-embed-source::selection, .cm-line .cm-embed-source ::selection": {
    backgroundColor: "color-mix(in srgb, var(--ui-color-accent) 30%, transparent) !important",
  },
});

/**
 * `![[...]]` の展開表示。画像と動画は widget に置き換え、ページ embed（見出しを指すセクション embed を
 * 含む）は `page` を渡したときだけ置き換える。展開方法を持たない embed（block を指す embed、PDF と
 * 音声）は WikiLink の装飾に任せる。
 * `resolveUrl` を渡さないと、画像と動画は未解決として表示する。
 *
 * markdown 標準の画像記法（`![alt](url)`）も同じ widget（`ImageEmbedWidget`）で展開する。
 * こちらは添付の解決を経ず、URL をそのまま `<img src>` に使う（`markdownImageSrc` が scheme と
 * 同一 origin の絶対パスだけを通す）。`resolveUrl`、`page` の有無に関わらず常に展開する。
 */
export function embeds(resolveUrl?: AttachmentUrlResolver, page?: PageEmbedOptions): Extension {
  return [
    decorationPlugin({
      name: "embed",
      build: (view, previous) => build(view, previous, page),
      rebuildWhen: uploadsChanged,
    }),
    embedTheme,
    page?.isDraft ? draftBadgeTheme : [],
    resolveUrl ? attachmentUrlResolver.of(resolveUrl) : [],
  ];
}
