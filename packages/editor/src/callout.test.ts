import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCalloutTitle, parseCalloutHeader, resolveCalloutType } from "./callout";
import { createEditor } from "./create-editor";
import { isCompositionUnsettled } from "./ime";

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

const lineElements = (v: EditorView) => [...v.contentDOM.querySelectorAll<HTMLElement>(".cm-line")];
const lineTexts = (v: EditorView) => lineElements(v).map((line) => line.textContent ?? "");
/** callout でない行は null */
const calloutTypes = (v: EditorView) =>
  lineElements(v).map((line) =>
    line.classList.contains("cm-lp-callout") ? line.dataset.callout : null,
  );
const foldedLines = (v: EditorView) =>
  lineElements(v).map((line) => line.classList.contains("cm-lp-callout-folded"));
const foldButtons = (v: EditorView) => [
  ...v.contentDOM.querySelectorAll<HTMLElement>(".cm-lp-callout-fold"),
];

/** 全 extension の `Decoration.replace` の範囲（widget だけの点は含めない） */
const replaceRanges = (v: EditorView) => {
  const ranges: [number, number][] = [];
  for (const source of v.state.facet(EditorView.decorations)) {
    const set = typeof source === "function" ? source(v) : source;
    set.between(0, v.state.doc.length, (from, to, value) => {
      if (value.point && from < to) ranges.push([from, to]);
    });
  }
  return ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
};
/** 前の範囲に食い込んでいる replace の範囲 */
const overlappingReplaces = (v: EditorView) =>
  replaceRanges(v).filter((range, i, all) => i > 0 && range[0] < (all[i - 1]?.[1] ?? 0));

const placeCursor = (v: EditorView, pos: number) => {
  v.focus();
  v.dispatch({ selection: EditorSelection.cursor(pos) });
};

const pressFold = (button: HTMLElement | undefined) => {
  if (!button) throw new Error("fold button is not rendered");
  button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
};

