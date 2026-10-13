import { syntaxTree } from "@codemirror/language";
import { type Extension, Facet, type Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { tagNodes } from "@personal-wiki/markdown";
import { type BuiltDecorations, decorationPlugin } from "./decoration-plugin";

export interface TagClick {
  readonly name: string;
}

export type TagClickHandler = (tag: TagClick) => void;

const tagClickHandler = Facet.define<TagClickHandler>();

/**
 * tag の名前を DOM に載せる属性。`clickToNavigate` はこの属性だけを見るので、構文木の `Tag` で
 * なくてもこれを付けた要素（`frontmatter-block.ts` の chip）は同じ遷移に乗る。
 */
export const TAG_NAME_ATTR = "data-tag-name";

function build(view: EditorView): BuiltDecorations {
  const { state } = view;
  const decorations: Range<Decoration>[] = [];
  const seen = new Set<number>();

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
        decorations.push(
          Decoration.mark({ class: "cm-tag", attributes: { [TAG_NAME_ATTR]: name } }).range(
            node.from,
            node.to,
          ),
        );
        return false;
      },
    });
  }

  return { decorations: Decoration.set(decorations, true) };
}

/** 素のクリックでナビゲーションする（`wikilink.ts` と同じ規約）。 */
const clickToNavigate = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) return false;
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
export function tags(onClick?: TagClickHandler): Extension {
  return [
    decorationPlugin({ name: "tag", build }),
    clickToNavigate,
    onClick ? tagClickHandler.of(onClick) : [],
  ];
}
