/** `char` の 1 字目の矩形。行の中の text node を順に探す */
export function charRect(line: Element, char: string): DOMRect {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = node.textContent?.indexOf(char) ?? -1;
    if (index < 0) continue;
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + 1);
    return range.getBoundingClientRect();
  }
  throw new Error(`${char} is not rendered`);
}
