import type { Locator } from "@playwright/test";

/**
 * 日本語の短い文で、折り返してよい位置の直前に来る文字。閉じ括弧は、引用した名前（「title」）のまとまりの
 * 後ろで切れるので含める。改行しない空白（U+00A0）は含めない。
 */
const PHRASE_END = "、。，．… 　」』）】";

interface Line {
  /** 行に載った文字。行末の空白は、描画が幅を返しても返さなくても同じ結果になるよう落とす */
  text: string;
  /** 前の行との境が、空白か <wbr> の位置だったか。最初の行は false */
  breakAllowedBefore: boolean;
}

/**
 * 要素の本文を、描画が実際に選んだ折り返しで行に分ける。文字ごとの Range の位置で測る。
 * 同じ行かは、top の差が文字の高さの半分以内かで決める（小数の丸めや上付きの文字で揺れない）。
 */
async function layoutLines(locator: Locator): Promise<Line[]> {
  return locator.evaluate((element, phraseEnd) => {
    const lines: Line[] = [];
    let previous: { char: string; top: number; node: Text; index: number } | null = null;
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
        if (previous === null || Math.abs(rect.top - previous.top) > rect.height / 2) {
          let allowed = false;
          if (previous !== null) {
            const between = document.createRange();
            between.setStart(previous.node, previous.index + 1);
            between.setEnd(node, index);
            const atWbr = between.cloneContents().querySelector("wbr") !== null;
            allowed = skippedSpace || atWbr || phraseEnd.includes(previous.char);
          }
          lines.push({ text: "", breakAllowedBefore: allowed });
        }
        (lines[lines.length - 1] as Line).text += char;
        skippedSpace = false;
        previous = { char, top: rect.top, node, index };
      }
    }
    // 改行しない空白（U+00A0）は行末でも本文の一部なので残す
    for (const line of lines) line.text = line.text.replace(/[^\S\u00a0]+$/, "");
    return lines;
  }, PHRASE_END);
}

/** 要素の本文の、描画された行ごとの文字列。 */
export async function lineTexts(locator: Locator): Promise<string[]> {
  return (await layoutLines(locator)).map((line) => line.text);
}

/**
 * 要素の本文の折り返しのうち、句読点、空白、<wbr> の位置でないものを「前の行の末尾の文字|次の行の先頭の文字」で返す。
 * 語の途中で切れていれば空でなくなる。
 */
export async function midPhraseBreaks(locator: Locator): Promise<string[]> {
  const lines = await layoutLines(locator);
  const breaks: string[] = [];
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] as Line;
    if (line.breakAllowedBefore) continue;
    breaks.push(`${(lines[index - 1] as Line).text.slice(-1)}|${line.text.slice(0, 1)}`);
  }
  return breaks;
}
