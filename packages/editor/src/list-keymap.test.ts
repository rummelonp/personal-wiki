import { completionStatus } from "@codemirror/autocomplete";
import { undo, undoDepth } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { language, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { createEditor } from "./create-editor";
import { listKeymap } from "./list-keymap";
import { createMemoryPageIndex } from "./page-index";

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

/** `|` の位置にカーソルを置いた editor を作る */
function setup(docWithCursor: string): EditorView {
  const cursor = docWithCursor.indexOf("|");
  const doc = docWithCursor.slice(0, cursor) + docWithCursor.slice(cursor + 1);
  const view = mount((parent) => createEditor(parent, { doc }));
  view.dispatch({ selection: EditorSelection.cursor(cursor) });
  return view;
}

const press = (view: EditorView, key: string, init: KeyboardEventInit = {}) =>
  runScopeHandlers(view, new KeyboardEvent("keydown", { key, ...init }), "editor");

/** 文書にカーソル位置を `|` で書き戻す */
const withCursor = (view: EditorView) => {
  const doc = view.state.doc.toString();
  const head = view.state.selection.main.head;
  return `${doc.slice(0, head)}|${doc.slice(head)}`;
};

// lang-markdown の markdown() は既定（addKeymap: true）で markdownKeymap を Prec.high で足す。
// create-editor はそれを外していないので、ここでは配線が生きていることだけを確かめる。
describe("markdownKeymap wired by markdown()", () => {
  test("Enter continues a bullet list item", () => {
    const view = setup("- a|");
    expect(press(view, "Enter")).toBe(true);
    expect(withCursor(view)).toBe("- a\n- |");
  });

  test("Enter continues an ordered list and renumbers the following items", () => {
    const view = setup("1. a|\n2. b");
    press(view, "Enter");
    expect(withCursor(view)).toBe("1. a\n2. |\n3. b");
  });

  test("Enter continues a task list item with an unchecked box", () => {
    const view = setup("- [x] done|");
    press(view, "Enter");
    expect(withCursor(view)).toBe("- [x] done\n- [ ] |");
  });

  test("Enter continues a blockquote", () => {
    const view = setup("> quote|");
    press(view, "Enter");
    expect(withCursor(view)).toBe("> quote\n> |");
  });

  // 2 項目目が空のときは lang-markdown がリストを loose にする動作なので、3 項目目で見る
  test("Enter on an empty item ends the list", () => {
    const view = setup("- a\n- b\n- |");
    press(view, "Enter");
    expect(withCursor(view)).toBe("- a\n- b\n|");
  });

  test("Backspace right after a list marker removes the marker", () => {
    const view = setup("- a\n- |");
    expect(press(view, "Backspace")).toBe(true);
    expect(withCursor(view)).toBe("- a\n  |");
  });

  test("Enter outside lists and quotes inserts a plain newline", () => {
    const view = setup("text|");
    press(view, "Enter");
    expect(withCursor(view)).toBe("text\n|");
  });
});

/** 複数カーソルを置く。createEditor は複数選択を有効にしていないので、ここで足す */
const selectCursors = (view: EditorView, positions: number[]) => {
  view.dispatch({
    effects: StateEffect.appendConfig.of(EditorState.allowMultipleSelections.of(true)),
  });
  view.dispatch({
    selection: EditorSelection.create(positions.map((pos) => EditorSelection.cursor(pos))),
  });
};

const tab = (view: EditorView) => press(view, "Tab");
const shiftTab = (view: EditorView) => press(view, "Tab", { shiftKey: true });
const shiftEnter = (view: EditorView) => press(view, "Enter", { shiftKey: true });

/** 文書順の各 ListItem の範囲と深さと本文（子のリストを除き、行頭の空白・`>`・記号を落としたもの） */
function listItemShapes(view: EditorView) {
  const { state } = view;
  const shapes: { from: number; to: number; depth: number; own: string }[] = [];
  syntaxTree(state).iterate({
    enter: (ref) => {
      if (ref.name !== "ListItem") return;
      const node = ref.node;
      let depth = 0;
      for (let p = node.parent; p; p = p.parent) if (p.name === "ListItem") depth += 1;
      let text = "";
      let pos = node.from;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name !== "BulletList" && child.name !== "OrderedList") continue;
        text += `${state.sliceDoc(pos, child.from)}\n`;
        pos = child.to;
      }
      text += state.sliceDoc(pos, node.to);
      const own = text
        .split("\n")
        .map((line) =>
          line
            .replace(/^[\s>]*/, "")
            .replace(/^([-*+]|\d{1,9}[.)])(?=\s|$)/, "")
            .trim(),
        )
        .filter((line) => line !== "")
        .join("\n");
      shapes.push({ from: node.from, to: node.to, depth, own });
    },
  });
  return shapes;
}

