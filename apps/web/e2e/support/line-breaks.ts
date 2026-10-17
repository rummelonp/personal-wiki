import type { Locator } from "@playwright/test";

/** 日本語の短い文で、折り返してよい位置の直前に来る文字。 */
const PHRASE_END = "、。，．…  　";

/**
 * 要素の本文の折り返しのうち、句読点、空白、<wbr> の位置でないものを「前の文字|次の文字」で返す。
 * 語の途中で切れていれば空でなくなる。文字ごとの Range の位置で測るので、描画が実際に選んだ折り返しが分かる。
 */
export async function midPhraseBreaks(locator: Locator): Promise<string[]> {
  return locator.evaluate((element, phraseEnd) => {
    const breaks: string[] = [];
    let previous: { char: string; top: number; node: Text; index: number } | null = null;
    // 行末の空白は幅を持たないので、飛ばしたことを覚えておく
    let skippedSpace = false;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (
      let node = walker.nextNode() as Text | null;
      node !== null;
      node = walker.nextNode() as Text | null
    ) {
      const data = node.data;
      for (let index = 0; index < data.length; index++) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        const char = data[index] as string;
        if (rect.width === 0) {
          if (/\s/.test(char)) skippedSpace = true;
          continue;
        }
        const top = Math.round(rect.top);
        if (previous !== null && top !== previous.top && !skippedSpace) {
          const between = document.createRange();
          between.setStart(previous.node, previous.index + 1);
          between.setEnd(node, index);
          const atWbr = between.cloneContents().querySelector("wbr") !== null;
          if (!atWbr && !phraseEnd.includes(previous.char)) breaks.push(`${previous.char}|${char}`);
        }
        skippedSpace = false;
        previous = { char, top, node, index };
      }
    }
    return breaks;
  }, PHRASE_END);
}
