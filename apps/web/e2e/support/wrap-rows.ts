import type { Locator } from "@playwright/test";

/**
 * 1 つの段落に並べた「あ…あ<対象>の記事」の繰り返しで、対象の文字が何行にまたがるかを項目ごとに返す。
 * `selector` が null なら、対象を装飾しない地の文として、本文の文字の位置から数える。
 * 項目 i の前に置く「あ」は i + 1 字で、対象の位置が行の幅の中を 1 字ずつずれていく。
 */
export function rowsPerItem(
  content: Locator,
  options: { selector: string | null; count: number; lead: string; text: string; trail: string },
): Promise<number[]> {
  return content.evaluate((element, o) => {
    const rowCount = (rects: DOMRectList): number => {
      const tops: number[] = [];
      for (const rect of rects) {
        if (!tops.some((top) => Math.abs(top - rect.top) <= 2)) tops.push(rect.top);
      }
      return tops.length;
    };
    if (o.selector) {
      return Array.from(element.querySelectorAll(o.selector), (target) =>
        rowCount(target.getClientRects()),
      );
    }

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    const locate = (offset: number): [Text, number] => {
      let rest = offset;
      for (const node of nodes) {
        if (rest <= node.length) return [node, rest];
        rest -= node.length;
      }
      throw new Error(`offset ${offset} is outside the text`);
    };

    const counts: number[] = [];
    let offset = 0;
    for (let index = 0; index < o.count; index++) {
      const start = offset + o.lead.length * (index + 1);
      const range = document.createRange();
      range.setStart(...locate(start));
      range.setEnd(...locate(start + o.text.length));
      counts.push(rowCount(range.getClientRects()));
      offset = start + o.text.length + o.trail.length;
    }
    return counts;
  }, options);
}
