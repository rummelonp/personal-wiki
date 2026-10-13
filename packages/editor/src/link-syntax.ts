import type { Text } from "@codemirror/state";
import type { SyntaxNodeRef } from "@lezer/common";
import { stripAngleBrackets } from "./external-link";

export interface LinkSyntaxParts {
  readonly open: SyntaxNodeRef;
  readonly closeBracket: SyntaxNodeRef;
  readonly closeParen: SyntaxNodeRef;
  readonly url: string;
}

/**
 * `[text](url "title")` と `![alt](url "title")` に共通する構造から `LinkMark`
 * （`[`/`![`・`]`・`(`・`)`）と `URL` を取り出す。`@lezer/markdown` は Link と Image を同じ
 * `finishLink` で組み立てるため、node の種類を見ずに子の並びだけで判定できる
 * （live-preview.ts の markdown link 装飾と embed.ts の markdown image 埋め込みが共有する）。
 * `[text][ref]` のような reference link/image は `URL` node を持たないので null にする
 * （参照先が別途必要で、URL がその場に無く隠す対象が無い）。
 */
export function linkSyntaxParts(node: SyntaxNodeRef, doc: Text): LinkSyntaxParts | null {
  const url = node.node.getChild("URL");
  if (!url) return null;
  const marks = node.node.getChildren("LinkMark");
  const before = marks.filter((mark) => mark.to <= url.from);
  const after = marks.filter((mark) => mark.from >= url.to);
  const open = before[0];
  const closeBracket = before[1];
  const closeParen = after.at(-1);
  if (!open || !closeBracket || !closeParen) return null;
  // `<https://...>` 記法の angle bracket は URL の一部ではない。剥がさないと data 属性・title・
  // embed の src のいずれでも `<...>` 込みの文字列が乗り、scheme 判定が二重にずれる。
  return {
    open,
    closeBracket,
    closeParen,
    url: stripAngleBrackets(doc.sliceString(url.from, url.to)),
  };
}
