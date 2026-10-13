import { extractBlockIds } from "./block-id";
import { extractLinkableHeadings } from "./heading-section";

export interface LinkTargetBlock {
  readonly id: string;
  /** block の本文の 1 行。補完の候補に添えて、どの block かを見分ける手掛かりにする */
  readonly preview: string;
}

/** `[[Note#見出し]]` と `[[Note#^id]]` が指せる、ある page の中の場所 */
export interface LinkTargets {
  readonly headings: readonly string[];
  readonly blocks: readonly LinkTargetBlock[];
}

/**
 * 本文 `text` から、`[[Note#` と `[[Note#^` の補完に出す見出しと block id を取り出す。
 * 見出しは `extractLinkableHeadings`、block id は `extractBlockIds` と同じ解釈で、補完で
 * 選んだ link が解決する先と食い違わない。同じ id が複数あれば先に現れるほうだけを返す。
 */
export function extractLinkTargets(text: string): LinkTargets {
  const lines = text.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  const seen = new Set<string>();
  const blocks: LinkTargetBlock[] = [];
  for (const ref of extractBlockIds(text)) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);

    let index = lineStarts.findLastIndex((start) => start <= ref.from);
    let preview = (lines[index] ?? "").slice(0, ref.from - (lineStarts[index] ?? 0)).trim();
    // `^id` だけの行は、直前の block を指す書き方（Obsidian は空行を挟んだ `^id` も認める）。
    // 空行をさかのぼって最初の本文の行を使う。
    while (preview === "" && index > 0) {
      index -= 1;
      preview = (lines[index] ?? "").trim();
    }
    blocks.push({ id: ref.id, preview });
  }

  return { headings: extractLinkableHeadings(text), blocks };
}
