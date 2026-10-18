import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { withPhraseBreaks } from "./phrase-wrap";

const html = (node: ReactNode): string => renderToStaticMarkup(createElement(Fragment, null, node));

describe("withPhraseBreaks", () => {
  it("文字列を文節ごとに <wbr> でつなぎ、文字は増減しない", () => {
    const out = html(withPhraseBreaks("画像を添付できませんでした"));
    expect(out).toBe('<span class="phrased">画像を<wbr/>添付できませんでした</span>');
    expect(out.replaceAll("<wbr/>", "")).toBe(
      '<span class="phrased">画像を添付できませんでした</span>',
    );
  });

  it("入れ子の要素と配列の中の文字列も同じ規則で区切る", () => {
    const node = createElement(
      "p",
      null,
      ["他の", "ページのリンクは"],
      createElement("strong", null, "自動では書き換わりません"),
    );
    expect(html(withPhraseBreaks(node))).toBe(
      '<p><span class="phrased">他の</span><span class="phrased">ページの<wbr/>リンクは</span>' +
        '<strong><span class="phrased">自動では<wbr/>書き換わりません</span></strong></p>',
    );
  });

  it("整形済みの要素と部品の子は変えない。keep-all を当てる span も作らない", () => {
    const Child = ({ children }: { children?: ReactNode }) => createElement("i", null, children);
    const node = createElement(
      "p",
      null,
      createElement("code", null, "画像を添付できませんでした"),
      createElement(Child, null, "画像を添付できませんでした"),
    );
    expect(html(withPhraseBreaks(node))).toBe(
      "<p><code>画像を添付できませんでした</code><i>画像を添付できませんでした</i></p>",
    );
  });

  it("文節が 1 つだけの文字列も span にまとめる（keep-all を当てる範囲を、区切った文字列に限るため）", () => {
    expect(html(withPhraseBreaks("閉じる"))).toBe('<span class="phrased">閉じる</span>');
  });

  it("空白だけの文字列と、文字列でない子はそのまま返す", () => {
    expect(withPhraseBreaks(" ")).toBe(" ");
    expect(withPhraseBreaks(null)).toBeNull();
    expect(withPhraseBreaks(3)).toBe(3);
  });
});
