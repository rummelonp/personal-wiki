import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "./create-editor";
import { createTitleEditor } from "./title-editor";

const BODY_FONT = "editor-test-body";
const MONO_FONT = "editor-test-mono";

const H1 = "見出し 1";
const H2 = "見出し 2";
const H3 = "見出し 3";
const H4 = "見出し 4";
const INLINE_CODE = "inlineCode";
const FENCED_CODE = "fencedCode";
const INDENTED_CODE = "indentedCode";
const DOC = [
  `# ${H1}`,
  `## ${H2}`,
  `### ${H3}`,
  `#### ${H4}`,
  "",
  `本文の段落。\`${INLINE_CODE}\` を含む。`,
  "",
  "```",
  FENCED_CODE,
  "```",
  "",
  `    ${INDENTED_CODE}`,
].join("\n");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function mount(create: (parent: HTMLElement) => EditorView): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = create(parent);
  cleanups.push(() => {
    view.destroy();
    parent.remove();
  });
  return view;
}

/** source を出させて `#` の記号も含めた生の見出し行を見せる。行の大きさは source でも変わらない */
function revealAll(view: EditorView): void {
  view.dispatch({ selection: EditorSelection.range(0, view.state.doc.length) });
}

function spanByText(view: EditorView, text: string): HTMLElement {
  const span = [...view.contentDOM.querySelectorAll("span")].find((s) => s.textContent === text);
  if (!span) throw new Error(`"${text}" is not rendered as a span`);
  return span;
}

function lineByClass(view: EditorView, className: string): HTMLElement {
  const line = view.contentDOM.querySelector(`.${className}`);
  if (!(line instanceof HTMLElement)) throw new Error(`.${className} is not rendered`);
  return line;
}

