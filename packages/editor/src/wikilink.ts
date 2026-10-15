import { syntaxTree } from "@codemirror/language";
import { type Extension, Facet, type Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import {
  type EmbedKind,
  embedKindOf,
  isEmbedWikiLink,
  splitWikiLinkContent,
  wikiLinkNodes,
} from "@personal-wiki/markdown";
import { type BuiltDecorations, decorationPlugin } from "./decoration-plugin";
import { isModifiedClick } from "./link-activation";
import { createRevealTest } from "./reveal";

export interface WikiLinkClick {
  /** link 先の title。空なら同じ page の見出しか block（`[[#見出し]]`、`[[#^id]]`）。 */
  readonly target: string;
  readonly label: string | null;
  /** `[[Note^id]]` の id。`[[Note#^id]]` の block は heading に `^id` として入る。 */
  readonly blockId: string | null;
  /** `[[Note#見出し]]` の `#` の後ろ。 */
  readonly heading: string | null;
}

export type WikiLinkClickHandler = (link: WikiLinkClick) => void;

const wikiLinkClickHandler = Facet.define<WikiLinkClickHandler>();

/**
 * WikiLink の遷移先 URL。返すと `<a href>` として描かれ、修飾クリック（新しいタブ、
 * 新しいウィンドウ、ダウンロード）と中クリック、リンクのコピーがブラウザ既定で効くようになる。
 * 素のクリックは href ではなく `WikiLinkClickHandler` が処理するので、host が id 経由で
 * 遷移する場合も href は人に見せられる URL（canonical な title の URL）にしてよい。
 * null を返すと href の無い装飾になる（遷移先を持たない host と、リンク切れの表現用）。
 */
export type WikiLinkHref = (link: WikiLinkClick) => string | null;

const wikiLinkHref = Facet.define<WikiLinkHref>();

/**
 * target が既存 page に解決するかを返す。unresolved link の視覚的区別に使う。
 * block reference（target^blockId）も target page の解決可否だけで判定する
 * （blockId 単位の存在確認は参照元 page から対象 page の本文を読む経路が無いため対象外）。
 */
export type WikiLinkResolver = (target: string) => boolean;

export const wikiLinkResolver = Facet.define<WikiLinkResolver>();

const TARGET_ATTR = "data-wikilink-target";
const LABEL_ATTR = "data-wikilink-label";
const BLOCK_ID_ATTR = "data-wikilink-block-id";
const HEADING_ATTR = "data-wikilink-heading";
const hide = Decoration.replace({});

/** 最初に URL を返した facet の値を採る（複数ぶら下げるのはテストだけを想定） */
function hrefOf(hrefs: readonly WikiLinkHref[], link: WikiLinkClick): string | null {
  for (const href of hrefs) {
    const url = href({
      target: link.target,
      label: link.label,
      blockId: link.blockId,
      heading: link.heading,
    });
    if (url !== null) return url;
  }
  return null;
}

function build(view: EditorView, expandedEmbeds: ReadonlySet<EmbedKind>): BuiltDecorations {
  const reveal = createRevealTest(view);
  const { state } = view;
  const resolvers = state.facet(wikiLinkResolver);
  const hrefs = state.facet(wikiLinkHref);
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const seen = new Set<number>();

  const conceal = (from: number, to: number): void => {
    if (from >= to) return;
    decorations.push(hide.range(from, to));
    atomic.push(hide.range(from, to));
  };

  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== wikiLinkNodes.link) return true;
        if (seen.has(node.from)) return false;
        seen.add(node.from);

        const parts = splitWikiLinkContent(state.doc.sliceString(node.from + 2, node.to - 2));
        if (!parts) return false;
        // 展開する embed は embed extension が `!` から `]]` までを widget に置き換える。
        // ここでも装飾すると、2 つの extension の replace が同じ範囲で重なる。
        if (node.from > 0 && isEmbedWikiLink(state.doc.sliceString(node.from - 1, node.from))) {
          const kind = embedKindOf(parts);
          if (kind !== null && expandedEmbeds.has(kind)) return false;
        }
        const attributes: Record<string, string> = { [TARGET_ATTR]: parts.target };
        if (parts.label !== null) attributes[LABEL_ATTR] = parts.label;
        if (parts.blockId !== null) attributes[BLOCK_ID_ATTR] = parts.blockId;
        if (parts.heading !== null) attributes[HEADING_ATTR] = parts.heading;
        // resolver 未設定（テストや resolver 導入前）では判定不能として resolved 扱いにする。
        // target が空の同じ page への link は、page の存在を問うまでもなく resolved。
        const resolved =
          parts.target === "" ||
          resolvers.length === 0 ||
          resolvers.some((resolve) => resolve(parts.target));
        const cls = resolved ? "cm-wikilink" : "cm-wikilink cm-wikilink-unresolved";
        const href = hrefOf(hrefs, parts);
        if (href !== null) {
          attributes.href = href;
          // contenteditable の中では `<a>` が既定でドラッグ可能になり、リンクを選択しようとした
          // ドラッグが本文の移動になってしまう
          attributes.draggable = "false";
        }
        decorations.push(
          Decoration.mark({
            class: cls,
            ...(href === null ? {} : { tagName: "a" }),
            attributes,
          }).range(node.from, node.to),
        );

        if (reveal(node.from, node.to)) return false;

        // 簡略表示では label があれば label だけ、無ければ target だけを残す。
        const separator = node.node.getChild(wikiLinkNodes.separator);
        const closeFrom = node.to - 2;
        if (separator && parts.label !== null) {
          conceal(node.from, separator.to);
          conceal(closeFrom, node.to);
        } else if (separator) {
          // `[[Title|]]`: 空 label は target 表示へフォールバックする
          conceal(node.from, node.from + 2);
          conceal(separator.from, node.to);
        } else {
          conceal(node.from, node.from + 2);
          conceal(closeFrom, node.to);
        }
        return false;
      },
    });
  }

  return { decorations: Decoration.set(decorations, true), atomic: Decoration.set(atomic, true) };
}

