import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createEditor } from "./create-editor";
import { parseAhead } from "./parse-ahead";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

/** 作った直後の解析（先頭の数千字）より十分長い本文 */
const LONG_DOC = Array.from(
  { length: 3000 },
  (_, i) => `${i % 10 === 0 ? `## 見出し ${i}` : `段落 ${i} の本文。`}\n`,
).join("\n");

function mount(doc: string): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, { doc });
  return view;
}

describe("parseAhead", () => {
  it("解析の届いていない行から画面 1 枚以上下までを今すぐ解析し、次の transaction で木に取り込む", () => {
    const v = mount(LONG_DOC);
    const parsed = syntaxTree(v.state).length;
    // 背景の解析は idle を待つので、作った直後の同期の区間ではまだ進んでいない
    expect(parsed).toBeLessThan(v.state.doc.length);
    const target = v.state.doc.lineAt(parsed + 2000);

    expect(parseAhead(v, target.from)).toBe(true);
    v.dispatch({});
    const reached = v.state.doc.lineAt(syntaxTree(v.state).length);
    const screenLines = Math.ceil(window.innerHeight / v.defaultLineHeight);
    expect(reached.number - target.number).toBeGreaterThanOrEqual(screenLines);
  });

  it("既に解析が届いていれば dispatch せず true を返す", () => {
    const v = mount("# 見出し\n\n本文");
    const before = v.state;
    expect(parseAhead(v, 0)).toBe(true);
    expect(v.state).toBe(before);
  });
});
