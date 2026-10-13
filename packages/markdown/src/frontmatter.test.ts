import { TreeFragment } from "@lezer/common";
import { parser } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { extractBlockIds } from "./block-id";
import { Frontmatter, frontmatterEnd } from "./frontmatter";
import { extractTags } from "./tag";
import { extractWikiLinks } from "./wikilink";

const frontmatterParser = parser.configure(Frontmatter);

function topLevelNodes(text: string): string[] {
  const names: string[] = [];
  const cursor = frontmatterParser.parse(text).cursor();
  if (cursor.firstChild()) {
    do names.push(cursor.name);
    while (cursor.nextSibling());
  }
  return names;
}

describe("frontmatterEnd", () => {
  it.each([
    ["閉じていれば閉じ `---` 行の末尾を返す", "---\na: 1\n---\nbody", 12],
    ["中身が空でも frontmatter とみなす", "---\n---\nbody", 7],
    ["閉じ `---` が文書の末尾でもよい", "---\na: 1\n---", 12],
    ["区切り行の前後の空白は無視する", "--- \na: 1\n ---\nbody", 14],
    ["閉じ `---` が無ければ null", "---\na: 1\nbody", null],
    ["1 行目が `---` でなければ null", "body\n---\na: 1\n---", null],
    ["1 行だけの `---` は null", "---", null],
  ])("%s", (_, text, expected) => {
    expect(frontmatterEnd(text)).toBe(expected);
  });
});

describe("Frontmatter", () => {
  it("先頭の frontmatter を区切り線や setext 見出しでなく 1 つの block にする", () => {
    expect(topLevelNodes("---\ntitle: x\n---\n\nbody")).toEqual(["Frontmatter", "Paragraph"]);
  });

  it("閉じていない `---` は区切り線のまま", () => {
    expect(topLevelNodes("---\n\nbody")).toEqual(["HorizontalRule", "Paragraph"]);
  });

  it("2 行目以降の `---` 区切りは frontmatter にしない", () => {
    expect(topLevelNodes("body\n\n---\na\n---")).not.toContain("Frontmatter");
  });

  it("frontmatter 内の WikiLink、tag、block id を抽出しない", () => {
    const text = "---\nrelated: [[A]]\ntags: #inner ^blk\n---\n[[B]] #outer";
    expect(extractWikiLinks(text).map((ref) => ref.target)).toEqual(["B"]);
    expect(extractTags(text)).toEqual(["outer"]);
    expect(extractBlockIds(text)).toEqual([]);
  });

  it("frontmatter の後ろの WikiLink の位置は文書全体での位置のまま", () => {
    const text = "---\na: 1\n---\n[[B]]";
    const [ref] = extractWikiLinks(text);
    expect(ref).toMatchObject({ from: text.indexOf("[[B]]"), to: text.length });
  });

  it("閉じていない frontmatter の中身は通常の本文として抽出する", () => {
    expect(extractWikiLinks("---\n[[A]]").map((ref) => ref.target)).toEqual(["A"]);
  });
});

describe("Frontmatter の incremental parse", () => {
  // TreeFragment.applyChanges は 128 文字未満の fragment を捨てるので、再利用が起きる長さにする
  const properties = "key: value\n".repeat(20);

  function reparse(before: string, at: number, inserted: string) {
    const tree = frontmatterParser.parse(before);
    const after = before.slice(0, at) + inserted + before.slice(at);
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [
      { fromA: at, toA: at, fromB: at, toB: at + inserted.length },
    ]);
    const cursor = frontmatterParser.parse(after, fragments).cursor();
    cursor.firstChild();
    return { name: cursor.name, to: cursor.to, after };
  }

  it("後から閉じ `---` を打つと、再利用された区切り線を捨てて frontmatter にする", () => {
    const before = `---\n${properties}\nbody`;
    const at = before.indexOf("\nbody");
    const { name, to, after } = reparse(before, at, "---\n");
    expect(name).toBe("Frontmatter");
    expect(to).toBe(frontmatterEnd(after));
  });

  it("閉じ `---` の直後に打って区切りでなくなると、frontmatter でなくなる", () => {
    const before = `---\n${properties}---\n\nbody`;
    const { name } = reparse(before, before.indexOf("---\n\nbody") + 3, "x");
    expect(name).toBe("HorizontalRule");
  });

  it("frontmatter の中を編集すると、終端が編集後の位置に追従する", () => {
    const before = `---\n${properties}---\n\nbody`;
    const { name, to, after } = reparse(before, 4, "new: 1\n");
    expect(name).toBe("Frontmatter");
    expect(to).toBe(frontmatterEnd(after));
  });

  it("frontmatter の後ろだけを編集したときも frontmatter のまま", () => {
    const before = `---\n${properties}---\n\nbody`;
    const { name, to, after } = reparse(before, before.length, " more");
    expect(name).toBe("Frontmatter");
    expect(to).toBe(frontmatterEnd(after));
  });
});
