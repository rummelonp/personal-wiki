import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createEditor } from "./create-editor";

/*
 * markdown link と `==ハイライト==` の日本語は、wikilink と同じく地の文と同じ禁則で折り返し、
 * 字の間（「公｜開」）でも折り返す。行の幅より長いものも、はみ出さずに中で折り返す。
 */

let view: EditorView | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

function mount(doc: string): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, { doc });
  // 記号を隠した表示にするため、カーソルは対象の外（末尾の段落）に置く
  view.focus();
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
  return view;
}

const TARGETS = [
  {
    name: "markdown link",
    selector: ".cm-md-link",
    wrap: (text: string) => `[${text}](https://example.com/)`,
  },
  { name: "ハイライト", selector: ".cm-lp-highlight", wrap: (text: string) => `==${text}==` },
];

describe.each(TARGETS)("$name の折り返し", ({ selector, wrap }) => {
  it.each([
    ["日本語", "公開設定"],
    ["長めの日本語", "図書館の公開設定"],
  ])("%sは、字の間を含め地の文と同じ位置で折り返す", (_, text) => {
    const lead = "今日は図書館で調べた内容をまとめて、";
    const tail = "の記事に書き足した。\n\n後";
    const v = mount(`${lead}${wrap(text)}${tail}`);
    const target = v.contentDOM.querySelector(selector);
    if (!target || !host) throw new Error(`${selector} is not rendered`);
    // 幅を 1px ずつ広げ、本文の高さ（折り返しの行数）と、対象が複数の行にまたがる幅の数を集める
    const sweep = (editor: EditorView, element: Element | null) => {
      const heights: number[] = [];
      let splitWidths = 0;
      for (let width = 120; width <= 400; width++) {
        if (!host) throw new Error("host is not mounted");
        host.style.width = `${width}px`;
        heights.push(editor.contentDOM.getBoundingClientRect().height);
        if (element && element.getClientRects().length > 1) splitWidths++;
      }
      return { heights, splitWidths };
    };
    const decorated = sweep(v, target);
    view?.destroy();
    host.remove();

    const plain = mount(`${lead}${text}${tail}`);

    expect(decorated.heights).toEqual(sweep(plain, null).heights);
    // 字の間で折り返す幅を通っていないと、地の文と同じ折り返しを確かめたことにならない
    expect(decorated.splitWidths).toBeGreaterThan(0);
  });

  it("行の幅より長いものは、はみ出さずに中で折り返す", () => {
    const v = mount(`前の文 ${wrap("長い名前のページ".repeat(8))} 後の文\n\n後`);
    const target = v.contentDOM.querySelector(selector);
    if (!target || !host) throw new Error(`${selector} is not rendered`);

    for (const width of [200, 280, 375]) {
      host.style.width = `${width}px`;
      expect(target.getClientRects().length).toBeGreaterThan(1);
      expect(v.contentDOM.scrollWidth).toBeLessThanOrEqual(v.contentDOM.clientWidth);
    }
  });
});