describe("本文の書体", () => {
  it("本文は等幅でなく --ui-font-body、16px、行の高さ 1.75", () => {
    const view = mount((parent) => createEditor(parent, { doc: DOC }));
    const style = getComputedStyle(view.contentDOM);
    expect(style.fontFamily).toContain(BODY_FONT);
    expect(style.fontFamily).not.toContain(MONO_FONT);
    expect(style.fontSize).toBe("16px");
    // line-height は px に解決される（16 * 1.75 = 28）
    expect(style.lineHeight).toBe("28px");
  });

  it("見出しは下線が無く、大きさと太さで本文と区別する", () => {
    const view = mount((parent) => createEditor(parent, { doc: DOC }));
    revealAll(view);

    const h1 = spanByText(view, H1);
    const h2 = spanByText(view, H2);
    const h3 = spanByText(view, H3);
    const bodyFontSize = Number.parseFloat(getComputedStyle(view.contentDOM).fontSize);

    for (const heading of [h1, h2, h3]) {
      expect(getComputedStyle(heading).textDecorationLine).toBe("none");
      expect(Number(getComputedStyle(heading).fontWeight)).toBeGreaterThanOrEqual(700);
    }

    const h1Size = Number.parseFloat(getComputedStyle(lineByClass(view, "cm-lp-h1")).fontSize);
    const h2Size = Number.parseFloat(getComputedStyle(lineByClass(view, "cm-lp-h2")).fontSize);
    const h3Size = Number.parseFloat(getComputedStyle(lineByClass(view, "cm-lp-h3")).fontSize);

    // 大きさで階層を表す: h1 > h2 > h3 > 本文
    expect(h1Size).toBeGreaterThan(h2Size);
    expect(h2Size).toBeGreaterThan(h3Size);
    expect(h3Size).toBeGreaterThan(bodyFontSize);

    // h4〜h6 は livePreviewTheme に大きさの override が無く、本文と同じ大きさのまま太さだけで区別する
    const h4 = spanByText(view, H4);
    expect(getComputedStyle(h4).textDecorationLine).toBe("none");
    expect(Number(getComputedStyle(h4).fontWeight)).toBeGreaterThanOrEqual(700);
    const h4Size = Number.parseFloat(getComputedStyle(lineByClass(view, "cm-lp-h4")).fontSize);
    expect(h4Size).toBe(bodyFontSize);
  });

  it("インラインコード、fenced code、indented code だけが等幅（--ui-font-mono）になる", () => {
    const view = mount((parent) => createEditor(parent, { doc: DOC }));

    const inlineCode = spanByText(view, INLINE_CODE);
    expect(getComputedStyle(inlineCode).fontFamily).toContain(MONO_FONT);

    const fencedCode = spanByText(view, FENCED_CODE);
    expect(getComputedStyle(fencedCode).fontFamily).toContain(MONO_FONT);

    const indentedCode = spanByText(view, INDENTED_CODE);
    expect(getComputedStyle(indentedCode).fontFamily).toContain(MONO_FONT);

    // 地の文（段落）は等幅にならず、本文の書体のまま
    const paragraph = [...view.contentDOM.querySelectorAll(".cm-line")].find((line) =>
      line.textContent?.includes("本文の段落。"),
    );
    if (!paragraph) throw new Error("paragraph line is not rendered");
    const paragraphStyle = getComputedStyle(paragraph);
    expect(paragraphStyle.fontFamily).not.toContain(MONO_FONT);
    expect(paragraphStyle.fontFamily).toContain(BODY_FONT);
  });

  it("言語指定付き fenced code（```ts）も丸ごと等幅になる", async () => {
    // @lezer/markdown は言語指定付き fence に埋め込み言語の parser を overlay mount で入れ、
    // @lezer/highlight は overlay 内を inheritedClass を空にして解決する。そのため
    // t.monospace の class は個々の span まで継承されず、言語指定の無い fence
    // （上の test）とは別経路（live-preview.ts の行 decoration）で等幅を保証する必要がある。
    const LANG_DOC = ["```ts", "const codeBlockToken = 1;", "```"].join("\n");
    const view = mount((parent) => createEditor(parent, { doc: LANG_DOC }));

    // @codemirror/language-data の言語 loader は動的 import（非同期）で、mount 直後は
    // まだ埋め込み文法が効いていない。読み込みが終わって構文強調が入るまで待つ。
    await vi.waitFor(() => {
      const line = [...view.contentDOM.querySelectorAll(".cm-line")].find((l) =>
        l.textContent?.includes("codeBlockToken"),
      );
      if (!line) throw new Error("fenced code line is not rendered");
      // 複数 span に分かれていること（= overlay mount が効いて構文強調が入っていること）を
      // 確かめたうえで、行自身と個々の span の両方で computed style を見る。
      const spans = [...line.querySelectorAll("span")];
      expect(spans.length).toBeGreaterThan(1);
      for (const el of [line, ...spans]) {
        expect(getComputedStyle(el).fontFamily).toContain(MONO_FONT);
      }
    });
  });

  it("title は本文の見出しより大きい約 28px の太字で、等幅にならない", () => {
    const titleView = mount((parent) => createTitleEditor(parent, { doc: "タイトル文字列" }));
    const style = getComputedStyle(titleView.contentDOM);

    expect(style.fontFamily).not.toContain(MONO_FONT);
    expect(style.fontFamily).toContain(BODY_FONT);
    expect(Number.parseFloat(style.fontSize)).toBeCloseTo(28, 0);
    expect(Number(style.fontWeight)).toBeGreaterThanOrEqual(700);

    const bodyView = mount((parent) => createEditor(parent, { doc: DOC }));
    revealAll(bodyView);
    const h1Size = Number.parseFloat(getComputedStyle(lineByClass(bodyView, "cm-lp-h1")).fontSize);
    expect(Number.parseFloat(style.fontSize)).toBeGreaterThan(h1Size);
  });
});

const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function lineElement(view: EditorView, lineNumber: number): HTMLElement {
  // 空行は文字が無く、`from + 1` が次の行へ出るので、行頭の位置から探す
  const { node } = view.domAtPos(view.state.doc.line(lineNumber).from);
  const found = node instanceof HTMLElement ? node : node.parentElement;
  const line = found?.closest(".cm-line") ?? found?.querySelector(".cm-line");
  if (!(line instanceof HTMLElement)) throw new Error(`line ${lineNumber} is not rendered`);
  return line;
}

