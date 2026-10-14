import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { CODE_END_LABEL, CODE_START_LABEL } from "./code-block";
import { createEditor } from "./create-editor";
import { resolve, toRgb } from "./test-contrast";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc: string, extensions: Extension = []): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, { doc, extensions });
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

const codeLines = (v: EditorView) => [...v.contentDOM.querySelectorAll(".cm-lp-code")];

describe("code block decoration", () => {
  it("applies the line class to every line of a fenced code block, including the fences", () => {
    const v = mount("前\n\n```\nconst a = 1;\nconst b = 2;\n```\n\n後");
    const lines = codeLines(v);
    expect(lines).toHaveLength(4);
    // focus の無い view ではフェンスの中身は隠れ、行だけが残る
    expect(lines.map((line) => line.textContent)).toEqual(["", "const a = 1;", "const b = 2;", ""]);
  });

  it("applies the line class to a language-tagged fence", () => {
    const v = mount("```ts\nconst a: number = 1;\n```");
    const lines = codeLines(v);
    expect(lines).toHaveLength(3);
    expect(lines[0]?.querySelector(".cm-lp-code-language")).not.toBeNull();
  });

  it("applies the line class to an indented code block", () => {
    const v = mount("前\n\n    const a = 1;\n\n後");
    const lines = codeLines(v);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toBe("    const a = 1;");
  });

  it("does not apply the class to lines outside a code block", () => {
    const v = mount("前\n\n```\ncode\n```\n\n後");
    expect(codeLines(v)).toHaveLength(3);
  });

  it("adds a background resolving to --ui-color-surface", () => {
    const v = mount("```\ncode\n```");
    const line = codeLines(v)[0];
    if (!line) throw new Error("code line is not rendered");
    const surface = resolve(v.contentDOM, "var(--ui-color-surface)");
    expect(toRgb(getComputedStyle(line).backgroundColor)).toEqual(surface);
  });

  it("adds left padding wider than a plain body line", () => {
    const v = mount("前\n\n```\ncode\n```");
    const codeLine = codeLines(v)[0];
    if (!codeLine) throw new Error("code line is not rendered");
    const bodyLine = [...v.contentDOM.querySelectorAll(".cm-line")].find(
      (line) => line.textContent === "前",
    );
    if (!bodyLine) throw new Error("body line is not rendered");

    // 地を本文の左端に揃えるため、padding の一部は margin に回っている。文字の位置は両方の合計
    const codeStyle = getComputedStyle(codeLine);
    const codePadding =
      Number.parseFloat(codeStyle.marginLeft) + Number.parseFloat(codeStyle.paddingLeft);
    const bodyPadding = Number.parseFloat(getComputedStyle(bodyLine).paddingLeft);
    expect(codePadding).toBeGreaterThan(bodyPadding);
  });

  it.each([
    ["a fenced code block", "前\n\n```ts\na\nb\n```\n\n後"],
    ["an indented code block", "前\n\n    a\n    b\n\n後"],
    // 1 行が上端と下端を兼ねる
    ["an unclosed block of only the opening fence", "前\n\n```ts"],
    ["a fenced code block in a list item", "- ```ts\n  a\n  b\n  ```\n\n後"],
  ])("leaves a gap outside the background above and below %s", (_, doc) => {
    const v = mount(doc);
    const lines = codeLines(v);
    const first = lines[0];
    const last = lines.at(-1);
    if (!first || !last) throw new Error("code lines are not rendered");
    const transparent = "rgba(0, 0, 0, 0)";

    const top = getComputedStyle(first);
    expect(Number.parseFloat(top.borderTopWidth)).toBeGreaterThan(0);
    expect(top.borderTopColor).toBe(transparent);
    expect(top.backgroundClip).toBe("padding-box");
    const bottom = getComputedStyle(last);
    expect(Number.parseFloat(bottom.borderBottomWidth)).toBeGreaterThan(0);
    expect(bottom.borderBottomColor).toBe(transparent);
    expect(bottom.backgroundClip).toBe("padding-box");
    for (const line of lines.slice(1, -1)) {
      const style = getComputedStyle(line);
      expect(Number.parseFloat(style.borderTopWidth)).toBe(0);
      expect(Number.parseFloat(style.borderBottomWidth)).toBe(0);
    }
  });

  it.each([
    ["a block", "```\na\n```"],
    ["an unclosed block of only the opening fence", "前\n\n```ts"],
    ["a block in a list item", "- ```ts\n  a\n  ```\n\n後"],
  ])("keeps the corners of the background of %s round below the gap", (_, doc) => {
    // 角丸は border の外側の縁で効く。隙間の分だけ縦の半径を足さないと、地の角が直角になる
    const v = mount(doc);
    const lines = codeLines(v);
    const inner = (line: Element | undefined, corner: string, border: string) => {
      const style = getComputedStyle(line as Element);
      const [horizontal = "", vertical = horizontal] = style.getPropertyValue(corner).split(" ");
      return {
        horizontal: Number.parseFloat(horizontal),
        vertical: Number.parseFloat(vertical) - Number.parseFloat(style.getPropertyValue(border)),
      };
    };
    for (const corner of [
      inner(lines[0], "border-top-left-radius", "border-top-width"),
      inner(lines[0], "border-top-right-radius", "border-top-width"),
      inner(lines.at(-1), "border-bottom-left-radius", "border-bottom-width"),
      inner(lines.at(-1), "border-bottom-right-radius", "border-bottom-width"),
    ]) {
      expect(corner.horizontal).toBeGreaterThan(0);
      expect(corner.vertical).toBeCloseTo(corner.horizontal, 1);
    }
  });
});

