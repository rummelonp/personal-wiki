import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createEditor } from "./create-editor";

/*
 * markdown link と `==ハイライト==` の日本語は、wikilink と同じく字の間（「公｜開」）で折り返さず、
 * 行に収まるものは丸ごと次の行へ送る。行の幅より長いものは、はみ出さずに中で折り返す。
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
  ])("行に収まる%sは、字の間で折り返さず丸ごと次の行へ送る", (_, text) => {
    const v = mount(`今日は図書館で調べた内容をまとめて、${wrap(text)}の記事に書き足した。\n\n後`);
    const target = v.contentDOM.querySelector(selector);
    if (!target || !host) throw new Error(`${selector} is not rendered`);

    host.style.width = "3000px";
    const natural = target.getBoundingClientRect().width;
    const failures: string[] = [];
    // 行の幅が対象の幅に近い所から先は、対象が 1 行に収まるので、その幅の間は折り返してはならない
    for (let width = Math.ceil(natural) + 20; width <= 400; width++) {
      host.style.width = `${width}px`;
      if (target.getClientRects().length > 1) failures.push(`${width}px`);
    }

    expect(failures).toEqual([]);
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
