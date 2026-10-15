import { afterEach, describe, expect, it } from "vitest";
import { isInView } from "./in-view";

const created: HTMLElement[] = [];

afterEach(() => {
  for (const element of created.splice(0)) element.remove();
  window.scrollTo(0, 0);
});

function add(css: string, tag = "div"): HTMLElement {
  const element = document.createElement(tag);
  element.style.cssText = css;
  document.body.append(element);
  created.push(element);
  return element;
}

describe("isInView", () => {
  it("画面に入っていれば true、スクロールして外れれば false", () => {
    add("height: 3000px");
    const target = add("position: absolute; top: 20px; left: 0; height: 20px; width: 50px");
    expect(isInView(target)).toBe(true);
    window.scrollTo(0, 1000);
    expect(isInView(target)).toBe(false);
    window.scrollTo(0, 0);
    expect(isInView(target)).toBe(true);
  });

  it("画面の上端に残るヘッダーの下に隠れた要素は、見えていないとする", () => {
    add("position: sticky; top: 0; height: 60px", "header").className = "header";
    add("height: 3000px");
    const target = add("position: absolute; top: 1000px; left: 0; height: 20px; width: 50px");
    // 画面の上端から 20px にあり、ヘッダー（0〜60px）の下に隠れている
    window.scrollTo(0, 980);
    expect(isInView(target)).toBe(false);
    window.scrollTo(0, 900);
    expect(isInView(target)).toBe(true);
  });
});