describe("wrapped code lines", () => {
  /** 320px の幅で 2 行以上に折り返す長さのコード */
  const LONG = `const message = "${"折り返しを確かめるための長いコード".repeat(3)}";`;

  const mountNarrow = (doc: string) => {
    const v = mount(doc);
    if (host) host.style.width = "320px";
    return v;
  };

  /** `lineNumber` 行目の、行頭から `offset` 文字目の x と、折り返した 2 つ目の表示行の始まりの x */
  function wrapStarts(v: EditorView, lineNumber: number, offset: number) {
    const line = v.state.doc.line(lineNumber);
    const start = v.coordsAtPos(line.from + offset, 1);
    if (!start) throw new Error("the line start has no coordinates");
    for (let pos = line.from + offset + 1; pos < line.to; pos += 1) {
      const coords = v.coordsAtPos(pos, 1);
      if (coords && coords.top > start.bottom - 1)
        return { start: start.left, wrapped: coords.left };
    }
    throw new Error(`line ${lineNumber} does not wrap`);
  }

  it.each([
    ["spaces", `\`\`\`ts\n    ${LONG}\n\`\`\``, 2, 4],
    ["a tab", `\`\`\`ts\n\t${LONG}\n\`\`\``, 2, 1],
    ["spaces after a tab", `\`\`\`ts\n\t  ${LONG}\n\`\`\``, 2, 3],
    ["the indentation of a list item", `- a\n\n  \`\`\`ts\n      ${LONG}\n  \`\`\``, 4, 6],
    ["an indented code block", `前\n\n        ${LONG}`, 3, 8],
  ])(
    "aligns the wrapped part of a line indented with %s to the indentation",
    (_, doc, lineNumber, offset) => {
      const v = mountNarrow(doc);
      const { start, wrapped } = wrapStarts(v, lineNumber, offset);
      expect(Math.abs(wrapped - start)).toBeLessThan(1);
    },
  );

  it("starts the wrapped part of an unindented line at the left edge of the line", () => {
    const v = mountNarrow(`\`\`\`ts\n${LONG}\n\`\`\``);
    const { start, wrapped } = wrapStarts(v, 2, 0);
    expect(Math.abs(wrapped - start)).toBeLessThan(1);
  });

  it("keeps the alignment while the fences are shown", () => {
    const doc = `\`\`\`ts\n    ${LONG}\n\`\`\``;
    const v = mountNarrow(doc);
    v.focus();
    v.dispatch({ selection: EditorSelection.cursor(doc.indexOf("const")) });
    expect(codeLines(v)[0]?.textContent).toBe("```ts");
    const { start, wrapped } = wrapStarts(v, 2, 4);
    expect(Math.abs(wrapped - start)).toBeLessThan(1);
  });

  it("keeps the wrapped part of a deeply indented line inside the line", () => {
    // 字下げが行の幅を越えると、そろえた折り返しの行が右へはみ出して読めなくなる
    const v = mountNarrow(`\`\`\`ts\n${" ".repeat(60)}${LONG}\n\`\`\``);
    const line = codeLines(v)[1];
    if (!line) throw new Error("code line is not rendered");
    const { wrapped } = wrapStarts(v, 2, 60);
    expect(wrapped).toBeLessThan(line.getBoundingClientRect().right - 40);
  });
});

