import { syntaxTree } from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import { Decoration, type EditorView, WidgetType } from "@codemirror/view";
import {
  type FrontmatterFields,
  frontmatterNodes,
  parseFrontmatterFields,
} from "@personal-wiki/markdown";
import { type BuiltDecorations, decorationPlugin } from "./decoration-plugin";
import { isCompositionUnsettled } from "./ime";
import { createRevealTest } from "./reveal";
import { TAG_NAME_ATTR } from "./tag";

/** 畳んだときに隠す 2 行目以降。1 行目は枠の widget に置き換わるので残す */
const foldedLine = Decoration.line({ class: "cm-frontmatter-folded" });
/** source を出しているときの各行 */
const sourceLine = Decoration.line({ class: "cm-frontmatter-source" });
/** カーソル移動が畳んだ枠を 1 回で飛び越えるための範囲（`comment.ts` と同じ作り） */
const skipped = Decoration.replace({});

function chip(className: string, text: string): HTMLElement {
  const element = document.createElement("span");
  element.className = className;
  // innerHTML は使わない。本文の frontmatter はユーザーの入力そのものである
  element.textContent = text;
  return element;
}

/**
 * frontmatter の tag は `#` 無しで書くのが Obsidian の書き方だが、付けて書く人もいる。
 * 表示では `#` を 1 つだけ付け、遷移には `#` を除いた名前を渡す。
 */
const tagName = (tag: string) => tag.replace(/^#/, "");

/** 枠の名前。役割が button なので、中の chip は名前に入らず、ここで中身を言う */
function frontmatterLabel({ tags, aliases, otherKeys }: FrontmatterFields): string {
  const parts: string[] = [];
  if (tags.length > 0) parts.push(tags.map((tag) => `#${tagName(tag)}`).join(" "));
  if (aliases.length > 0) parts.push(`別名 ${aliases.join(" ")}`);
  if (otherKeys.length > 0) parts.push(`ほか ${otherKeys.length} 項目`);
  return parts.length > 0 ? `プロパティ: ${parts.join("、")}` : "プロパティ";
}

/** 畳んだ frontmatter の枠。`tags` と `aliases` を chip で見せ、他のキーは件数だけ出す */
class FrontmatterWidget extends WidgetType {
  constructor(private readonly fields: FrontmatterFields) {
    super();
  }

  override eq(other: FrontmatterWidget): boolean {
    const a = this.fields;
    const b = other.fields;
    const same = (x: readonly string[], y: readonly string[]) =>
      x.length === y.length && x.every((value, index) => value === y[index]);
    return (
      same(a.tags, b.tags) &&
      same(a.aliases, b.aliases) &&
      a.otherKeys.length === b.otherKeys.length
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("div");
    box.className = "cm-frontmatter";
    box.setAttribute("role", "button");
    box.setAttribute("aria-label", frontmatterLabel(this.fields));
    const { tags, aliases, otherKeys } = this.fields;

    for (const tag of tags) {
      const name = tagName(tag);
      const chipElement = chip("cm-tag cm-frontmatter-chip", `#${name}`);
      chipElement.setAttribute(TAG_NAME_ATTR, name);
      box.append(chipElement);
    }
    if (aliases.length > 0) box.append(chip("cm-frontmatter-label", "別名"));
    for (const alias of aliases) box.append(chip("cm-frontmatter-chip", alias));
    if (otherKeys.length > 0) {
      box.append(chip("cm-frontmatter-label", `ほか ${otherKeys.length} 項目`));
    } else if (tags.length === 0 && aliases.length === 0) {
      box.append(chip("cm-frontmatter-label", "プロパティ"));
    }

    box.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      // chip の遷移は tag.ts の handler が拾う。preventDefault すると editor まで届かない
      if (event.target instanceof Element && event.target.closest(`[${TAG_NAME_ATTR}]`)) return;
      // click まで待つと editor が先にカーソルを置くので、枠の先頭へ置く動きと二重になる
      event.preventDefault();
      // 確定文字列を読み込む前に dispatch すると確定文字列が消える（IME 不変条件 1）
      if (isCompositionUnsettled(view)) return;
      // preventDefault で focus が移らないので、自分で移す。focus が無いと簡略表示のまま畳まれる。
      // dispatch より先に移すのは、`createRevealTest` が `view.hasFocus` を同期に読むためである。
      // 後にすると、この dispatch の時点ではまだ focus が無く、枠は遅れて届く focus の update で
      // ようやく source に変わる。
      view.focus();
      view.dispatch({ selection: { anchor: view.posAtDOM(box) } });
    });
    return box;
  }

  // widget 自身の listener は true でも呼ばれる。false が要るのは chip のクリックのほうで、
  // 既定の true だと `eventBelongsToEditor` が枠の中の event を editor の外のものとみなし、
  // `tag.ts` が facet で登録した `mousedown` の handler まで届かない。
  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 本文先頭の frontmatter の表示。構文木の `Frontmatter`（`packages/markdown`）1 つだけを見る。
 *
 * カーソル（選択範囲）が block に触れていなければ畳んだ枠に置き換え、触れていれば行ごとに
 * source のまま見せる。判定は他の記法と同じ `createRevealTest` に通すので、選択と交差する
 * 範囲に `Decoration.replace` は残らない（IME 不変条件 2）。
 */
function build(view: EditorView): BuiltDecorations {
  const { state } = view;
  const node = syntaxTree(state).topNode.firstChild;
  if (!node || node.name !== frontmatterNodes.frontmatter) return { decorations: Decoration.none };
  if (!view.visibleRanges.some((range) => range.from <= node.to && range.to >= node.from)) {
    return { decorations: Decoration.none };
  }

  const decorations: Range<Decoration>[] = [];
  const first = state.doc.lineAt(node.from);
  const last = state.doc.lineAt(node.to).number;

  if (createRevealTest(view)(node.from, node.to)) {
    for (let n = first.number; n <= last; n += 1) {
      decorations.push(sourceLine.range(state.doc.line(n).from));
    }
    return { decorations: Decoration.set(decorations, true) };
  }

  // 枠は開き `---` の行に置く。plugin の decoration は改行を置き換えられないので、block の
  // replace にはできない（`callout.ts` の畳んだ本文と同じ制約）。残りの行は CSS で消す。
  const fields = parseFrontmatterFields(state.doc.sliceString(node.from, node.to));
  decorations.push(
    Decoration.replace({ widget: new FrontmatterWidget(fields) }).range(node.from, first.to),
  );
  for (let n = first.number + 1; n <= last; n += 1) {
    decorations.push(foldedLine.range(state.doc.line(n).from));
  }
  return {
    decorations: Decoration.set(decorations, true),
    atomic: Decoration.set([skipped.range(node.from, node.to)], true),
  };
}

export function frontmatterBlock(): Extension {
  return decorationPlugin({ name: "frontmatter", build });
}