describe("Tab / Shift+Tab in a list", () => {
  test("Tab nests a bullet item under the previous one, Shift+Tab brings it back", () => {
    const view = setup("- a\n- b|");
    expect(tab(view)).toBe(true);
    expect(withCursor(view)).toBe("- a\n  - b|");
    expect(shiftTab(view)).toBe(true);
    expect(withCursor(view)).toBe("- a\n- b|");
  });

  test("the indent follows the width of the parent's marker", () => {
    const ordered = setup("1. a\n2. b|");
    tab(ordered);
    expect(withCursor(ordered)).toBe("1. a\n   1. b|");
    const task = setup("- [ ] a\n- [ ] b|");
    tab(task);
    expect(withCursor(task)).toBe("- [ ] a\n  - [ ] b|");
  });

  test("the whole item moves with its children and continuation lines", () => {
    const view = setup("- a\n- b|\n  more\n  - c\n- d");
    tab(view);
    expect(withCursor(view)).toBe("- a\n  - b|\n    more\n    - c\n- d");
    shiftTab(view);
    expect(withCursor(view)).toBe("- a\n- b|\n  more\n  - c\n- d");
  });

  test("Tab on an ordered item starts a new sub-list at 1 and closes the gap", () => {
    const view = setup("1. a\n2. b|\n3. c");
    tab(view);
    expect(withCursor(view)).toBe("1. a\n   1. b|\n2. c");
    shiftTab(view);
    expect(withCursor(view)).toBe("1. a\n2. b|\n3. c");
  });

  test("Tab on an ordered item continues an existing sub-list", () => {
    const view = setup("1. a\n   1. x\n2. b|");
    tab(view);
    expect(withCursor(view)).toBe("1. a\n   1. x\n   2. b|");
  });

  test("Shift+Tab in the middle of a sub-list makes the following siblings its children", () => {
    const view = setup("1. p\n   1. a\n   2. b|\n   3. c\n2. q");
    shiftTab(view);
    expect(withCursor(view)).toBe("1. p\n   1. a\n2. b|\n   1. c\n3. q");
  });

  test("lists numbered with repeated 1. keep their numbers", () => {
    const view = setup("1. a\n1. b|\n1. c");
    tab(view);
    expect(withCursor(view)).toBe("1. a\n   1. b|\n1. c");
  });

  test("a multi-line selection nests every selected item under the same parent", () => {
    const view = setup("|- a\n- b\n- c\n- d");
    view.dispatch({ selection: EditorSelection.range(4, 11) });
    tab(view);
    expect(view.state.doc.toString()).toBe("- a\n  - b\n  - c\n- d");
    shiftTab(view);
    expect(view.state.doc.toString()).toBe("- a\n- b\n- c\n- d");
  });

  test("tab-indented parents keep their tabs", () => {
    const view = setup("- p\n\t- a\n\t- b|");
    tab(view);
    expect(withCursor(view)).toBe("- p\n\t- a\n\t  - b|");
  });

  test("a list inside a blockquote keeps the quote marks", () => {
    const view = setup("> - a\n> - b|");
    tab(view);
    expect(withCursor(view)).toBe("> - a\n>   - b|");
  });

  test("Tab on an item that cannot nest still takes the key without changing the text", () => {
    const first = setup("- a|\n- b");
    expect(tab(first)).toBe(true);
    expect(first.state.doc.toString()).toBe("- a\n- b");
  });

  // 本文の前の title 欄へ Shift+Tab で戻る経路を塞がない
  test("Shift+Tab on a top-level item is left to the browser", () => {
    const top = setup("- a|");
    expect(shiftTab(top)).toBe(false);
    expect(top.state.doc.toString()).toBe("- a");
  });

  test("when a new number is wider, the item's children follow its text column", () => {
    const sub = Array.from({ length: 9 }, (_, i) => `   ${i + 1}. x`).join("\n");
    const view = setup(`1. a\n${sub}\n2. b|\n   - child`);
    tab(view);
    expect(withCursor(view)).toBe(`1. a\n${sub}\n   10. b|\n       - child`);
  });

  test("when Shift+Tab widens the following siblings' numbers, their children follow", () => {
    const view = setup("8. p\n   1. a|\n9. q\n   - qchild");
    shiftTab(view);
    expect(withCursor(view)).toBe("8. p\n9. a|\n10. q\n    - qchild");
  });

  test("siblings left behind by Shift+Tab stay children of the wider moved item", () => {
    const view = setup("9. p\n   1. a|\n   2. b");
    shiftTab(view);
    expect(withCursor(view)).toBe("9. p\n10. a|\n    1. b");
  });

  // 記号が外側と違うままだと外側のリストが切れ、`2. q` は `- b` の本文へ吸い込まれる
  test("Shift+Tab gives the moved item the outer list's marker and renumbers after it", () => {
    const bullet = setup("1. p\n   - a|\n   - b\n2. q");
    shiftTab(bullet);
    expect(withCursor(bullet)).toBe("1. p\n2. a|\n   - b\n3. q");
    const paren = setup("1. p\n   1) a|\n   2) b\n2. q");
    shiftTab(paren);
    expect(withCursor(paren)).toBe("1. p\n2. a|\n   1) b\n3. q");
    const toBullet = setup("- p\n  1. a|\n  2. b\n- q");
    shiftTab(toBullet);
    expect(withCursor(toBullet)).toBe("- p\n- a|\n  1. b\n- q");
  });

  // 事後の検査と同じ不変条件を、検査の外から確かめる。変わった文書でも変わらなかった文書でも、
  // 項目の数・順序・本文は保たれ、深さはカーソルの項目とその子孫だけが 1 段ずつ変わる
  test("Tab / Shift+Tab keep every list item, its text and the expected depth", () => {
    const changed = [
      ["stab", "1. p\n   - a|\n   - b\n2. q"],
      ["stab", "1. p\n   1) a|\n   2) b\n2. q"],
      ["stab", "- p\n  1. a|\n  2. b\n- q"],
      ["stab", "1. p\n   - [ ] a|\n   - [x] b\n2. q"],
      ["stab", "99. p\n    - a|\n    - b\n100. q"],
      // 1 以外から始まる番号付きリストは段落の途中から始められないので、空行を挟む
      ["stab", "- p\n\n  9. x\n  10. a|\n  11. b\n      - c\n- q"],
      ["stab", "> 1. p\n>    - a|\n>    - b\n> 2. q"],
      ["stab", "1. p\n   -\ta|\n\t\t- b\n2. q"],
      ["stab", "1. p\n   - a|\n\n     ```\n     code\n     ```\n   - b\n2. q"],
      ["stab", "1. p\n   - q|\n     1. x\n     2. y\n   - r\n2. s"],
      ["stab", "1. p\n   - a|\nlazy\n   - b\n2. q"],
      ["stab", "1. p\n\n   - a|\n\n   - b\n\n2. q"],
      ["stab", "1. p\n   - a|\n1. q"],
      ["tab", "1. a\n   - x\n2. b|\n3. c"],
      ["tab", "> 1. a\n> 2. b|\n>    - c\n> 3. d"],
      ["tab", "1. a\n   1. x\n   1. y\n1. b|\n1. c"],
    ] as const;
    // 規則のままでは項目が段落に吸い込まれたり、本文が別の項目へ移ったりするので、検査が変更を捨てる
    const refused = [
      // 外側が箇条書きになり、1 以外や `)` の番号が段落の途中から始められなくなる
      "- p\n  1. a|\n     - b\n       2. c\n- q",
      "- p\n  1. a|\n     2) c\n- q",
      "- p\n  9) q\n     * r\n       1) x\n       2) a|\n  10) s\n- z",
      // インデントされたコードの位置にあった行が、怠惰な継続行の規則で項目になる
      "- p\n  -    a|\n      - x\n- q",
      // 親の item の後ろの段落が、動かした item の本文になる
      "- p\n  - a|\n\n  para of p\n- q",
      // 空の項目は段落の途中からリストを始められない
      "1. p\n   - a|\n   -\n2. q",
    ];
    const cases = [
      ...changed.map(([key, doc]) => ({ key, doc, refused: false })),
      ...refused.map((doc) => ({ key: "stab" as const, doc, refused: true })),
    ];
    for (const { key, doc, refused } of cases) {
      const view = setup(doc);
      const before = listItemShapes(view);
      const cursor = view.state.selection.main.head;
      const root = before.filter((item) => item.from <= cursor && cursor <= item.to).at(-1);
      const handled = key === "tab" ? tab(view) : shiftTab(view);
      const label = `${key} ${JSON.stringify(doc)} -> ${JSON.stringify(view.state.doc.toString())}`;
      expect(handled, label).toBe(true);
      expect(view.state.doc.toString() === doc.replace("|", ""), label).toBe(refused);
      const after = listItemShapes(view);
      const step = refused ? 0 : key === "tab" ? 1 : -1;
      expect(
        after.map(({ own, depth }) => ({ own, depth })),
        label,
      ).toEqual(
        before.map(({ own, depth, from, to }) => ({
          own,
          depth: root && root.from <= from && to <= root.to ? depth + step : depth,
        })),
      );
    }
  });

  test("Shift+Tab inside a nested list takes the key even when nothing can move", () => {
    // 引用を挟んだ入れ子には外へ出す先の item が無い
    const quoted = setup("- a\n  > - b|");
    expect(shiftTab(quoted)).toBe(true);
    expect(quoted.state.doc.toString()).toBe("- a\n  > - b");
    // 検査に落ちた変更
    const refused = setup("- p\n  - a|\n\n  para of p\n- q");
    expect(shiftTab(refused)).toBe(true);
    expect(refused.state.doc.toString()).toBe("- p\n  - a\n\n  para of p\n- q");
  });

  test("Shift+Tab into a list numbered with repeated 1. keeps 1.", () => {
    const view = setup("1. p\n   - a|\n1. q");
    shiftTab(view);
    expect(withCursor(view)).toBe("1. p\n1. a|\n1. q");
  });

  test("Shift+Tab on a parent and its nested list at once keeps the numbers consecutive", () => {
    const nested = setup("|1. r\n   1. q\n   2. p\n      1. a\n   3. s");
    selectCursors(nested, [9, 31]);
    expect(nested.state.selection.ranges).toHaveLength(2);
    shiftTab(nested);
    expect(nested.state.doc.toString()).toBe("1. r\n2. q\n   1. p\n   2. a\n   3. s");

    const siblings = setup("|1. x\n   1. a\n2. y\n   1. b\n3. z");
    selectCursors(siblings, [12, 25]);
    shiftTab(siblings);
    expect(siblings.state.doc.toString()).toBe("1. x\n2. a\n3. y\n4. b\n5. z");

    // 親（`10.` → `1.`）の記号が狭くなっても、内側から出る項目は親の記号の列に揃う
    const narrowed = setup("|- r\n\n  9. q\n  10. p\n      1. a\n      2. b\n- t");
    const text = narrowed.state.doc.toString();
    selectCursors(narrowed, [text.indexOf(" q") + 2, text.indexOf("1. a") + 4]);
    const before = listItemShapes(narrowed).map(({ own }) => own);
    shiftTab(narrowed);
    expect(narrowed.state.doc.toString()).toBe("- r\n\n- q\n  1. p\n  2. a\n     1. b\n- t");
    expect(listItemShapes(narrowed).map(({ own }) => own)).toEqual(before);
  });

  test("lazy continuation lines keep their text as it is", () => {
    const view = setup("> - a\n>   - b|\n> lazy");
    shiftTab(view);
    expect(withCursor(view)).toBe("> - a\n> - b|\n> lazy");
  });

  // 本文の比較（listItemShapes）は行頭の空白を落とすので、段落がコードになる、段落の次の行が
  // setext の下線になる、といった変化を見逃す。ここでは文書を最初から解析し直し、リストの入れ物
  // 以外の node の並びが前後で変わらないことを見る
  test("Tab / Shift+Tab keep the kind of every block", () => {
    const blockNames = (view: EditorView) => {
      const names: string[] = [];
      const parser = view.state.facet(language)?.parser;
      if (!parser) throw new Error("no language");
      parser.parse(view.state.doc.toString()).iterate({
        enter: ({ name }) => {
          if (!["ListItem", "BulletList", "OrderedList", "ListMark"].includes(name))
            names.push(name);
        },
      });
      return names;
    };
    const changed = [
      // 引用の中の setext の下線の行は `>` が QuoteMark にならないが、一緒に動く
      ["tab", "> 1. a\n> 2. b|\n>    ===", "> 1. a\n>    1. b|\n>       ==="],
      ["tab", "> - a\n> - b|\n>   ---", "> - a\n>   - b|\n>     ---"],
      // 記号の後のタブは同じ幅のスペースにしてから動かす。タブのままだと本文の列が動かない
      ["tab", "- a\n-\tb|\n\n      x", "- a\n  -   b|\n\n        x"],
      ["stab", "- p\n  -\tb|\n\n        x\n- q", "- p\n- b|\n\n      x\n- q"],
      ["tab", "8. a\n9.\tb|\n10.\tc\n\n    x", "8. a\n   1.  b|\n9. c\n\n   x"],
      ["stab", "- p\n  - a|\n    | h |\n    | - |\n- q", "- p\n- a|\n  | h |\n  | - |\n- q"],
      // 振り直しても記号の列と幅が変わらない項目のタブは、本文の列が保たれるので残す
      ["tab", "1. a\n2.\tb|\n3.\tc", "1. a\n   1.  b|\n2.\tc"],
      // fence の中のタブはコードの中身。字下げの中で列を変え、タブはそのまま残す
      [
        "tab",
        "- a\n- b|\n  ```go\n  func f() {\n  \treturn\n  }\n  ```",
        "- a\n  - b|\n    ```go\n    func f() {\n    \treturn\n    }\n    ```",
      ],
      [
        "stab",
        "- a\n  - b|\n    ```go\n    func f() {\n    \t\treturn\n    }\n    ```",
        "- a\n- b|\n  ```go\n  func f() {\n  \t\treturn\n  }\n  ```",
      ],
      // インデントされたコードは本文の列 + 4 からが中身。そこまでをまたぐタブも字下げとして動かす
      ["stab", "- p\n\t- b|\n\n\t\t\tcode\n- q", "- p\n- b|\n\n\t  code\n- q"],
      ["stab", "- p\n    - b|\n\n\t\t  k\n- q", "- p\n- b|\n\n\t  k\n- q"],
      ["stab", "1. p\n   1. b|\n\n\t\t  code\n2. q", "1. p\n2. b|\n\n\t   code\n3. q"],
      ["tab", "1. a\n2. b|\n\n\t\tcode", "1. a\n   1. b|\n\n\t\t  code"],
      // `\t` が本文の列 3 をまたぐ。新しい字下げは元の列（4）でなく目標の列から数える。元の列から
      // 数えると 1 列余り、コードの中身の先頭に空白が入る
      [
        "tab",
        "1. a\n2. b|\n\t```go\n\tfunc f() {\n\t\treturn\n\t}\n\t```",
        "1. a\n   1. b|\n\t  ```go\n\t  func f() {\n\t  \treturn\n\t  }\n\t  ```",
      ],
    ] as const;
    for (const [key, doc, expected] of changed) {
      const view = setup(doc);
      const before = blockNames(view);
      expect(key === "tab" ? tab(view) : shiftTab(view), doc).toBe(true);
      expect(withCursor(view), doc).toBe(expected);
      expect(blockNames(view), doc).toEqual(before);
    }
    // 読み方が変わる変更は捨てる。何もしないがキーは奪う
    const refused = [
      // 怠惰な継続行は動かさないので、浅くした item の本文の列に届いて setext の下線になる
      ["stab", "- p\n  - a|\n  ===\n- q"],
      ["stab", "- p\n  - a|\n  ---\n- q"],
      // 項目の 1 行目にあるインデントされたコードのタブ。記号と一緒に動かすとコードの中身が変わる
      ["tab", "- a\n-     \tb|"],
      // `- | -` が表の区切り行として読まれ、段落が 2 つに分かれる / つながる。表の `|` がカーソルの
      // 印と紛れるので、先頭の `|` を印にしてからカーソルを文書の末尾に置く
      ["tab", "|- t0\n  x | y\n- | -"],
      ["stab", "|- p\n  - t0\n    x | y\n    - | -"],
    ] as const;
    for (const [key, doc] of refused) {
      const view = setup(doc);
      if (doc.startsWith("|"))
        view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
      const before = view.state.doc.toString();
      expect(key === "tab" ? tab(view) : shiftTab(view), doc).toBe(true);
      expect(view.state.doc.toString(), doc).toBe(before);
    }
  });

  /** 長い番号付きリスト。Tab で 2 項目目を入れ子にすると、最後の項目まで番号が詰まる */
  const longOrderedList = (items: number) =>
    Array.from({ length: items }, (_, i) => `${i + 1}. item ${i + 1}${i === 1 ? "|" : ""}`).join(
      "\n",
    );

  test("a list longer than the parsed part is parsed to its end before the change", () => {
    const view = setup(longOrderedList(3000));
    expect(syntaxTree(view.state).length).toBeLessThan(view.state.doc.length);
    expect(tab(view)).toBe(true);
    const lines = view.state.doc.toString().split("\n");
    expect(lines.slice(0, 3)).toEqual(["1. item 1", "   1. item 2", "2. item 3"]);
    expect(lines.at(-1)).toBe("2999. item 3000");
  });

  test("when parsing the list does not finish in time, Tab does nothing but keeps the key", () => {
    const view = setup(longOrderedList(3000));
    const before = view.state.doc.toString();
    expect(syntaxTree(view.state).length).toBeLessThan(before.length);
    // ensureSyntaxTree は Date.now で時間の上限を測る。1 回ごとに 1 秒進め、解析を打ち切らせる
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
    try {
      expect(tab(view)).toBe(true);
    } finally {
      clock.mockRestore();
    }
    expect(view.state.doc.toString()).toBe(before);
  });

  test("Tab outside lists is left to the browser", () => {
    for (const doc of ["text|", "- a\n\n|", "- a\n  ```\n  co|de\n  ```"]) {
      const view = setup(doc);
      const before = view.state.doc.toString();
      expect(tab(view)).toBe(false);
      expect(shiftTab(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(before);
    }
  });
});

// runScopeHandlers は keymap しか通らないので、フォーカスの移動は実際のキー入力で見る
describe("keyboard focus", () => {
  function setupWithNextFocusable(docWithCursor: string) {
    const view = setup(docWithCursor);
    const next = document.createElement("button");
    next.textContent = "next";
    view.dom.parentElement?.after(next);
    cleanups.push(() => next.remove());
    view.focus();
    return { view, next };
  }

  test("Tab outside a list still moves focus out of the editor", async () => {
    const { view, next } = setupWithNextFocusable("text|");
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(next);
    expect(view.state.doc.toString()).toBe("text");
  });

  test("Escape then Tab leaves the editor even inside a list", async () => {
    const { view, next } = setupWithNextFocusable("- a\n- b|");
    await userEvent.keyboard("{Tab}");
    expect(view.state.doc.toString()).toBe("- a\n  - b");
    expect(document.activeElement).toBe(view.contentDOM);

    await userEvent.keyboard("{Escape}{Tab}");
    expect(document.activeElement).toBe(next);
    expect(view.state.doc.toString()).toBe("- a\n  - b");
  });
});

describe("Shift+Enter", () => {
  test("breaks the line inside the list item without a new marker", () => {
    const cases: [string, string][] = [
      ["- a|", "- a\n  |"],
      ["1. a|", "1. a\n   |"],
      ["- [ ] a|", "- [ ] a\n      |"],
      ["- a\n  - b|", "- a\n  - b\n    |"],
      ["- ab|cd", "- ab\n  |cd"],
      ["- a |", "- a\n  |"],
      ["> - a|", "> - a\n>   |"],
    ];
    for (const [before, after] of cases) {
      const view = setup(before);
      expect(shiftEnter(view)).toBe(true);
      expect(withCursor(view)).toBe(after);
    }
  });

  test("keeps the quote mark inside a blockquote", () => {
    const view = setup("> a|");
    shiftEnter(view);
    expect(withCursor(view)).toBe("> a\n> |");
  });

  test("the next Enter on the continuation line does not add a marker either", () => {
    const view = setup("- a|");
    shiftEnter(view);
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "b" },
      selection: { anchor: 7 },
    });
    press(view, "Enter");
    expect(withCursor(view)).toBe("- a\n  b\n  |");
  });

  test("outside lists and quotes it falls back to a plain newline", () => {
    const view = setup("text|");
    expect(shiftEnter(view)).toBe(true);
    expect(withCursor(view)).toBe("text\n|");
  });
});