describe("fences", () => {
  const DOC = "前\n\n```ts\nconst a = 1;\n```\n\n後";
  const bodyPos = DOC.indexOf("const") + 2;
  const blockTo = DOC.indexOf("```\n\n後") + 3;

  const placeCursor = (v: EditorView, pos: number) => {
    v.focus();
    v.dispatch({ selection: EditorSelection.cursor(pos) });
  };
  const label = (v: EditorView) => v.contentDOM.querySelector(".cm-lp-code-language");
  const fenceTexts = (v: EditorView) => {
    const lines = codeLines(v);
    return [lines[0]?.textContent, lines.at(-1)?.textContent];
  };

  it("hides the fences and labels the language while the view has no focus", () => {
    // decoration は doc を変えないので、doc.toString() だけでは何を壊しても通ってしまう。
    // 描画結果（rendered line）で見る。
    const v = mount(DOC);
    expect(v.hasFocus).toBe(false);
    expect(label(v)?.textContent).toBe("TypeScript");
    // 開きフェンスの行に残るのはラベルだけ、閉じフェンスの行は空
    expect(fenceTexts(v)).toEqual(["TypeScript", ""]);
    expect(codeLines(v)[1]?.textContent).toBe("const a = 1;");
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it("hides the fences while the focused cursor is outside the block", () => {
    const v = mount(DOC);
    placeCursor(v, DOC.length);
    expect(fenceTexts(v)).toEqual(["TypeScript", ""]);
  });

  it("shows both fences as source while the cursor is inside the block", () => {
    const v = mount(DOC);
    placeCursor(v, bodyPos);
    expect(fenceTexts(v)).toEqual(["```ts", "```"]);
    expect(label(v)).toBeNull();
  });

  it("shows the fences while the cursor sits right after the closing fence", () => {
    const v = mount(DOC);
    placeCursor(v, blockTo);
    expect(fenceTexts(v)).toEqual(["```ts", "```"]);
  });

  it("hides the fences again once the cursor leaves the block", () => {
    const v = mount(DOC);
    placeCursor(v, bodyPos);
    placeCursor(v, DOC.length);
    expect(fenceTexts(v)).toEqual(["TypeScript", ""]);
  });

  it("shows no label for a fence without an info string", () => {
    const v = mount("```\ncode\n```");
    expect(label(v)).toBeNull();
    expect(fenceTexts(v)).toEqual(["", ""]);
  });

  it("labels only the first word of the info string", () => {
    const v = mount('```ts title="a.ts"\ncode\n```');
    expect(label(v)?.textContent).toBe("TypeScript");
  });

  it.each([
    ["ts", "TypeScript"],
    ["TS", "TypeScript"],
    ["typescript", "TypeScript"],
    ["js", "JavaScript"],
    ["tsx", "TSX"],
    ["py", "Python"],
    ["rb", "Ruby"],
    ["yml", "YAML"],
    ["c++", "C++"],
    ["cs", "C#"],
    ["sh", "Shell"],
    ["bash", "Bash"],
    ["diff", "Diff"],
    ["mermaid", "Mermaid"],
    ["ini", "INI"],
    ["md", "Markdown"],
    ["ex", "Elixir"],
    ["exs", "Elixir"],
  ])("labels %s with its display name", (info, expected) => {
    const v = mount(`\`\`\`${info}\ncode\n\`\`\``);
    expect(label(v)?.textContent).toBe(expected);
  });

  it.each([
    // 拡張子では引かない。`text` は LaTeX の、`m` は Mathematica の拡張子に入っている
    ["text"],
    ["m"],
    // 名前の一部に一致しても引かない（`postcss` は CSS の名前を含む）
    ["postcss"],
    ["unknownlang"],
    ["Foo"],
    // 表の引き方が Object の prototype の名前を拾わない
    ["constructor"],
    ["__proto__"],
  ])("labels an unknown language %s as written", (info) => {
    const v = mount(`\`\`\`${info}\ncode\n\`\`\``);
    expect(label(v)?.textContent).toBe(info);
  });

  it.each([
    ["{.python}", "Python"],
    ["{.python .numberLines}", "Python"],
    ["{#main .python}", "Python"],
    ["{#main}", "{#main}"],
    ["{ .python }", "Python"],
    ['{title="a .b" .python}', "Python"],
  ])("labels the language of the pandoc attribute info string %s", (info, expected) => {
    const v = mount(`\`\`\`${info}\ncode\n\`\`\``);
    expect(label(v)?.textContent).toBe(expected);
  });

  it("shows the fences while the cursor sits at the start of the opening fence", () => {
    const v = mount(DOC);
    placeCursor(v, DOC.indexOf("```"));
    expect(fenceTexts(v)).toEqual(["```ts", "```"]);
  });

  it("shows the fences while a range selection spans the whole block", () => {
    const v = mount(DOC);
    v.focus();
    v.dispatch({ selection: EditorSelection.range(0, DOC.length) });
    expect(fenceTexts(v)).toEqual(["```ts", "```"]);
  });

  it("shows the fences while a secondary cursor is inside the block", () => {
    // 今の Editor は複数カーソルを許していないので、この test でだけ facet を足す。
    // 許したときに main の range だけで判定していると、副カーソルで言語指定やフェンスを書き換えられない
    const v = mount(DOC, EditorState.allowMultipleSelections.of(true));
    v.focus();
    v.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.cursor(DOC.length), EditorSelection.cursor(bodyPos)],
        0,
      ),
    });
    expect(v.state.selection.ranges).toHaveLength(2);
    expect(v.state.selection.main.head).toBe(DOC.length);
    expect(fenceTexts(v)).toEqual(["```ts", "```"]);
  });

  it("hides only the fence marks inside a list item, keeping the bullet", () => {
    // 行頭の `- ` は list の持ち物。フェンスと一緒に隠すと箇条書きの「•」まで消える
    const v = mount("- ```ts\n  code\n  ```\n\n後");
    const [open, , close] = codeLines(v);
    expect(open?.querySelector(".cm-lp-list-bullet")).not.toBeNull();
    expect(open?.textContent).toBe("• TypeScript");
    expect(close?.textContent).toBe("  ");
  });

  it("hides only the fence marks of an indented fence, keeping the indentation", () => {
    const v = mount("1. a\n\n   ```ts\n   code\n   ```\n\n後");
    expect(fenceTexts(v)).toEqual(["   TypeScript", "   "]);
  });

  it.each([
    ["a blockquote", "> ```ts\n> const a = 1;\n> ```\n\n後", ["TypeScript", "const a = 1;", ""]],
    [
      "a callout",
      "> [!note]\n> ```ts\n> const a = 1;\n> ```\n\n後",
      ["TypeScript", "const a = 1;", ""],
    ],
    [
      "a nested blockquote",
      "> > ```ts\n> > const a = 1;\n> > ```",
      ["TypeScript", "const a = 1;", ""],
    ],
    [
      "a list item in a blockquote",
      "> - ```ts\n>   const a = 1;\n>   ```",
      ["• TypeScript", "  const a = 1;", "  "],
    ],
    ["an indented code block in a blockquote", ">     a\n>     b\n\n後", ["    a", "    b"]],
  ])("hides the quote marks of every line of a code block inside %s", (_, doc, expected) => {
    // 閉じフェンスと本文の行の `>` は FencedCode の子になる。隠さないと閉じフェンスの行に `>` だけが残る
    const v = mount(doc);
    expect(codeLines(v).map((line) => line.textContent)).toEqual(expected);
  });

  it("shows the quote mark only on the line with the cursor inside a blockquote", () => {
    // 引用の `>` は行ごとに source を出す。フェンスはブロック全体で出す
    const doc = "> ```ts\n> const a = 1;\n> ```\n\n後";
    const v = mount(doc);
    placeCursor(v, doc.indexOf("const"));
    expect(codeLines(v).map((line) => line.textContent)).toEqual([
      "```ts",
      "> const a = 1;",
      "```",
    ]);
  });

  it("keeps the opening fence of an unclosed block hidden and its last line as code", () => {
    const v = mount("```ts\ncode");
    expect(fenceTexts(v)).toEqual(["TypeScript", "code"]);
  });

  it.each([
    ["a language", "前\n\n```ts\na\n```\n\n後"],
    ["no language", "前\n\n```\na\n```\n\n後"],
    ["no language inside a blockquote", "> ```\n> a\n> ```\n\n後"],
    ["no language inside a list item", "- ```\n  a\n  ```\n\n後"],
  ])("tells assistive technology where a block with %s starts and ends", async (_, doc) => {
    // フェンスを隠すと境目は地の色だけになる。言語名のラベルが無いブロックでも読み上げで分かるようにする
    const v = mount(doc);
    const lines = codeLines(v);
    const start = page.getByRole("separator", { name: CODE_START_LABEL });
    const end = page.getByRole("separator", { name: CODE_END_LABEL });
    expect(start.elements()).toHaveLength(1);
    expect(end.elements()).toHaveLength(1);
    expect(lines[0]?.contains(start.element())).toBe(true);
    expect(lines.at(-1)?.contains(end.element())).toBe(true);
    // 名前は aria-label に置き、行の文字には混ぜない
    expect(lines.at(-1)?.textContent).not.toContain(CODE_END_LABEL);
  });

  it("exposes the boundaries as named separators in Chrome's accessibility tree", async () => {
    // getByRole は DOM から役割と名前を計算する近似で、幅の無い要素をブラウザが AX ツリーから落としても
    // 通ってしまう。支援技術が受け取るツリーそのものを読む
    mount("前\n\n```\na\n```\n\n後");
    type AXValue = { value?: unknown };
    type AXNode = { ignored: boolean; role?: AXValue; name?: AXValue };
    type FrameTree = { frame: { id: string; url: string }; childFrames?: FrameTree[] };
    // テストは Vitest の iframe の中で動き、CDP の session は外の page に付く。frameId を渡さないと外の
    // page のツリーしか返らない
    const findFrame = (tree: FrameTree): string | undefined =>
      tree.frame.url === location.href
        ? tree.frame.id
        : tree.childFrames?.map(findFrame).find((id) => id !== undefined);
    const { frameTree } = (await cdp().send("Page.getFrameTree")) as { frameTree: FrameTree };
    const frameId = findFrame(frameTree);
    if (!frameId) throw new Error("the test frame is not found");
    const boundaries = async () => {
      const { nodes } = (await cdp().send("Accessibility.getFullAXTree", { frameId })) as {
        nodes: AXNode[];
      };
      return nodes
        .filter(
          (node) => node.name?.value === CODE_START_LABEL || node.name?.value === CODE_END_LABEL,
        )
        .map((node) => ({ role: node.role?.value, name: node.name?.value, ignored: node.ignored }));
    };
    await cdp().send("Accessibility.enable");
    try {
      await vi.waitFor(async () =>
        expect(await boundaries()).toEqual([
          { role: "separator", name: CODE_START_LABEL, ignored: false },
          { role: "separator", name: CODE_END_LABEL, ignored: false },
        ]),
      );
    } finally {
      await cdp().send("Accessibility.disable");
    }
  });

  it("drops the boundaries while the fences are shown as source", () => {
    const v = mount(DOC);
    placeCursor(v, bodyPos);
    expect(v.contentDOM.querySelectorAll(".cm-lp-code-boundary")).toHaveLength(0);
  });

  it("marks only the start of an unclosed block", () => {
    mount("```\na");
    expect(page.getByRole("separator", { name: CODE_START_LABEL }).elements()).toHaveLength(1);
    expect(page.getByRole("separator", { name: CODE_END_LABEL }).elements()).toHaveLength(0);
  });

  it.each([
    ["a language", DOC],
    ["no language", "前\n\n```\nconst a = 1;\n```\n\n後"],
  ])("keeps every line in place when the fences of a block with %s appear", (_, doc) => {
    // 行を消すと、カーソルが入ったときにフェンスの行が現れて本文が上下にずれる。境目しか無い行も
    // 文字の行と同じ高さに保つ
    const v = mount(doc);
    placeCursor(v, doc.length);
    const tops = () =>
      [...v.contentDOM.querySelectorAll(".cm-line")].map(
        (line) => line.getBoundingClientRect().top,
      );
    const hidden = tops();
    placeCursor(v, doc.indexOf("const") + 2);
    expect(fenceTexts(v)[0]).toMatch(/^```/);
    expect(fenceTexts(v)[1]).toBe("```");
    const shown = tops();
    expect(shown).toHaveLength(hidden.length);
    for (const [i, top] of shown.entries()) {
      expect(Math.abs(top - (hidden[i] ?? 0))).toBeLessThan(0.5);
    }
  });

  it("rounds only the outer corners of the block", () => {
    const v = mount("```\na\nb\nc\n```");
    const radius = (line: Element | undefined, corner: string) =>
      Number.parseFloat(getComputedStyle(line as Element).getPropertyValue(corner));
    const lines = codeLines(v);
    expect(lines).toHaveLength(5);
    expect(radius(lines[0], "border-top-left-radius")).toBeGreaterThan(0);
    expect(radius(lines[0], "border-bottom-left-radius")).toBe(0);
    expect(radius(lines[4], "border-bottom-right-radius")).toBeGreaterThan(0);
    expect(radius(lines[4], "border-top-right-radius")).toBe(0);
    for (const line of lines.slice(1, 4)) {
      expect(radius(line, "border-top-left-radius")).toBe(0);
      expect(radius(line, "border-bottom-left-radius")).toBe(0);
    }
  });

  it.each([
    ["a block", "前\n\n```\na\nb\n```\n\n後"],
    ["a block inside a blockquote", "> ```\n> a\n> b\n> ```"],
  ])("draws only 1px edges around %s in forced-colors mode", async (_, doc) => {
    // 隙間の透明な border は forced-colors では CanvasText で塗られ、太い線になる。1px の線だけが残ることを
    // 実際の描画で確かめる（media の規則を読むだけでは、どちらの規則が勝つかまでは分からない）
    await cdp().send("Emulation.setEmulatedMedia", {
      features: [{ name: "forced-colors", value: "active" }],
    });
    try {
      expect(matchMedia("(forced-colors: active)").matches).toBe(true);
      const v = mount(doc);
      const lines = codeLines(v);
      const top = getComputedStyle(lines[0] as Element);
      const bottom = getComputedStyle(lines.at(-1) as Element);
      expect([top.borderTopWidth, top.borderTopStyle]).toEqual(["1px", "solid"]);
      expect([bottom.borderBottomWidth, bottom.borderBottomStyle]).toEqual(["1px", "solid"]);
      expect(top.borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(top.backgroundClip).toBe("border-box");
      expect(bottom.backgroundClip).toBe("border-box");
      expect(Number.parseFloat(top.borderBottomWidth)).toBe(0);
      expect(Number.parseFloat(bottom.borderTopWidth)).toBe(0);
      for (const line of lines.slice(1, -1)) {
        const style = getComputedStyle(line);
        expect(Number.parseFloat(style.borderTopWidth)).toBe(0);
        expect(Number.parseFloat(style.borderBottomWidth)).toBe(0);
      }
    } finally {
      await cdp().send("Emulation.setEmulatedMedia", { features: [] });
    }
  });

  it("cuts a long language label at half the width of the line", () => {
    const v = mount(`\`\`\`${"a".repeat(300)}\ncode\n\`\`\``);
    const line = codeLines(v)[0];
    const language = label(v);
    if (!line || !language) throw new Error("the label is not rendered");
    expect(getComputedStyle(language).textOverflow).toBe("ellipsis");
    expect(language.getBoundingClientRect().width).toBeLessThanOrEqual(
      line.getBoundingClientRect().width / 2 + 0.5,
    );
  });

  it.each([
    ["a blockquote", "> ```\n> a\n> ```"],
    ["a callout", "> [!note]\n> ```\n> a\n> ```"],
  ])("does not round the corners or cut the background inside %s", (_, doc) => {
    // 角丸と、上下の隙間の背景の切り抜きは、行の背景ごと効くので、引用のバーと callout の地が欠ける
    const v = mount(doc);
    const lines = codeLines(v);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const style = getComputedStyle(line);
      expect(style.backgroundClip).toBe("border-box");
      expect(Number.parseFloat(style.borderTopWidth)).toBe(0);
      expect(Number.parseFloat(style.borderBottomWidth)).toBe(0);
      for (const corner of [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomLeftRadius,
        style.borderBottomRightRadius,
      ]) {
        expect(Number.parseFloat(corner)).toBe(0);
      }
    }
  });

  it("does not change the fences while composing inside the block", async () => {
    // IME 不変条件 1。composition の間はカーソルがブロックの外へ動いても組み直さず、
    // 終わってから 1 回だけ隠す
    const v = mount(DOC);
    placeCursor(v, bodyPos);
    expect(fenceTexts(v)).toEqual(["```ts", "```"]);

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    v.dispatch({ selection: EditorSelection.cursor(DOC.length) });
    expect(fenceTexts(v)).toEqual(["```ts", "```"]);
    expect(label(v)).toBeNull();

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(fenceTexts(v)).toEqual(["TypeScript", ""]));
  });
});
