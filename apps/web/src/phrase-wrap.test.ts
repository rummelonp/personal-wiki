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

  it("入れ子の要素の中の文字列も同じ規則で区切る", () => {
    const node = createElement(
      "p",
      null,
      "他のページのリンクは",
      createElement("strong", null, "自動では書き換わりません"),
    );
    expect(html(withPhraseBreaks(node))).toBe(
      '<p><span class="phrased">他のページの<wbr/>リンクは</span>' +
        '<strong><span class="phrased">自動では<wbr/>書き換わりません</span></strong></p>',
    );
  });

  it("配列の隣り合う文字列と数は、1 つの文字列として区切る（継ぎ目にも切れ目を置く）", () => {
    expect(html(withPhraseBreaks(["画像を", "添付できませんでした"]))).toBe(
      '<span class="phrased">画像を<wbr/>添付できませんでした</span>',
    );
    expect(html(withPhraseBreaks([3, "件を", false, "確かめました"]))).toBe(
      '<span class="phrased">3件を<wbr/>確かめました</span>',
    );
    const node = createElement(
      "p",
      null,
      "ページを",
      createElement("b", null, "太字"),
      "と画像を",
      "添付できません",
    );
    expect(html(withPhraseBreaks(node))).toBe(
      '<p><span class="phrased">ページを</span><b><span class="phrased">太字</span></b>' +
        '<span class="phrased">と画像を<wbr/>添付できません</span></p>',
    );
  });

  it("括弧とそれに接する文字は nobreak の span にまとめて離さない", () => {
    expect(html(withPhraseBreaks("「公開設定」のページを保存できませんでした"))).toBe(
      '<span class="phrased"><span class="nobreak">「公</span>開設定<span class="nobreak">」の</span>' +
        "<wbr/>ページを<wbr/>保存できませんでした</span>",
    );
    expect(html(withPhraseBreaks("（仮）ページ"))).toBe(
      '<span class="phrased"><span class="nobreak">（仮</span>）ページ</span>',
    );
  });

  it("括弧に接する文字は書記素の全体を nobreak の span に入れ、文字列は増減しない", () => {
    const flag = "\u{1F1EF}\u{1F1F5}";
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const voiced = "が"; // か + 結合濁点
    for (const [text, grapheme, bracketed] of [
      [`「${flag}旅行」のページ`, flag, `「${flag}`],
      [`「${family}家族」のページ`, family, `「${family}`],
      [`「旅行」${voiced}ページ`, voiced, `」${voiced}`],
    ] as const) {
      const out = html(withPhraseBreaks(text));
      expect(out, grapheme).toContain(`<span class="nobreak">${bracketed}</span>`);
      expect(out.replaceAll(/<[^>]+>/g, ""), "textContent が元の文字列と同じ").toBe(text);
    }
  });

  it("文節の途中で始まる開き括弧の手前に <wbr> を置く（nowrap の span の手前では折り返せなくなるため）", () => {
    expect(html(withPhraseBreaks("開いたときは、「保存」を押す"))).toBe(
      '<span class="phrased">開いたときは、<wbr/><span class="nobreak">「保</span>存' +
        '<span class="nobreak">」を</span><wbr/>押す</span>',
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