describe("with history", () => {
  /** `|` の位置にカーソルを置き、doc を変えた transaction の数を数える */
  function setupCounting(docWithCursor: string): { view: EditorView; edits: () => number } {
    const cursor = docWithCursor.indexOf("|");
    let edits = 0;
    const view = mount((parent) =>
      createEditor(parent, {
        doc: docWithCursor.replace("|", ""),
        onUpdate: (update) => {
          edits += update.transactions.filter((tr) => tr.docChanged).length;
        },
      }),
    );
    view.dispatch({ selection: EditorSelection.cursor(cursor) });
    return { view, edits: () => edits };
  }

  test("one Tab is one transaction and one undo step", () => {
    const { view, edits } = setupCounting("1. p\n   1. a\n2. b|\n3. c\n   more");
    tab(view);
    expect(view.state.doc.toString()).toBe("1. p\n   1. a\n   2. b\n2. c\n   more");
    expect(edits()).toBe(1);
    expect(undoDepth(view.state)).toBe(1);

    undo(view);
    expect(view.state.doc.toString()).toBe("1. p\n   1. a\n2. b\n3. c\n   more");
  });

  test("Shift+Tab and Shift+Enter are one transaction each", () => {
    const { view, edits } = setupCounting("- a\n  - b|");
    shiftTab(view);
    expect(edits()).toBe(1);
    shiftEnter(view);
    expect(edits()).toBe(2);
    expect(view.state.doc.toString()).toBe("- a\n- b\n  ");
  });

  // newGroupDelay（500ms）の内側でも、直前と直後の入力とはまとめない
  test("a Tab between quick typing is its own undo step", () => {
    const { view } = setupCounting("- a\n- |");
    view.dispatch({
      changes: { from: 6, insert: "b" },
      selection: { anchor: 7 },
      userEvent: "input.type",
    });
    tab(view);
    view.dispatch({
      changes: { from: 9, insert: "c" },
      selection: { anchor: 10 },
      userEvent: "input.type",
    });
    expect(undoDepth(view.state)).toBe(3);

    undo(view);
    expect(view.state.doc.toString()).toBe("- a\n  - b");
    undo(view);
    expect(view.state.doc.toString()).toBe("- a\n- b");
  });
});

