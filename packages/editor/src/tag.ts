import { syntaxTree } from "@codemirror/language";
import { type Extension, Facet, type Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { tagNodes } from "@personal-wiki/markdown";
import { type BuiltDecorations, decorationPlugin } from "./decoration-plugin";
import { isModifiedClick } from "./link-activation";

export interface TagClick {
  readonly name: string;
}

export type TagClickHandler = (tag: TagClick) => void;

/**
 * tag の遷移先 URL。返すと `<a href>` として描かれ、修飾クリックと中クリックで新しいタブなどに
 * 開けるようになる（起動は `link-activation.ts`）。素のクリックは href でなく `TagClickHandler` が処理する。
 * null を返すと href の無い装飾になる。
 */
export type TagHref = (tag: TagClick) => string | null;

const tagClickHandler = Facet.define<TagClickHandler>();

const tagHref = Facet.define<TagHref, TagHref | null>({
  combine: (values) => values[0] ?? null,
});

/**
 * tag の名前を DOM に載せる属性。`clickToNavigate` はこの属性だけを見るので、構文木の `Tag` で
 * なくてもこれを付けた要素（`frontmatter-block.ts` の chip）は同じ遷移に乗る。
 */
export const TAG_NAME_ATTR = "data-tag-name";

function build(view: EditorView): BuiltDecorations {
  const { state } = view;
  const decorations: Range<Decoration>[] = [];
  const seen = new Set<number>();
  const hrefFor = state.facet(tagHref);

  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== tagNodes.tag) return true;
        if (seen.has(node.from)) return false;
        seen.add(node.from);

        const nameNode = node.node.getChild(tagNodes.name);
        if (!nameNode) return false;
        const name = state.doc.sliceString(nameNode.from, nameNode.to);
        const attributes: Record<string, string> = { [TAG_NAME_ATTR]: name };
        const href = hrefFor?.({ name }) ?? null;
        if (href !== null) {
          attributes.href = href;
          // contenteditable の中では `<a>` が既定でドラッグ可能になり、tag を選択しようとした
          // ドラッグが本文の移動になってしまう（wikilink.ts と同じ）
          attributes.draggable = "false";
        }
        decorations.push(
          Decoration.mark({
            class: "cm-tag",
            ...(href === null ? {} : { tagName: "a" }),
            attributes,
          }).range(node.from, node.to),
        );
        return false;
      },
    });
  }

  return { decorations: Decoration.set(decorations, true) };
}

/**
 * 素のクリックでナビゲーションする（`wikilink.ts` と同じ規約）。修飾クリックは取らない。
 * `TagHref` を渡して `<a href>` にした tag の修飾クリックと中クリックは `link-activation.ts` が起動する。
 * そのため Shift+クリックも、wikilink と同じく選択を広げずに新しいウィンドウで開く。
 * href の無い tag では Shift の範囲選択などエディタの既定に任せる。
 */
const clickToNavigate = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || isModifiedClick(event)) return false;
    const handlers = view.state.facet(tagClickHandler);
    if (handlers.length === 0) return false;
    const element =
      event.target instanceof Element ? event.target.closest(`[${TAG_NAME_ATTR}]`) : null;
    const name = element?.getAttribute(TAG_NAME_ATTR);
    if (!element || !name) return false;
    for (const handler of handlers) handler({ name });
    event.preventDefault();
    return true;
  },
});

/** `#tag` の装飾。構文は `@personal-wiki/markdown` の `Tag` が定義する。 */
export function tags(onClick?: TagClickHandler, href?: TagHref): Extension {
  return [
    decorationPlugin({ name: "tag", build }),
    clickToNavigate,
    onClick ? tagClickHandler.of(onClick) : [],
    href ? tagHref.of(href) : [],
  ];
}
