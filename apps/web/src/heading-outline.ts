export interface OutlineItem {
  level: number;
  text: string;
  /** 本文の中での見出し行の先頭の位置（UTF-16 の添字）。 */
  offset: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FRONTMATTER_FENCE = /^---[ \t]*$/;

/**
 * 目次用に ATX 見出し（`# 題`）を拾う。コードブロックと先頭の frontmatter の中は見出しとして扱わない。
 * Setext 見出しは拾わない。目次は編集の補助なので、正確な構文解析までは求めない。
 */
export function extractOutline(body: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  let offset = 0;
  let fence: string | null = null;
  let inFrontmatter = false;
  let lineNumber = 0;
  for (const line of body.split("\n")) {
    const lineOffset = offset;
    offset += line.length + 1;
    lineNumber += 1;
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (lineNumber === 1 && FRONTMATTER_FENCE.test(bare)) {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (FRONTMATTER_FENCE.test(bare)) inFrontmatter = false;
      continue;
    }
    const opening = FENCE.exec(bare)?.[1];
    if (fence !== null) {
      // 閉じは開きと同じ文字で、開き以上の長さ
      if (opening !== undefined && opening[0] === fence[0] && opening.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (opening !== undefined) {
      fence = opening;
      continue;
    }
    const heading = ATX_HEADING.exec(bare);
    if (heading === null) continue;
    const text = (heading[2] ?? "").trim();
    if (text === "") continue;
    items.push({ level: (heading[1] as string).length, text, offset: lineOffset });
  }
  return items;
}