describe("callout header parsing", () => {
  it.each([
    ["note", "note"],
    ["abstract", "abstract"],
    ["summary", "abstract"],
    ["tldr", "abstract"],
    ["info", "info"],
    ["todo", "todo"],
    ["tip", "tip"],
    ["hint", "tip"],
    ["important", "tip"],
    ["success", "success"],
    ["check", "success"],
    ["done", "success"],
    ["question", "question"],
    ["help", "question"],
    ["faq", "question"],
    ["warning", "warning"],
    ["caution", "warning"],
    ["attention", "warning"],
    ["failure", "failure"],
    ["fail", "failure"],
    ["missing", "failure"],
    ["danger", "danger"],
    ["error", "danger"],
    ["bug", "bug"],
    ["example", "example"],
    ["quote", "quote"],
    ["cite", "quote"],
  ])("resolves %j to %j", (identifier, type) => {
    expect(resolveCalloutType(identifier)).toBe(type);
  });

  it("ignores case and falls back to note for an unknown type", () => {
    expect(resolveCalloutType("WARNING")).toBe("warning");
    expect(resolveCalloutType("Faq")).toBe("question");
    expect(resolveCalloutType("custom")).toBe("note");
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "falls back to note for %j, a name on the object prototype",
    (identifier) => {
      expect(resolveCalloutType(identifier)).toBe("note");
    },
  );

  it("uses the identifier in title case as the default title", () => {
    expect(defaultCalloutTitle("tip")).toBe("Tip");
    expect(defaultCalloutTitle("FAQ")).toBe("Faq");
  });

  it("reads the fold marker and where the title starts", () => {
    expect(parseCalloutHeader("[!tip]- 折りたたみ", 10)).toEqual({
      type: "tip",
      identifier: "tip",
      fold: "-",
      titleFrom: 18,
      hasTitle: true,
    });
    expect(parseCalloutHeader("[!note]+", 0)).toMatchObject({ fold: "+", hasTitle: false });
    expect(parseCalloutHeader("[!note]  ", 0)).toMatchObject({ titleFrom: 9, hasTitle: false });
  });

  it("does not read text glued to the marker as a callout", () => {
    expect(parseCalloutHeader("[!note]です", 0)).toBeNull();
    expect(parseCalloutHeader("[!note]-です", 0)).toBeNull();
    expect(parseCalloutHeader("[!]", 0)).toBeNull();
    expect(parseCalloutHeader("[note]", 0)).toBeNull();
  });
});

describe("callout Live Preview", () => {
  it("replaces the marker with the icon and keeps the title and body", () => {
    const doc = "> [!warning] 注意すること\n> 本文\n\n後";
    const v = mount(doc);
    expect(lineTexts(v)).toEqual(["注意すること", "本文", "", "後"]);
    expect(calloutTypes(v)).toEqual(["warning", "warning", null, null]);
    expect(lineElements(v)[0]?.classList.contains("cm-lp-callout-title")).toBe(true);
    expect(lineElements(v)[1]?.classList.contains("cm-lp-callout-title")).toBe(false);
    expect(v.contentDOM.querySelectorAll(".cm-lp-callout-icon")).toHaveLength(1);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("shows the type identifier in title case when the title is omitted", () => {
    const v = mount("> [!FAQ]\n> 答え");
    expect(lineTexts(v)).toEqual(["Faq", "答え"]);
    expect(calloutTypes(v)).toEqual(["question", "question"]);
  });

  it("styles an unknown type as note but titles it with its own name", () => {
    const v = mount("> [!custom]\n> 本文");
    expect(lineTexts(v)).toEqual(["Custom", "本文"]);
    expect(calloutTypes(v)).toEqual(["note", "note"]);
  });

  it("colors the line and the bar with the type color", () => {
    const v = mount("> [!success] 成功\n> 本文\n\n> 引用");
    const [title, body, , quote] = lineElements(v);
    if (!title || !body || !quote) throw new Error("lines are not rendered");
    expect(getComputedStyle(title).color).toBe("rgb(21, 128, 61)");
    expect(getComputedStyle(body).backgroundColor).not.toBe(
      getComputedStyle(quote).backgroundColor,
    );
    expect(getComputedStyle(body).backgroundImage).toContain("rgb(21, 128, 61)");
  });

  it("handles a marker without a space after >", () => {
    const v = mount(">[!note] 詰めた\n>本文");
    expect(lineTexts(v)).toEqual(["詰めた", "本文"]);
    expect(calloutTypes(v)).toEqual(["note", "note"]);
  });

  it("reveals the whole header on the line holding the cursor", () => {
    const doc = "> [!tip]- タイトル\n> 本文";
    const v = mount(doc);
    placeCursor(v, doc.indexOf("タイトル") + 1);
    expect(lineTexts(v)[0]).toBe("> [!tip]- タイトル");
    expect(foldButtons(v)).toHaveLength(0);
    // 見出し行にカーソルがあっても、`-` の本文は畳んだまま
    expect(foldedLines(v)).toEqual([false, true]);
  });

  it("keeps the header rendered while the cursor is in the body", () => {
    const doc = "> [!note] タイトル\n> 本文";
    const v = mount(doc);
    placeCursor(v, doc.length);
    expect(lineTexts(v)).toEqual(["タイトル", "> 本文"]);
  });

  it("does not make a callout from a marker off the first line or inside a list", () => {
    const v = mount(">\n> [!note] 二行目\n\n> - [!note] リスト\n\n> 前置き [!note]");
    expect(calloutTypes(v).every((type) => type === null)).toBe(true);
    expect(lineTexts(v)).toContain("[!note] 二行目");
  });

  it("decorates nested callouts with the innermost type", () => {
    const v = mount("> [!note] 外側\n> > [!bug] 内側\n> > 内側の本文\n>\n> 外側の本文");
    expect(lineTexts(v)).toEqual(["外側", "内側", "内側の本文", "", "外側の本文"]);
    expect(calloutTypes(v)).toEqual(["note", "bug", "bug", "note", "note"]);
  });

  it("renders a callout inside a list item", () => {
    // `-` は箇条書きの記号として「•」に置き換わる
    const v = mount("- > [!info] リスト内");
    expect(lineTexts(v)).toEqual(["• リスト内"]);
    expect(calloutTypes(v)).toEqual(["info"]);
  });

  it("treats the marker as one unit for cursor motion", () => {
    const doc = "前\n> [!note] タイトル";
    const v = mount(doc);
    v.contentDOM.blur();
    const lineStart = doc.indexOf(">");
    expect(v.moveByChar(EditorSelection.cursor(lineStart), true).head).toBe(
      doc.indexOf("タイトル"),
    );
  });

  it("keeps other markup in the title decorated", () => {
    const v = mount("> [!note] **太字** のタイトル");
    expect(lineTexts(v)).toEqual(["太字 のタイトル"]);
    expect(v.contentDOM.querySelector(".cm-lp-strong")).not.toBeNull();
  });

  it("styles a prototype name as an unknown type", () => {
    const v = mount("> [!constructor] タイトル\n> 本文");
    expect(calloutTypes(v)).toEqual(["note", "note"]);
  });

  it("does not overlap the quote mark conceal with the header replace", () => {
    const doc = "> [!note] タイトル\n> 本文\n> > [!tip] 内側";
    const v = mount(doc);
    expect(overlappingReplaces(v)).toEqual([]);
    expect(replaceRanges(v)).toContainEqual([0, "> [!note] ".length]);
    const inner = doc.indexOf("> [!tip]");
    expect(replaceRanges(v)).toContainEqual([inner, inner + "> [!tip] ".length]);
  });

  it.each(["**x**", "==x==", "~~x~~", "*x*"])(
    "replaces a header with %j in the identifier as one unit",
    (identifier) => {
      const v = mount(`> [!${identifier}]\n> 本文`);
      expect(overlappingReplaces(v)).toEqual([]);
      expect(lineTexts(v)).toEqual([defaultCalloutTitle(identifier), "本文"]);
      expect(calloutTypes(v)).toEqual(["note", "note"]);
    },
  );
});

describe("callout fold button name", () => {
  const nameOf = (doc: string) => foldButtons(mount(doc))[0]?.getAttribute("aria-label");

  it("タイトルを名前にし、開閉の状態は名前に入れない", () => {
    const v = mount("> [!note]- 手順\n> 本文");
    const button = foldButtons(v)[0];
    expect(button?.getAttribute("aria-label")).toBe("「手順」の内容");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    pressFold(button);
    expect(foldButtons(v)[0]?.getAttribute("aria-label")).toBe("「手順」の内容");
    expect(foldButtons(v)[0]?.getAttribute("aria-expanded")).toBe("true");
  });

  it("タイトルを省くと既定のタイトルを名前にする", () => {
    expect(nameOf("> [!tip]+\n> 本文")).toBe("「Tip」の内容");
  });

  it("タイトルの強調やリンクの記号は名前から除く", () => {
    expect(nameOf("> [!note]+ **大事** な [[ページ|別名]]\n> 本文")).toBe("「大事 な 別名」の内容");
  });

  it("記号を除くと空になるタイトルは既定のタイトルにする", () => {
    expect(nameOf("> [!note]+ %%メモ%%\n> 本文")).toBe("「Note」の内容");
  });

  it("行頭の記号に見えるタイトルは、見えている文字のまま名前にする", () => {
    expect(nameOf("> [!note]+ 2026. 振り返り\n> 本文")).toBe("「2026. 振り返り」の内容");
    expect(nameOf("> [!note]+ - 項目\n> 本文")).toBe("「- 項目」の内容");
  });

  it("名前だけが変わるときは同じボタンの要素を使い続ける", () => {
    const v = mount("> [!note]+ 旧\n> 本文");
    const before = foldButtons(v)[0];
    v.dispatch({
      changes: { from: "> [!note]+ ".length, to: "> [!note]+ 旧".length, insert: "新" },
    });
    expect(foldButtons(v)[0]).toBe(before);
    expect(before?.getAttribute("aria-label")).toBe("「新」の内容");
  });

  it("開閉の状態が変わるときも同じボタンの要素を使い続け、状態だけを書き換える", () => {
    const v = mount("> [!note]+ 手順\n> 本文");
    const before = foldButtons(v)[0];
    pressFold(before);
    expect(foldButtons(v)[0]).toBe(before);
    expect(before?.getAttribute("aria-expanded")).toBe("false");
    pressFold(before);
    expect(before?.getAttribute("aria-expanded")).toBe("true");
  });

  it("タイトルを書き換えると名前も変わる", () => {
    const v = mount("> [!note]+ 旧\n> 本文");
    v.dispatch({
      changes: { from: "> [!note]+ ".length, to: "> [!note]+ 旧".length, insert: "新" },
    });
    expect(foldButtons(v)[0]?.getAttribute("aria-label")).toBe("「新」の内容");
  });
});

describe("callout fold button keyboard", () => {
  const keydown = (button: HTMLElement | undefined, key: string, init: KeyboardEventInit = {}) => {
    if (!button) throw new Error("fold button is not rendered");
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    button.dispatchEvent(event);
    return event;
  };

  it("Tab で届き、ボタンとして読み上げられる", () => {
    const v = mount("> [!note]- 手順\n> 本文");
    const button = foldButtons(v)[0];
    expect(button?.tabIndex).toBe(0);
    expect(button?.getAttribute("role")).toBe("button");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["Enter", " "])("%j で開閉し、本文を書き換えない", (key) => {
    const doc = "> [!note]- 手順\n> 本文";
    const v = mount(doc);
    expect(foldedLines(v)).toEqual([false, true]);

    const event = keydown(foldButtons(v)[0], key);
    expect(event.defaultPrevented).toBe(true);
    expect(foldedLines(v)).toEqual([false, false]);
    expect(foldButtons(v)[0]?.getAttribute("aria-expanded")).toBe("true");

    keydown(foldButtons(v)[0], key);
    expect(foldedLines(v)).toEqual([false, true]);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("開閉した後も focus がボタンに残り、続けて操作できる", () => {
    const v = mount("> [!note]+ 手順\n> 本文");
    const button = foldButtons(v)[0];
    button?.focus();
    expect(document.activeElement).toBe(button);

    keydown(button, "Enter");
    expect(foldedLines(v)).toEqual([false, true]);
    expect(document.activeElement).toBe(button);
    keydown(foldButtons(v)[0], " ");
    expect(foldedLines(v)).toEqual([false, false]);
  });

  it("他のキーと、修飾キーを伴う Enter では開閉しない", () => {
    const v = mount("> [!note]- 手順\n> 本文");
    const button = foldButtons(v)[0];
    keydown(button, "a");
    keydown(button, "Tab");
    keydown(button, "Enter", { metaKey: true });
    keydown(button, "Enter", { ctrlKey: true });
    keydown(button, "Enter", { altKey: true });
    expect(foldedLines(v)).toEqual([false, true]);
  });

  it("composition が落ち着くまでキーを無視する（IME 不変条件 1）", async () => {
    const v = mount("> [!note]+ 手順\n> 本文");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    keydown(foldButtons(v)[0], "Enter");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    keydown(foldButtons(v)[0], "Enter");
    expect(foldedLines(v)).toEqual([false, false]);

    await vi.waitFor(() => expect(isCompositionUnsettled(v)).toBe(false));
    keydown(foldButtons(v)[0], "Enter");
    expect(foldedLines(v)).toEqual([false, true]);
  });
});

describe("callout folding", () => {
  it("collapses the body of a - callout without touching the document", () => {
    const doc = "> [!faq]- 質問\n> 答え\n> 続き\n\n後";
    const v = mount(doc);
    expect(foldedLines(v)).toEqual([false, true, true, false, false]);
    const body = lineElements(v)[1];
    if (!body) throw new Error("lines are not rendered");
    expect(getComputedStyle(body).display).toBe("none");
    expect(foldButtons(v)[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("leaves a + callout expanded with a fold button", () => {
    const v = mount("> [!faq]+ 質問\n> 答え");
    expect(foldedLines(v)).toEqual([false, false]);
    expect(foldButtons(v)[0]?.getAttribute("aria-expanded")).toBe("true");
  });

  it("draws no fold button for a callout without + or -", () => {
    const v = mount("> [!faq] 質問\n> 答え");
    expect(foldButtons(v)).toHaveLength(0);
  });

  it.each(["> [!faq]- 質問", "> [!faq]+ 質問\n\n後"])(
    "draws no fold button for a callout without a body: %j",
    (doc) => {
      const v = mount(doc);
      expect(foldButtons(v)).toHaveLength(0);
      expect(foldedLines(v).some(Boolean)).toBe(false);
    },
  );

  it("ignores the fold button until the composition settles", async () => {
    let transactions = 0;
    const v = mount(
      "> [!faq]+ 質問\n> 答え\n\n後",
      EditorView.updateListener.of((update) => {
        transactions += update.transactions.length;
      }),
    );
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    pressFold(foldButtons(v)[0]);
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    pressFold(foldButtons(v)[0]);
    expect(transactions).toBe(0);

    await vi.waitFor(() => expect(isCompositionUnsettled(v)).toBe(false));
    pressFold(foldButtons(v)[0]);
    expect(foldedLines(v)).toEqual([false, true, false, false]);
  });

  it("toggles with the fold button and never writes the state back", () => {
    const doc = "> [!faq]+ 質問\n> 答え";
    const v = mount(doc);
    pressFold(foldButtons(v)[0]);
    expect(foldedLines(v)).toEqual([false, true]);
    expect(foldButtons(v)[0]?.getAttribute("aria-expanded")).toBe("false");
    pressFold(foldButtons(v)[0]);
    expect(foldedLines(v)).toEqual([false, false]);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("expands a collapsed callout while the selection is in its body", () => {
    const doc = "> [!faq]- 質問\n> 答え\n\n後";
    const v = mount(doc);
    placeCursor(v, doc.indexOf("答え") + 1);
    expect(foldedLines(v)).toEqual([false, false, false, false]);
    placeCursor(v, doc.length);
    expect(foldedLines(v)).toEqual([false, true, false, false]);
  });

  it("moves the cursor out of the body it collapses", () => {
    const doc = "> [!faq]+ 質問\n> 答え";
    const v = mount(doc);
    placeCursor(v, doc.length);
    pressFold(foldButtons(v)[0]);
    expect(v.state.selection.main.head).toBe(doc.indexOf("\n"));
    expect(foldedLines(v)).toEqual([false, true]);
  });

  it("keeps the toggled state while the header keeps its type and fold marker", () => {
    const doc = "> [!faq]- 質問\n> 答え\n\n後";
    const v = mount(doc);
    pressFold(foldButtons(v)[0]);
    expect(foldedLines(v)[1]).toBe(false);
    // 外から入った変更も同じ transaction の形で届くので、ローカルの編集と区別しない
    v.dispatch({ changes: { from: doc.indexOf("質問"), insert: "別の" } });
    expect(foldedLines(v)[1]).toBe(false);
    v.dispatch({ changes: { from: v.state.doc.toString().indexOf("答え"), insert: "新しい" } });
    expect(foldedLines(v)[1]).toBe(false);
    // 大文字小文字の違いはタイプを変えない
    const identifier = doc.indexOf("faq");
    v.dispatch({ changes: { from: identifier, to: identifier + 3, insert: "FAQ" } });
    expect(foldedLines(v)[1]).toBe(false);
  });

  it("drops the toggled state when the fold marker or the type changes", () => {
    const doc = "> [!faq]+ 質問\n> 答え";
    const v = mount(doc);
    pressFold(foldButtons(v)[0]);
    expect(foldedLines(v)[1]).toBe(true);
    // `+` を消すと開閉できない callout になる。上書きが残ると、ボタンの無いまま畳まれる
    const sign = doc.indexOf("+");
    v.dispatch({ changes: { from: sign, to: sign + 1 } });
    expect(foldButtons(v)).toHaveLength(0);
    expect(foldedLines(v)[1]).toBe(false);
    v.dispatch({ changes: { from: sign, insert: "+" } });
    expect(foldedLines(v)[1]).toBe(false);

    pressFold(foldButtons(v)[0]);
    expect(foldedLines(v)[1]).toBe(true);
    const identifier = doc.indexOf("faq");
    v.dispatch({ changes: { from: identifier, to: identifier + 3, insert: "tip" } });
    expect(foldedLines(v)[1]).toBe(false);
  });

  it("collapses nested callouts together with the outer one", () => {
    const v = mount("> [!note]- 外側\n> > [!tip] 内側\n> > 本文\n\n後");
    expect(foldedLines(v)).toEqual([false, true, true, false, false]);
  });

  it("skips a collapsed body with vertical cursor motion", () => {
    const doc = "前\n> [!faq]- 質問\n> 答え\n後";
    const v = mount(doc, EditorState.allowMultipleSelections.of(false));
    v.contentDOM.blur();
    const header = EditorSelection.cursor(doc.indexOf("質問"));
    const below = v.moveVertically(header, true);
    expect(v.state.doc.lineAt(below.head).number).toBe(4);
  });
});