// CodeMirror は composition 中の keydown（keyCode 229）を keymap に渡す前に捨てるので、実際の
// キー入力ではこのガードに届かない。Safari のように compositionend と keydown の順序が
// 入れ替わったときに頼るガードなので、ここでは keymap を直接呼んで確かめる。
// 既定の keymap を載せると、ガードが false を返した後の Shift+Enter を insertNewlineAndIndent が
// 拾ってしまうので、list-keymap だけの view で見る。
describe("during composition", () => {
  test("Tab, Shift+Tab and Shift+Enter leave the text to the IME", () => {
    const view = mount(
      (parent) =>
        new EditorView({
          parent,
          state: EditorState.create({
            doc: "- a\n  - b",
            selection: { anchor: 9 },
            extensions: [markdown({ base: markdownLanguage }), listKeymap()],
          }),
        }),
    );
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(view.compositionStarted).toBe(true);
    expect(tab(view)).toBe(false);
    expect(shiftTab(view)).toBe(false);
    expect(shiftEnter(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("- a\n  - b");
  });
});

describe("with wikilink candidates open", () => {
  test("Tab accepts the candidate instead of nesting the item", async () => {
    const pageIndex = createMemoryPageIndex([{ id: "p1", title: "Code" }], {
      normalize: (text) => text.toLowerCase(),
    });
    const view = mount((parent) => createEditor(parent, { doc: "- a\n- ", pageIndex }));
    view.dispatch({
      changes: { from: 6, insert: "[[Co" },
      selection: { anchor: 10 },
      userEvent: "input.type",
    });
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    // 開いた直後（interactionDelay の 75ms）は acceptCompletion が確定しない
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(tab(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("- a\n- [[Code]]");
  });
});
