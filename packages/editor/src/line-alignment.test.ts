import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "./create-editor";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc: string, width = 600): EditorView {
  host = document.createElement("div");
  host.style.width = `${width}px`;
  document.body.append(host);
  view = createEditor(host, { doc });
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

/** element の最初の文字の左端 */
function firstCharLeft(element: Element): number {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const text = walker.nextNode();
  if (!text) throw new Error("文字が無い");
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 1);
  return range.getBoundingClientRect().left;
}

const codeLine = (v: EditorView, text: string) =>
  [...v.contentDOM.querySelectorAll<HTMLElement>(".cm-lp-code")].find(
    (line) => line.textContent === text,
  );

describe("地の左端", () => {
  it("コードブロックの地は、本文の文字の左端から始まる", () => {
    const v = mount("本文\n\n```\ncode\n```\n");
    const body = v.contentDOM.querySelector(".cm-line");
    const code = codeLine(v, "code");
    if (!body || !code) throw new Error("行が無い");
    expect(code.getBoundingClientRect().left).toBeCloseTo(firstCharLeft(body), 1);
  });

  it("コードブロックの文字の位置は、地を寄せても動かない（0.75em）", () => {
    const v = mount("```\ncode\n```\n");
    const code = codeLine(v, "code");
    if (!code) throw new Error("行が無い");
    const fontSize = Number.parseFloat(getComputedStyle(code).fontSize);
    expect(firstCharLeft(code) - v.contentDOM.getBoundingClientRect().left).toBeCloseTo(
      fontSize * 0.75,
      1,
    );
  });

  it("引用の中のコードは寄せない（バーを行の左端から描く規則と競るため）", () => {
    const v = mount("> ```\n> code\n> ```\n");
    const code = v.contentDOM.querySelector<HTMLElement>(".cm-lp-code");
    if (!code) throw new Error("行が無い");
    expect(getComputedStyle(code).marginLeft).toBe("0px");
  });

  it("編集中の行の地は、本文の文字の左端から始まる", async () => {
    const v = mount("一行目\n二行目\n");
    v.focus();
    v.dispatch({ selection: EditorSelection.cursor(0) });
    await vi.waitFor(() => expect(v.contentDOM.querySelector(".cm-active-line")).not.toBeNull());
    const active = v.contentDOM.querySelector(".cm-active-line");
    const other = v.contentDOM.querySelectorAll(".cm-line")[1];
    if (!active || !other) throw new Error("行が無い");
    expect(active.getBoundingClientRect().left).toBeCloseTo(firstCharLeft(active), 1);
    // 地を寄せても、他の行と文字の位置が揃う
    expect(firstCharLeft(active)).toBeCloseTo(firstCharLeft(other), 1);
  });
});

const lineHeight = (v: EditorView) => Number.parseFloat(getComputedStyle(v.scrollDOM).lineHeight);

describe("tag の折り返し", () => {
  it("日本語の長い tag は、字の途中で折り返さず次の行へ送る", () => {
    const v = mount(`${"あ".repeat(18)} #とても長いタグ名とても長いタグ名`, 400);
    const tag = v.contentDOM.querySelector<HTMLElement>(".cm-tag");
    const first = v.contentDOM.querySelector(".cm-line");
    if (!tag || !first) throw new Error("要素が無い");
    // 1 行に収まる高さで、先頭の文字より下の行にある
    expect(tag.getBoundingClientRect().height).toBeLessThan(lineHeight(v) * 1.5);
    expect(tag.getBoundingClientRect().top).toBeGreaterThan(
      first.getBoundingClientRect().top + lineHeight(v) / 2,
    );
  });

  it("行の幅より長い tag は、途中で切れて行からはみ出さない", () => {
    const v = mount(`${"あ".repeat(4)} #${"長い".repeat(40)}`, 300);
    const tag = v.contentDOM.querySelector<HTMLElement>(".cm-tag");
    if (!tag) throw new Error("tag が無い");
    const rect = tag.getBoundingClientRect();
    expect(rect.height).toBeGreaterThan(lineHeight(v) * 1.5);
    expect(rect.right).toBeLessThanOrEqual(v.contentDOM.getBoundingClientRect().right + 0.5);
  });
});
