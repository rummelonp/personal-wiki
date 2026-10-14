import { EditorView } from "@codemirror/view";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page as browserPage } from "vitest/browser";
import { BodyEditor, type BodyEditorHandle } from "./BodyEditor";
import "./theme.css";
import "./styles.css";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let roots: Root[] = [];
let containers: HTMLElement[] = [];

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  for (const container of containers) container.remove();
  roots = [];
  containers = [];
  window.scrollTo(0, 0);
});

const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

/** ヘッダー（sticky）の下に本文を置く。読み取りの画面は readOnly、編集の画面は readOnly にしない */
function mountBody(
  doc: string,
  readOnly: boolean,
  handle: React.Ref<BodyEditorHandle> = createRef<BodyEditorHandle>(),
) {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <>
        <header className="header">
          <span className="brand">personal-wiki</span>
        </header>
        <article className="note">
          <BodyEditor ref={handle} value={doc} readOnly={readOnly} />
        </article>
      </>,
    ),
  );
  const content = container.querySelector<HTMLElement>(".body-editor .cm-editor");
  const view = content ? EditorView.findFromDOM(content) : null;
  if (!view) throw new Error("本文の view が無い");
  return { container, view };
}

const lineOf = (view: EditorView, number: number) => {
  const { node } = view.domAtPos(view.state.doc.line(number).from);
  const found = node instanceof HTMLElement ? node : node.parentElement;
  const line = found?.closest(".cm-line") ?? found?.querySelector(".cm-line");
  if (!(line instanceof HTMLElement)) throw new Error(`${number} 行目が描かれていない`);
  return line;
};

describe.each([
  ["読み取りの画面", true],
  ["編集の画面", false],
])("見出しの下の余白（%s、375px）", (_, readOnly) => {
  it.each([
    ["空行を挟む", "前の段落\n\n## 見出し\n\n- 項目 1\n- 項目 2", 5],
    ["空行を挟まない", "前の段落\n\n## 見出し\n- 項目 1\n- 項目 2", 4],
  ])("見出しから続きの文字までの間は、本文 1 行の半分ほど（%s）", async (_, doc, itemLine) => {
    await browserPage.viewport(375, 800);
    const { view } = mountBody(doc, readOnly);
    await frame();
    const heading = lineOf(view, 3).getBoundingClientRect();
    const item = lineOf(view, itemLine).getBoundingClientRect();
    const bodyLine = lineOf(view, 1).getBoundingClientRect().height;
    // 続きの行の上端までの距離（行内の余白を含む）。以前は空行を挟むと本文 2 行分近く空いていた
    expect(item.top - heading.bottom).toBeLessThanOrEqual(bodyLine * 0.6);
  });

  it("見出しの上は、本文の段落の間より広い", async () => {
    await browserPage.viewport(375, 800);
    const { view } = mountBody("前の段落\n\n## 見出し\n\n本文\n\n次の段落", readOnly);
    await frame();
    // 見出しの上の余白は行の padding なので、行の上端ではなく padding の下から測る
    const heading = lineOf(view, 3);
    const above =
      heading.getBoundingClientRect().top +
      Number.parseFloat(getComputedStyle(heading).paddingTop) -
      lineOf(view, 1).getBoundingClientRect().bottom;
    const between =
      lineOf(view, 7).getBoundingClientRect().top - lineOf(view, 5).getBoundingClientRect().bottom;
    expect(above).toBeGreaterThan(between);
  });
});

describe("見出しへの移動", () => {
  const doc = [
    ...Array.from({ length: 40 }, (_, i) => `段落 ${i}\n`),
    "## 移動先",
    "",
    "- 項目",
    ...Array.from({ length: 60 }, (_, i) => `続き ${i}\n`),
  ].join("\n");

  it.each([
    ["読み取りの画面", true],
    ["編集の画面", false],
  ])("見出しの文字は、sticky のヘッダーの下に出る（%s）", async (_, readOnly) => {
    await browserPage.viewport(375, 600);
    const handle = createRef<BodyEditorHandle>();
    const { container, view } = mountBody(doc, readOnly, handle);
    await frame();
    act(() => handle.current?.jumpToFragment({ kind: "heading", heading: "移動先" }));
    await frame();
    await frame();
    const header = container.querySelector("header.header");
    const headerBottom = header?.getBoundingClientRect().bottom ?? Number.NaN;
    const at = view.state.doc.toString().indexOf("## 移動先") + 3;
    const glyph = view.coordsAtPos(at, 1);
    if (!glyph) throw new Error("見出しの位置が測れない");
    expect(window.scrollY).toBeGreaterThan(0);
    expect(glyph.top).toBeGreaterThanOrEqual(headerBottom);
    expect(glyph.top).toBeLessThanOrEqual(headerBottom + 40);
  });
});