/**
 * 素のクリックでナビゲーションする。リンクの中へカーソルを入れて source を直したい
 * 場合は、リンクの外側にカーソルを置いてから矢印キーで入る。
 *
 * 修飾クリックと中クリックはここでは扱わず、`link-activation.ts` が `<a href>` を使って
 * ブラウザ既定（新しいタブ、新しいウィンドウ、ダウンロード）へ流す。
 */
const clickToNavigate = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || isModifiedClick(event)) return false;
    const handlers = view.state.facet(wikiLinkClickHandler);
    if (handlers.length === 0) return false;
    const element =
      event.target instanceof Element ? event.target.closest(`[${TARGET_ATTR}]`) : null;
    if (!element) return false;
    // target が空文字列の link（`[[#見出し]]`）も有効なので、null かどうかだけを見る
    const target = element.getAttribute(TARGET_ATTR);
    if (target === null) return false;
    const link: WikiLinkClick = {
      target,
      label: element.getAttribute(LABEL_ATTR),
      blockId: element.getAttribute(BLOCK_ID_ATTR),
      heading: element.getAttribute(HEADING_ATTR),
    };
    for (const handler of handlers) handler(link);
    event.preventDefault();
    return true;
  },
});

/** 既定では画像と動画だけを embed extension に任せる（ページ embed を渡さない `embeds()` と同じ） */
const DEFAULT_EXPANDED_EMBEDS: ReadonlySet<EmbedKind> = new Set<EmbedKind>(["image", "video"]);

/**
 * `[[Title]]` / `[[Title|Label]]` の装飾。構文は `@personal-wiki/markdown` の `WikiLink` が定義する。
 * `expandedEmbeds` は embed extension が widget に置き換える embed の種類で、それらは装飾しない。
 */
export function wikiLinks(
  onClick?: WikiLinkClickHandler,
  resolve?: WikiLinkResolver,
  expandedEmbeds: ReadonlySet<EmbedKind> = DEFAULT_EXPANDED_EMBEDS,
  href?: WikiLinkHref,
): Extension {
  return [
    decorationPlugin({ name: "wikilink", build: (view) => build(view, expandedEmbeds) }),
    clickToNavigate,
    onClick ? wikiLinkClickHandler.of(onClick) : [],
    resolve ? wikiLinkResolver.of(resolve) : [],
    href ? wikiLinkHref.of(href) : [],
  ];
}
