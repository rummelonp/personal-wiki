/** 要素の最初の行の文字のベースライン（画面上の y）。幅 0 の inline-block の下端は、その行のベースラインに載る */
export function firstBaseline(element: Element): number {
  const probe = document.createElement("span");
  probe.style.cssText = "display:inline-block;width:0;height:0";
  element.prepend(probe);
  const y = probe.getBoundingClientRect().bottom;
  probe.remove();
  return y;
}

/** `<dl>` の dt と dd の組ごとに、最初の行のベースラインの差を返す */
export function titleBaselineGaps(list: Element): number[] {
  const gaps: number[] = [];
  for (const term of list.querySelectorAll("dt")) {
    const detail = term.nextElementSibling;
    if (detail?.tagName !== "DD") throw new Error("dt の次に dd が無い");
    gaps.push(Math.abs(firstBaseline(term) - firstBaseline(detail)));
  }
  return gaps;
}
