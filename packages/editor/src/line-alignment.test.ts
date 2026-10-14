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
    const active = v.contentDOM.querySelector<HTMLElement>(".cm-active-line");
    const other = v.contentDOM.querySelectorAll(".cm-line")[1];
    if (!active || !other) throw new Error("行が無い");
    const style = getComputedStyle(active);
    // 地は content-box で切るので、padding の左端（文字の左端）から描かれる
    expect(style.backgroundClip).toBe("content-box");
    expect(active.getBoundingClientRect().left + Number.parseFloat(style.paddingLeft)).toBeCloseTo(
      firstCharLeft(active),
      1,
    );
    // 地を寄せても、他の行と文字の位置が揃う
    expect(firstCharLeft(active)).toBeCloseTo(firstCharLeft(other), 1);
  });

  it("文書の 1 行目が編集中でも、複数行の選択範囲は他の行の文字の左端から始まる", async () => {
    const v = mount("一行目\n二行目\n三行目\n");
    v.focus();
    v.dispatch({ selection: EditorSelection.range(0, v.state.doc.length) });
    await vi.waitFor(() => expect(v.contentDOM.querySelector(".cm-active-line")).not.toBeNull());
    await vi.waitFor(() => expect(v.dom.querySelector(".cm-selectionBackground")).not.toBeNull());
    const second = v.contentDOM.querySelectorAll(".cm-line")[1];
    if (!second) throw new Error("行が無い");
    const selection = [...v.dom.querySelectorAll(".cm-selectionBackground")].map(
      (el) => el.getBoundingClientRect().left,
    );
    // 選択範囲の左端は、最初の行の padding-left を基準にする。1 行目が margin で動くと 6px ずれる。
    expect(Math.min(...selection)).toBeGreaterThanOrEqual(firstCharLeft(second) - 0.5);
  });

  it("frontmatter の source の地は、本文の文字の左端から始まり、文字は 0.75em の位置に残る", () => {
    const doc = "---\ntitle: x\n---\n本文";
    const v = mount(doc);
    v.focus();
    v.dispatch({ selection: EditorSelection.cursor(doc.indexOf("title")) });
    const source = v.contentDOM.querySelector<HTMLElement>(".cm-frontmatter-source");
    const body = [...v.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].find(
      (line) => line.textContent === "本文",
    );
    if (!source || !body) throw new Error("行が無い");
    expect(source.getBoundingClientRect().left).toBeCloseTo(firstCharLeft(body), 1);
    const fontSize = Number.parseFloat(getComputedStyle(source).fontSize);
    expect(firstCharLeft(source) - v.contentDOM.getBoundingClientRect().left).toBeCloseTo(
      fontSize * 0.75,
      1,
    );
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

  it.each([
    ["リスト", `- あ #${"長い".repeat(40)}`],
    ["入れ子のリスト", `- 親\n  - あ #${"長い".repeat(40)}`],
  ])("%s の中の長い tag は、行の右端からはみ出さない", (_, doc) => {
    const v = mount(doc, 300);
    const tag = v.contentDOM.querySelector<HTMLElement>(".cm-tag");
    if (!tag) throw new Error("tag が無い");
    expect(tag.getBoundingClientRect().right).toBeLessThanOrEqual(
      v.contentDOM.getBoundingClientRect().right,
    );
  });
});