describe("見出しの上の余白", () => {
  const HEADINGS = ["# a", "## b", "### c", "#### d", "##### e", "###### f"];

  const paddingTop = (view: EditorView, lineNumber: number) =>
    Number.parseFloat(getComputedStyle(lineElement(view, lineNumber)).paddingTop);

  it("見出しの階層が上がるほど上の余白を広げ、h4〜h6 は同じ幅にする", () => {
    const view = mount((parent) =>
      createEditor(parent, { doc: ["本文", ...HEADINGS, "本文"].join("\n") }),
    );
    const [h1, h2, h3, h4, h5, h6] = [2, 3, 4, 5, 6, 7].map((n) => paddingTop(view, n));
    expect(paddingTop(view, 1)).toBe(0);
    expect(paddingTop(view, 8)).toBe(0);
    expect(h1).toBeGreaterThan(h2 ?? 0);
    expect(h2).toBeGreaterThan(h3 ?? 0);
    expect(h3).toBeGreaterThan(h4 ?? 0);
    expect(h4).toBeGreaterThan(0);
    expect(h5).toBe(h4);
    expect(h6).toBe(h4);
  });

  it("本文の 1 行目の見出しには上の余白を付けない", () => {
    const view = mount((parent) => createEditor(parent, { doc: "## 先頭\n\n## 2 つ目" }));
    expect(paddingTop(view, 1)).toBe(0);
    expect(paddingTop(view, 3)).toBeGreaterThan(0);
  });

  it("カーソルが入って `#` を出しても、見出しの行の位置、高さ、文字の位置が変わらない", async () => {
    const doc = ["本文", "", "## 見出し", "", "本文"].join("\n");
    const view = mount((parent) => createEditor(parent, { doc }));
    const textFrom = view.state.doc.line(3).from + 3;
    await nextFrame();
    const measure = () => {
      const rect = lineElement(view, 3).getBoundingClientRect();
      const block = view.lineBlockAt(textFrom);
      return {
        top: rect.top,
        height: rect.height,
        text: view.coordsAtPos(textFrom, 1)?.top,
        // CodeMirror が持つ高さが DOM と合っていること（margin だと合わず、クリック位置がずれる）
        blockHeight: Math.round(block.height),
      };
    };
    const hidden = measure();
    expect(hidden.blockHeight).toBe(Math.round(hidden.height));

    view.focus();
    view.dispatch({ selection: EditorSelection.cursor(textFrom) });
    await nextFrame();
    expect(lineElement(view, 3).textContent).toBe("## 見出し");
    const revealed = measure();
    expect(revealed.top).toBeCloseTo(hidden.top, 1);
    expect(revealed.height).toBeCloseTo(hidden.height, 1);
    expect(revealed.text).toBeCloseTo(hidden.text ?? Number.NaN, 1);
    expect(revealed.blockHeight).toBe(hidden.blockHeight);
  });
});

describe("見出しの前後の余白", () => {
  const topOf = (view: EditorView, lineNumber: number) =>
    lineElement(view, lineNumber).getBoundingClientRect().top;

  it("見出しの上の余白は、下の余白より広い", async () => {
    const view = mount((parent) => createEditor(parent, { doc: "前\n\n## 見出し\n\n- 項目" }));
    await nextFrame();
    const heading = lineElement(view, 3);
    // 見出しの上の余白は行の padding なので、行の上端でなく padding の下から測る
    const above =
      heading.getBoundingClientRect().top +
      Number.parseFloat(getComputedStyle(heading).paddingTop) -
      lineElement(view, 1).getBoundingClientRect().bottom;
    const item = view.coordsAtPos(view.state.doc.line(5).from + 2);
    if (!item) throw new Error("項目の位置が測れない");
    const below = item.top - heading.getBoundingClientRect().bottom;
    expect(above).toBeGreaterThan(below);
  });

  it("カーソルが見出しの直後の空行に出入りしても、下の行の位置が変わらない", async () => {
    const view = mount((parent) => createEditor(parent, { doc: "前\n\n## 見出し\n\n本文" }));
    await nextFrame();
    const before = [1, 2, 3, 4, 5].map((n) => topOf(view, n));
    view.focus();
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(4).from) });
    await nextFrame();
    expect([1, 2, 3, 4, 5].map((n) => topOf(view, n))).toEqual(before);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    await nextFrame();
    expect([1, 2, 3, 4, 5].map((n) => topOf(view, n))).toEqual(before);
    // CodeMirror が持つ高さも DOM と合う（ずれるとクリック位置とスクロールがずれる）
    const block = view.lineBlockAt(view.state.doc.line(4).from);
    expect(Math.round(block.height)).toBe(
      Math.round(lineElement(view, 4).getBoundingClientRect().height),
    );
  });
});
