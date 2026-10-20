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

/**
 * 2 つの矩形が同じ表示行にあるか。top は書体ごとの content area の高さと padding でずれるので
 * 比べず、縦の中心の差を小さい方の高さの半分と比べる（別の行なら差は行の高さほど開く）
 */
export function onSameVisualLine(a: DOMRect, b: DOMRect): boolean {
  const center = (r: DOMRect) => r.top + r.height / 2;
  return Math.abs(center(a) - center(b)) < Math.min(a.height, b.height) / 2;
}
