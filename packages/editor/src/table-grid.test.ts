import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createEditor } from "./create-editor";
import { expectNear, over, resolve } from "./test-contrast";

/** 表の rendered 表示の見た目（罫線、見出し行の地、`|` の不可視）。描画の有無と列の揃えは table.test.ts */

const TABLE = "| 名前 | 値 |\n| --- | --- |\n| りんご | 100 |\n| banana split | 2 |";
const DOC = `前置き\n\n${TABLE}\n\n後ろ`;

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc = DOC, widthPx?: number): EditorView {
  host = document.createElement("div");
  if (widthPx !== undefined) host.style.width = `${widthPx}px`;
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

const lines = (v: EditorView) => [...v.contentDOM.querySelectorAll<HTMLElement>(".cm-line")];
const rowCells = (row: Element | undefined) => [
  ...(row?.querySelectorAll<HTMLElement>(".cm-lp-table-cell") ?? []),
];
const px = (value: string) => Number.parseFloat(value);
const cellRights = (row: Element) =>
  rowCells(row).map((cell) => cell.getBoundingClientRect().right);
/** 前置きと空行の後の、表の 4 行（header、区切り行、本文 2 行） */
const tableLines = (v: EditorView) => lines(v).slice(2, 6);

describe("table grid", () => {
  it("paints every pipe transparent, including the syntax-highlight span inside it", () => {
    // `|` は構文ハイライト（TableDelimiter は t.meta の子の tag）の span に包まれて描かれ、その span が
    // 自分の色を持つ。pipe の mark にだけ透明を指定しても、中の span の色が勝って `|` が見える。
    const v = mount();
    const pipes = [...v.contentDOM.querySelectorAll<HTMLElement>(".cm-lp-table-pipe")];
    expect(pipes).toHaveLength(9);
    for (const pipe of pipes) {
      for (const element of [pipe, ...pipe.querySelectorAll<HTMLElement>("*")]) {
        expect(getComputedStyle(element).color).toBe("rgba(0, 0, 0, 0)");
      }
    }
    expect(pipes.some((pipe) => pipe.querySelector("*") !== null)).toBe(true);
  });

  it("closes the grid: every cell draws its right and bottom lines, the first column the left", () => {
    const v = mount();
    const [header, , first, second] = tableLines(v);
    for (const row of [header, first, second]) {
      const cells = rowCells(row);
      expect(cells).toHaveLength(2);
      for (const [column, cell] of cells.entries()) {
        const style = getComputedStyle(cell);
        expect(px(style.borderRightWidth)).toBeGreaterThan(0);
        expect(px(style.borderBottomWidth)).toBeGreaterThan(0);
        expect(px(style.borderLeftWidth) > 0).toBe(column === 0);
      }
    }
    for (const cell of rowCells(header)) {
      expect(px(getComputedStyle(cell).borderTopWidth)).toBeGreaterThan(0);
    }
    for (const cell of [...rowCells(first), ...rowCells(second)]) {
      expect(px(getComputedStyle(cell).borderTopWidth)).toBe(0);
    }
  });

  it("draws a heavier line under the header than under a body row", () => {
    const v = mount();
    const [header, , first] = tableLines(v);
    const bottom = (row: Element | undefined) =>
      px(getComputedStyle(rowCells(row)[0] as Element).borderBottomWidth);
    expect(bottom(header)).toBeGreaterThan(bottom(first));
  });

  it("leaves no gap between the cells of a row, so the lines run unbroken", () => {
    // `|` の字幅が残ると、セルの下の線がそこで途切れる
    const v = mount();
    const [header, , first, second] = tableLines(v);
    for (const row of [header, first, second]) {
      const [left, right] = rowCells(row).map((cell) => cell.getBoundingClientRect());
      expect(Math.abs((right?.left ?? 0) - (left?.right ?? 0))).toBeLessThan(0.5);
    }
  });

  it("ends every row at the same right edge, so the outer frame is a straight line", () => {
    const v = mount();
    const [header, , first, second] = tableLines(v);
    const rightEdge = (row: Element | undefined) =>
      rowCells(row).at(-1)?.getBoundingClientRect().right;
    const expected = rightEdge(header);
    expect(expected).toBeDefined();
    for (const row of [first, second]) {
      expect(Math.abs((rightEdge(row) ?? 0) - (expected ?? 0))).toBeLessThan(1);
    }
    // 行（`.cm-line`）は線を持たない。持たせると線が表の右端を越えて editor の幅いっぱいに伸びる
    for (const row of [header, first, second]) {
      expect(px(getComputedStyle(row as Element).borderBottomWidth)).toBe(0);
    }
  });

  it("lays the header row on --ui-color-surface and leaves body rows on the editor background", () => {
    const v = mount();
    const [header, , first] = tableLines(v);
    const surface = resolve(v.contentDOM, "var(--ui-color-surface)");
    const background = resolve(v.contentDOM, "var(--ui-color-background)");
    // 選択範囲を透かすため地は半透明。エディタ面に重ねた色が surface 色になる
    for (const cell of rowCells(header)) {
      expectNear(over(getComputedStyle(cell).backgroundColor, background), surface);
    }
    for (const cell of rowCells(first)) {
      expect(getComputedStyle(cell).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    }
  });

  it("draws the left edge of a table written without outer pipes", () => {
    const v = mount("a | b\n-- | --\nc | d");
    const [header, , body] = lines(v);
    for (const row of [header, body]) {
      const [firstCell, lastCell] = rowCells(row);
      expect(px(getComputedStyle(firstCell as Element).borderLeftWidth)).toBeGreaterThan(0);
      expect(px(getComputedStyle(lastCell as Element).borderRightWidth)).toBeGreaterThan(0);
    }
  });

  it("gives an empty cell without spaces its own box, so later columns stay aligned", () => {
    // `||` の間は幅 0 で mark が付かない。箱が無いと後ろの列が左へずれ、行の右端に段差ができる
    const v = mount("| a | b | c |\n| - | - | - |\n| x || z |\n|| y | z |");
    const [header, , middleEmpty, firstEmpty] = lines(v);
    const lefts = (row: Element | undefined) =>
      rowCells(row).map((cell) => cell.getBoundingClientRect().left);
    const expected = lefts(header);
    expect(expected).toHaveLength(3);
    for (const row of [middleEmpty, firstEmpty]) {
      const actual = lefts(row);
      expect(actual).toHaveLength(3);
      for (const [i, left] of actual.entries()) {
        expect(Math.abs(left - (expected[i] ?? 0))).toBeLessThan(1);
      }
    }
    const [emptyFirst] = rowCells(firstEmpty);
    expect(emptyFirst?.textContent).toBe("");
    expect(px(getComputedStyle(emptyFirst as Element).borderLeftWidth)).toBeGreaterThan(0);
    expect(v.state.doc.toString()).toBe("| a | b | c |\n| - | - | - |\n| x || z |\n|| y | z |");
  });

  describe("at a narrow width", () => {
    // 390px の画面で本文の欄に入る幅。長いセルの文字幅だけで欄の幅を超える
    const NARROW_PX = 320;
    const LONG = "折り返しを確かめるための長い説明文。".repeat(4);
    const URL = `https://example.com/${"a".repeat(60)}`;
    const NARROW_TABLE = `| 項目 | 説明 | 参照 |\n| --- | --- | --- |\n| 長い | ${LONG} | ${URL} |\n| 短い || x |`;

    const mountNarrow = (doc = NARROW_TABLE) => mount(doc, NARROW_PX);

    /** 行の中身の欄（padding の内側）の左右端 */
    const contentBox = (row: HTMLElement) => {
      const rect = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      return {
        left: rect.left + px(style.paddingLeft),
        right: rect.right - px(style.paddingRight),
      };
    };

    const tableRows = (v: EditorView) => lines(v).filter((row) => rowCells(row).length > 0);

    function expectInsideTextColumn(v: EditorView, rowCount: number): void {
      const rows = tableRows(v);
      expect(rows).toHaveLength(rowCount);
      for (const row of rows) {
        const box = contentBox(row);
        const cells = rowCells(row);
        const top = cells[0]?.getBoundingClientRect().top ?? 0;
        for (const cell of cells) {
          const rect = cell.getBoundingClientRect();
          expect(rect.left).toBeGreaterThanOrEqual(box.left - 0.5);
          expect(rect.right).toBeLessThanOrEqual(box.right + 0.5);
          // 欄に入っていても、セルが次の表示行へ送られていれば格子は閉じない
          expect(Math.abs(rect.top - top)).toBeLessThan(0.5);
        }
      }
      expect(v.scrollDOM.scrollWidth).toBeLessThanOrEqual(v.scrollDOM.clientWidth);
    }

    it("keeps every cell inside the text column and leaves nothing to scroll sideways", async () => {
      const v = mountNarrow();
      await new Promise(requestAnimationFrame);
      expectInsideTextColumn(v, 3);
    });

    it("narrows only the long columns and leaves the short ones at their measured width", async () => {
      // 実測の幅に比例して縮めると、短い列が数 px に潰れて見出しの語が 1 字ずつ折り返す
      const v = mountNarrow();
      await new Promise(requestAnimationFrame);
      const [header] = tableRows(v);
      const [first, long, url] = rowCells(header);
      if (!first || !long || !url) throw new Error("cells are not rendered");
      const measured = px(first.style.getPropertyValue("--cm-lp-table-width"));
      expect(px(getComputedStyle(first).width)).toBeGreaterThanOrEqual(measured - 0.5);
      // 長い 2 列は同じ上限にそろう
      expect(
        Math.abs(long.getBoundingClientRect().width - url.getBoundingClientRect().width),
      ).toBeLessThan(1);
    });

    it("splits the width evenly when even the short columns do not fit", async () => {
      // 列は線、padding、1 字の幅の合計より細くならず、本数を増やすといずれ欄に入らなくなる。何本で
      // 溢れるかは書体と文字の大きさで変わるので、8 本は入ることだけを確かめる
      const wide = "長い見出し".repeat(2);
      const header = `| ${Array.from({ length: 8 }, () => wide).join(" | ")} |`;
      const v = mountNarrow(`${header}\n|${" - |".repeat(8)}\n|${" x |".repeat(8)}`);
      await new Promise(requestAnimationFrame);
      expectInsideTextColumn(v, 2);
    });

    describe("with right-aligned columns padded by prettier", () => {
      // 数字の前の空白だけで、詰めた列の上限を超える。多桁の値は列の上限には収まる幅にする
      const ALIGNED = [
        "| Item | Description of the amount | Number of occurrences in total |",
        "| --- | ---: | ---: |",
        "| apple pie with cream | 1 | 2 |",
        "| b |                        12 |                              3 |",
        "| c |                 1,234,567 |                          12345 |",
      ].join("\n");

      /** セルの中の描かれる字の右端（隠した前後の空白を除く） */
      function textRight(cell: HTMLElement): number {
        let right = Number.NEGATIVE_INFINITY;
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            if (rect.width > 0) right = Math.max(right, rect.right);
          }
        }
        return right;
      }

      it("keeps every row of a column the same width and leaves nothing to scroll", async () => {
        const v = mountNarrow(ALIGNED);
        await new Promise(requestAnimationFrame);
        expectInsideTextColumn(v, 4);
        const [header, ...body] = tableRows(v).map(cellRights);
        for (const row of body) {
          for (const [column, right] of row.entries()) {
            expect(Math.abs(right - (header?.[column] ?? 0))).toBeLessThan(0.5);
          }
        }
      });

      it("keeps a many-digit value on one line", async () => {
        const v = mountNarrow(ALIGNED);
        await new Promise(requestAnimationFrame);
        const row = tableRows(v)[3];
        const cells = rowCells(row);
        expect(cells).toHaveLength(3);
        for (const cell of cells) {
          const style = getComputedStyle(cell);
          expect(px(style.height)).toBeLessThan(px(style.lineHeight) * 1.5);
        }
      });

      it("ends the text of a right-aligned cell at the right edge of its content box", async () => {
        const v = mountNarrow(ALIGNED);
        await new Promise(requestAnimationFrame);
        for (const row of tableRows(v).slice(1)) {
          for (const cell of rowCells(row).slice(1, 3)) {
            const style = getComputedStyle(cell);
            const contentRight =
              cell.getBoundingClientRect().right -
              px(style.borderRightWidth) -
              px(style.paddingRight);
            expect(Math.abs(textRight(cell) - contentRight)).toBeLessThan(1);
          }
        }
      });
    });

    it("keeps a table inside a blockquote within the quote's text column", async () => {
      const quoted = NARROW_TABLE.split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      const v = mountNarrow(quoted);
      await new Promise(requestAnimationFrame);
      expectInsideTextColumn(v, 3);
    });

    it("keeps the indent of a table inside a list item and still fits the column", async () => {
      // 字下げの空白は flex の行の中で mark に包まないと描かれず、表が左端へ寄る
      const nested = NARROW_TABLE.split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      const v = mountNarrow(`- 項目\n\n${nested}`);
      await new Promise(requestAnimationFrame);
      expectInsideTextColumn(v, 3);
      for (const row of tableRows(v)) {
        const indent = (rowCells(row)[0]?.getBoundingClientRect().left ?? 0) - contentBox(row).left;
        expect(indent).toBeGreaterThan(4);
      }
    });

    it("wraps a long cell inside its column and keeps the grid closed", async () => {
      const v = mountNarrow();
      await new Promise(requestAnimationFrame);
      const rows = lines(v).filter((row) => rowCells(row).length > 0);
      const rects = rows.map((row) => rowCells(row).map((cell) => cell.getBoundingClientRect()));
      const [header, long, short] = rects;
      if (!header || !long || !short) throw new Error("rows are not rendered");
      // セルが次の表示行へ送られず、同じ行のセルは同じ高さで下の線がそろう
      for (const row of rects) {
        expect(row).toHaveLength(3);
        for (const cell of row) {
          expect(Math.abs(cell.top - (row[0]?.top ?? 0))).toBeLessThan(0.5);
          expect(Math.abs(cell.bottom - (row[0]?.bottom ?? 0))).toBeLessThan(0.5);
        }
      }
      // 長いセルは列の中で折り返し、行が高くなる
      expect(long[1]?.height ?? 0).toBeGreaterThan((short[1]?.height ?? 0) * 2);
      // 列は行をまたいでそろい、外枠の右端は一直線になる
      for (const row of [long, short]) {
        for (const [column, cell] of row.entries()) {
          expect(Math.abs(cell.left - (header[column]?.left ?? 0))).toBeLessThan(1);
          expect(Math.abs(cell.right - (header[column]?.right ?? 0))).toBeLessThan(1);
        }
      }
    });

    it("starts a cell whose first word is longer than the column on its first line", async () => {
      // セルの頭の空白の後ろで折り返すと、1 行目が空白だけになって中身が 1 行下がる
      const v = mountNarrow();
      await new Promise(requestAnimationFrame);
      const url = rowCells(tableRows(v)[1] as HTMLElement)[2];
      if (!url) throw new Error("cell is not rendered");
      const walker = document.createTreeWalker(url, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.textContent?.includes("https")) node = walker.nextNode();
      if (!node) throw new Error("URL text is not rendered");
      const offset = node.textContent?.indexOf("https") ?? 0;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const lineHeight = px(getComputedStyle(url).lineHeight);
      expect(range.getBoundingClientRect().top - url.getBoundingClientRect().top).toBeLessThan(
        lineHeight / 2,
      );
    });

    /** セルの空白でない字を表示行ごとにまとめ、各行の最も左の字の left を上から返す */
    function lineStarts(cell: HTMLElement): number[] {
      const starts = new Map<number, number>();
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        for (let i = 0; i < text.length; i++) {
          if (/\s/.test(text[i] ?? "")) continue;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getBoundingClientRect();
          if (rect.width === 0) continue;
          const top = Math.round(rect.top);
          starts.set(top, Math.min(starts.get(top) ?? Number.POSITIVE_INFINITY, rect.left));
        }
      }
      return [...starts.entries()].sort(([a], [b]) => a - b).map(([, left]) => left);
    }

    it("starts the first and the wrapped lines of a long cell at the left of its content box", async () => {
      // 頭の空白を描くと、1 行目だけが空白の分だけ右に寄る
      const v = mountNarrow();
      await new Promise(requestAnimationFrame);
      const cell = rowCells(tableRows(v)[1] as HTMLElement)[1];
      if (!cell) throw new Error("cell is not rendered");
      const style = getComputedStyle(cell);
      const contentLeft =
        cell.getBoundingClientRect().left + px(style.borderLeftWidth) + px(style.paddingLeft);
      const starts = lineStarts(cell);
      expect(starts.length).toBeGreaterThan(1);
      for (const start of starts) expect(Math.abs(start - contentLeft)).toBeLessThan(0.5);
    });
  });

  it.each([
    ["tag", "| #tag | x |\n| --- | --- |\n| a | b |", ".cm-tag"],
    ["wikilink", "| [[page]] | x |\n| --- | --- |\n| a | b |", ".cm-wikilink"],
  ])("keeps a %s at the start of a cell in one element", async (_name, doc, selector) => {
    // セルの頭に付ける mark が、最初の字から始まる inline mark を 2 つに割らない
    const v = mount(doc);
    await new Promise(requestAnimationFrame);
    const cell = rowCells(lines(v)[0])[0];
    expect(cell?.querySelectorAll(selector)).toHaveLength(1);
  });

  it("aligns every row, header included, from the delimiter row and keeps a blank cell's height", () => {
    const v = mount("| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| a | b |   |");
    const [header, , body] = lines(v);
    for (const row of [header, body]) {
      const [left, center, right] = rowCells(row).map((cell) => getComputedStyle(cell).textAlign);
      expect(["left", "start"]).toContain(left);
      expect(center).toBe("center");
      expect(right).toBe("right");
    }
    // 空白だけのセルは空白ごと描くので、隣のセルと同じ高さを保つ
    const [, neighbour, blank] = rowCells(body).map((cell) => cell.getBoundingClientRect());
    expect(neighbour?.height ?? 0).toBeGreaterThan(0);
    expect(Math.abs((blank?.height ?? 0) - (neighbour?.height ?? 0))).toBeLessThan(0.5);
  });

  it("gives an empty cell the same height as its neighbours, so its borders are drawn", () => {
    // 中身の無い inline-block は高さ 0 になり、その列だけ縦の線と下の線が消える
    const v = mount("| a | b | c |\n| - | - | - |\n| x || z |\n|| y | z |");
    const [, , middleEmpty, firstEmpty] = lines(v);
    for (const [row, emptyIndex] of [
      [middleEmpty, 1],
      [firstEmpty, 0],
    ] as const) {
      const rects = rowCells(row).map((cell) => cell.getBoundingClientRect());
      const empty = rects[emptyIndex];
      const neighbour = rects[emptyIndex + 1];
      if (!empty || !neighbour) throw new Error("cells are not rendered");
      expect(neighbour.height).toBeGreaterThan(0);
      expect(Math.abs(empty.height - neighbour.height)).toBeLessThan(0.5);
      expect(Math.abs(empty.bottom - neighbour.bottom)).toBeLessThan(0.5);
    }
  });
});
