import { syntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { type CreateEditorOptions, createEditor } from "./create-editor";

const TABLE = "| 名前 | 値 |\n| --- | --- |\n| りんご | 100 |\n| banana split | 2 |";
const DOC = `前置き\n\n${TABLE}\n\n後ろ`;
const tableFrom = DOC.indexOf("| 名前");
const tableTo = tableFrom + TABLE.length;

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc = DOC, options: CreateEditorOptions = {}): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, { doc, ...options });
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

const placeCursor = (v: EditorView, pos: number) => {
  v.focus();
  v.dispatch({ selection: EditorSelection.cursor(pos) });
};

const lines = (v: EditorView) => [...v.contentDOM.querySelectorAll<HTMLElement>(".cm-line")];
const cells = (v: EditorView) => v.contentDOM.querySelectorAll(".cm-lp-table-cell");
/** 前置き・空行の後の、表の 4 行（header、区切り行、本文 2 行） */
const tableLines = (v: EditorView) => lines(v).slice(2, 6);

describe("table decoration", () => {
  it("parses GFM tables in the editor syntax tree", () => {
    const v = mount();
    const names: string[] = [];
    for (let n = syntaxTree(v.state).resolveInner(tableFrom + 2, 1); n.parent; n = n.parent) {
      names.push(n.name);
    }
    expect(names).toEqual(["TableCell", "TableHeader", "Table"]);
  });

  it("renders the table while the editor is not focused", () => {
    const v = mount();
    expect(v.hasFocus).toBe(false);
    const [header, delimiter, first, second] = tableLines(v);
    expect(delimiter?.classList.contains("cm-lp-table-delimiter")).toBe(true);
    for (const row of [header, first, second]) {
      expect(row?.querySelectorAll(".cm-lp-table-cell")).toHaveLength(2);
      expect(row?.querySelectorAll(".cm-lp-table-pipe")).toHaveLength(3);
    }
    expect(header?.querySelectorAll(".cm-lp-table-cell.cm-lp-table-header")).toHaveLength(2);
    expect(first?.querySelector(".cm-lp-table-header")).toBeNull();
  });

  it("keeps every character of the source in the DOM", () => {
    // Decoration.replace を使わないことの確認。隠した記法が DOM から消えていれば一致しない
    const v = mount();
    expect(
      lines(v)
        .map((line) => line.textContent)
        .join("\n"),
    ).toBe(DOC);
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it("aligns the column separators across rows, including full-width text", () => {
    const v = mount();
    const [header, , first, second] = tableLines(v);
    const pipeLefts = (row: HTMLElement | undefined) =>
      [...(row?.querySelectorAll(".cm-lp-table-pipe") ?? [])].map(
        (pipe) => pipe.getBoundingClientRect().left,
      );
    const expected = pipeLefts(header);
    expect(expected).toHaveLength(3);
    for (const row of [first, second]) {
      const actual = pipeLefts(row);
      expect(actual).toHaveLength(expected.length);
      for (const [i, left] of actual.entries()) {
        expect(Math.abs(left - (expected[i] ?? 0))).toBeLessThan(1);
      }
    }
  });

  it("collapses the delimiter row", () => {
    const v = mount();
    const [header, delimiter] = tableLines(v);
    expect(delimiter?.getBoundingClientRect().height).toBeLessThan(
      (header?.getBoundingClientRect().height ?? 0) / 2,
    );
  });

  it("reveals the whole table as source when the cursor is inside a cell", () => {
    const v = mount();
    placeCursor(v, DOC.indexOf("りんご") + 1);
    expect(v.hasFocus).toBe(true);
    expect(cells(v)).toHaveLength(0);
    expect(v.contentDOM.querySelector(".cm-lp-table-delimiter")).toBeNull();
  });

  it("aligns a column by its real rendered width, not by character count", () => {
    // "iiii" と "WWWW" は文字数（旧 ch 単位の実装での列幅）が同じでも、実際の描画幅は
    // 大きく異なる。プロポーショナルフォントでの回帰（本文の書体は monospace ではない）を
    // 検出するための test。
    const doc = "| a | fixed |\n| - | - |\n| iiiiiiiiii | fixed |\n| WWWWWWWWWW | fixed |";
    const v = mount(doc);
    const [, , narrowRow, wideRow] = lines(v);
    const secondColumnLeft = (row: HTMLElement | undefined) =>
      row?.querySelectorAll(".cm-lp-table-pipe")[1]?.getBoundingClientRect().left;
    const narrowLeft = secondColumnLeft(narrowRow);
    const wideLeft = secondColumnLeft(wideRow);
    expect(narrowLeft).toBeDefined();
    expect(wideLeft).toBeDefined();
    expect(Math.abs((narrowLeft ?? 0) - (wideLeft ?? 0))).toBeLessThan(1);
  });

  it("aligns the columns even when the host makes every element border-box", () => {
    // ホストが全要素を border-box にすることがある。min-width が padding と線を含むと、
    // 文字の長い行だけセルが押し広げられて列がずれる
    const style = document.createElement("style");
    style.textContent = "*, ::before, ::after { box-sizing: border-box; }";
    document.head.append(style);
    try {
      const doc = "| a | fixed |\n| - | - |\n| iiiiiiiiii | fixed |\n| WWWWWWWWWW | fixed |";
      const v = mount(doc);
      const [header, , narrowRow, wideRow] = lines(v);
      const cellRights = (row: HTMLElement | undefined) =>
        [...(row?.querySelectorAll(".cm-lp-table-cell") ?? [])].map(
          (cell) => cell.getBoundingClientRect().right,
        );
      const expected = cellRights(header);
      expect(expected).toHaveLength(2);
      for (const row of [narrowRow, wideRow]) {
        for (const [i, right] of cellRights(row).entries()) {
          expect(Math.abs(right - (expected[i] ?? 0))).toBeLessThan(1);
        }
      }
    } finally {
      style.remove();
    }
  });

  it("measures the header row at a bold font, and the body row at the normal weight", () => {
    // TableHeader の中身は構文ハイライトが tags.heading を当てて bold で描かれる（theme.ts）。
    // 本文の weight で測ると header セルの実描画幅が min-width を上回り、header の文字が
    // 長い列ほど pipe が右にずれる（このずれ自体は、実フォントの描画幅を測るブラウザの E2E でしか
    // 確かめられない。vitest browser mode は決定づけの getComputedStyle が
    // 初回 build 時にホストの stylesheet 適用前の値を返すことがあり、min-width の絶対値や
    // 実描画の overflow をここで検証すると測定条件がテストごとに揺れて regression を検出できない）。
    //
    // ここでは実描画幅ではなく、measureText に渡す ctx.font の weight が header 行と本文行で
    // 実際に切り替わっていることを直接検証する。これは editorFont() の分岐そのものを見るので、
    // getComputedStyle が返す値が何であっても（フォールバックのフォントでも）確実に検出できる。
    const fontDescriptor = Object.getOwnPropertyDescriptor(
      CanvasRenderingContext2D.prototype,
      "font",
    );
    if (!fontDescriptor?.set || !fontDescriptor.get) throw new Error("font accessor not found");
    const fonts: string[] = [];
    Object.defineProperty(CanvasRenderingContext2D.prototype, "font", {
      configurable: true,
      get: fontDescriptor.get,
      set(this: CanvasRenderingContext2D, value: string) {
        fonts.push(value);
        fontDescriptor.set?.call(this, value);
      },
    });
    try {
      mount("| header | x |\n| - | - |\n| a | y |");
    } finally {
      Object.defineProperty(CanvasRenderingContext2D.prototype, "font", fontDescriptor);
    }

    expect(fonts.length).toBeGreaterThan(0);
    // "700" は table.ts の TABLE_HEADER_FONT_WEIGHT と同じ値（非公開なのでここでは直値）
    const headerFonts = fonts.filter((font) => font.includes("700"));
    const bodyFonts = fonts.filter((font) => !font.includes("700"));
    expect(headerFonts).toHaveLength(1); // TableHeader は 1 行だけ
    expect(bodyFonts).toHaveLength(1); // TableRow も 1 行だけ
  });

  it("sets the column width in pixels rather than character units", () => {
    const v = mount();
    const cell = cells(v)[0] as HTMLElement;
    expect(cell.style.getPropertyValue("--cm-lp-table-width")).toMatch(/^\d+px$/);
    // 欄に収まる幅では、実測の幅がそのまま列の幅（の下限）になる
    const measured = Number.parseFloat(cell.style.getPropertyValue("--cm-lp-table-width"));
    expect(Number.parseFloat(getComputedStyle(cell).width)).toBeGreaterThanOrEqual(measured);
  });

  it("hides only ASCII spaces around a cell and keeps an ideographic-space indent", () => {
    // GFM が除くのは ASCII の空白とタブだけで、全角空白の字下げは中身として描く
    const ideographicSpace = String.fromCodePoint(0x3000);
    const v = mount(`| ${ideographicSpace}小項目 | 値 |\n| --- | --- |\n| a | b |`);
    const cell = cells(v)[0] as HTMLElement;
    const hidden = [...cell.querySelectorAll(".cm-lp-table-space")].map((el) => el.textContent);
    expect(hidden).toEqual([" ", " "]);
    const shown = [...cell.childNodes]
      .filter((n) => !(n instanceof HTMLElement && n.classList.contains("cm-lp-table-space")))
      .map((n) => n.textContent)
      .join("");
    expect(shown).toBe(`${ideographicSpace}小項目`);
  });

  it("adds horizontal padding around each cell's text", () => {
    const v = mount();
    const cell = cells(v)[0] as HTMLElement;
    const style = getComputedStyle(cell);
    expect(Number.parseFloat(style.paddingLeft)).toBeGreaterThan(0);
    expect(Number.parseFloat(style.paddingRight)).toBeGreaterThan(0);
  });

  it("reveals the table when the cursor sits right after its last row", () => {
    const v = mount();
    placeCursor(v, tableTo);
    expect(cells(v)).toHaveLength(0);
  });

  it("renders the table again once the cursor leaves it", () => {
    const v = mount();
    placeCursor(v, tableFrom + 3);
    expect(cells(v)).toHaveLength(0);
    placeCursor(v, DOC.length);
    expect(cells(v)).toHaveLength(6);
  });

  it("reveals the table when the cursor sits before the indent of its first row", () => {
    // 行頭の字下げは Table の外にある。rendered の行は flex で描くので、そこへ未確定の文字を入れさせない
    const doc = "- 項目\n\n  | a | b |\n  | - | - |\n  | c | d |  \n\n後ろ";
    const v = mount(doc);
    expect(cells(v)).toHaveLength(4);
    placeCursor(v, doc.indexOf("  | a"));
    expect(cells(v)).toHaveLength(0);
    // 最後の行の末尾の空白の後ろも同じ
    placeCursor(v, doc.indexOf("|  \n") + 3);
    expect(cells(v)).toHaveLength(0);
    placeCursor(v, doc.length);
    expect(cells(v)).toHaveLength(4);
  });

  it("keeps the table rendered while the cursor is on the empty line right after it", () => {
    const doc = `${TABLE}\n`;
    const v = mount(doc);
    placeCursor(v, doc.length);
    expect(cells(v)).toHaveLength(6);
  });

  it("reveals only the table the cursor is in", () => {
    const other = "| a | b |\n| - | - |\n| c | d |";
    const doc = `${TABLE}\n\n${other}`;
    const v = mount(doc);
    placeCursor(v, doc.indexOf("| c |") + 2);
    expect(cells(v)).toHaveLength(6);
    expect([...cells(v)].map((cell) => cell.textContent?.trim())).toContain("banana split");
  });

  it("counts empty cells as columns so later columns stay aligned", () => {
    const doc = "| a | | c |\n| - | - | - |\n| | x | long text |";
    const v = mount(doc);
    const [header, , body] = lines(v);
    const lefts = (row: HTMLElement | undefined) =>
      [...(row?.querySelectorAll(".cm-lp-table-pipe") ?? [])].map(
        (pipe) => pipe.getBoundingClientRect().left,
      );
    const expected = lefts(header);
    expect(expected).toHaveLength(4);
    for (const [i, left] of lefts(body).entries()) {
      expect(Math.abs(left - (expected[i] ?? 0))).toBeLessThan(1);
    }
  });

  it("renders a table without outer pipes", () => {
    const doc = "a | b\n-- | --\nc | d";
    const v = mount(doc);
    expect(cells(v)).toHaveLength(4);
    expect(v.contentDOM.querySelectorAll(".cm-lp-table-pipe")).toHaveLength(2);
  });

  it("keeps a WikiLink written with \\| in one cell", () => {
    const v = mount("| h | x |\n| - | - |\n| [[C\\|D]] | y |");
    const row = lines(v)[2];
    expect(row?.querySelectorAll(".cm-lp-table-cell")).toHaveLength(2);
    expect(row?.querySelector('[data-wikilink-target="C"]')).not.toBeNull();
  });

  it("does not decorate a paragraph that merely contains pipes", () => {
    const v = mount("a | b の段落\nc | d");
    expect(cells(v)).toHaveLength(0);
    expect(v.contentDOM.querySelector(".cm-lp-table-delimiter")).toBeNull();
  });

  it("leaves the table as source when live preview is disabled", () => {
    const v = mount(DOC, { livePreview: false });
    expect(cells(v)).toHaveLength(0);
  });

  describe("inside a blockquote", () => {
    const QUOTED = "> | 名前 | 値 |\n> | --- | --- |\n> | りんご | 100 |\n> | banana split | 2 |";
    const doc = `前置き\n\n${QUOTED}\n\n後ろ`;
    const quotedLines = (v: EditorView) => lines(v).slice(2, 6);
    const pipeLefts = (row: HTMLElement | undefined) =>
      [...(row?.querySelectorAll(".cm-lp-table-pipe") ?? [])].map(
        (pipe) => pipe.getBoundingClientRect().left,
      );

    it("aligns the columns and hides every quote mark while unfocused", () => {
      const v = mount(doc);
      const [header, delimiter, first, second] = quotedLines(v);
      expect(delimiter?.classList.contains("cm-lp-table-delimiter")).toBe(true);
      for (const line of [header, delimiter, first, second]) {
        expect(line?.classList.contains("cm-lp-blockquote")).toBe(true);
        expect(line?.textContent?.startsWith(">")).toBe(false);
      }
      expect(cells(v)).toHaveLength(6);
      const expected = pipeLefts(header);
      expect(expected).toHaveLength(3);
      for (const row of [first, second]) {
        const actual = pipeLefts(row);
        expect(actual).toHaveLength(expected.length);
        for (const [i, left] of actual.entries()) {
          expect(Math.abs(left - (expected[i] ?? 0))).toBeLessThan(1);
        }
      }
    });

    it("reveals the whole table but only the cursor line's quote mark", () => {
      const v = mount(doc);
      placeCursor(v, doc.indexOf("りんご") + 1);
      expect(cells(v)).toHaveLength(0);
      expect(v.contentDOM.querySelector(".cm-lp-table-delimiter")).toBeNull();
      const [header, delimiter, first, second] = quotedLines(v);
      expect(first?.textContent).toBe("> | りんご | 100 |");
      expect(header?.textContent).toBe("| 名前 | 値 |");
      expect(delimiter?.textContent).toBe("| --- | --- |");
      expect(second?.textContent).toBe("| banana split | 2 |");
    });

    it("renders both the table and the quote again once the cursor leaves", () => {
      const v = mount(doc);
      placeCursor(v, doc.indexOf("りんご") + 1);
      expect(cells(v)).toHaveLength(0);
      placeCursor(v, doc.length);
      expect(cells(v)).toHaveLength(6);
      for (const line of quotedLines(v)) {
        expect(line.textContent?.startsWith(">")).toBe(false);
      }
    });
  });
});

describe("empty cells", () => {
  const EMPTY_DOC = "前\n\n| a | b | c |\n| - | - | - |\n| x || z |\n\n後";
  const between = EMPTY_DOC.indexOf("||") + 1;
  const emptyCells = (v: EditorView) => v.contentDOM.querySelectorAll(".cm-lp-table-cell-empty");

  it("drops the empty-cell box while the table is revealed as source", () => {
    const v = mount(EMPTY_DOC);
    expect(emptyCells(v)).toHaveLength(1);
    placeCursor(v, between);
    expect(emptyCells(v)).toHaveLength(0);
    expect(cells(v)).toHaveLength(0);
  });

  it("turns the box into a regular cell once text is typed between the pipes", () => {
    const v = mount(EMPTY_DOC);
    placeCursor(v, between);
    v.dispatch({ changes: { from: between, insert: "y" } });
    placeCursor(v, v.state.doc.length);
    expect(emptyCells(v)).toHaveLength(0);
    const row = lines(v).find((line) => line.textContent?.includes("x"));
    const rowCells = [...(row?.querySelectorAll(".cm-lp-table-cell") ?? [])];
    expect(rowCells.map((cell) => cell.textContent?.trim())).toEqual(["x", "y", "z"]);
  });
});
