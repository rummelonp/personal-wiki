import { GFM, parser } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { BlockId, blockIdNodes, extractBlockIds } from "./block-id";
import { Frontmatter } from "./frontmatter";
import { extractTags, Tag, tagNodes } from "./tag";
import { ObsidianTaskList, parseTaskMarker, taskListNodes, toggledTaskStatus } from "./task-list";
import { extractWikiLinks, WikiLink, wikiLinkNodes } from "./wikilink";

const taskParser = parser.configure([Frontmatter, WikiLink, Tag, BlockId, ObsidianTaskList]);
// Editor（create-editor.ts）の base は GFM 入りなので、GFM の TaskList を置き換えられることも見る
const gfmTaskParser = parser.configure([GFM, WikiLink, Tag, ObsidianTaskList]);

/** TaskMarker の source を出現順に返す */
function markers(text: string, p = taskParser): string[] {
  const found: string[] = [];
  p.parse(text).iterate({
    enter(node) {
      if (node.name === taskListNodes.marker) found.push(text.slice(node.from, node.to));
      return true;
    },
  });
  return found;
}

/** Task の source（marker から段落の終わりまで）を出現順に返す */
function tasks(text: string): string[] {
  const found: string[] = [];
  taskParser.parse(text).iterate({
    enter(node) {
      if (node.name === taskListNodes.task) found.push(text.slice(node.from, node.to));
      return true;
    },
  });
  return found;
}

describe("ObsidianTaskList", () => {
  it.each([
    ["- [ ] 未完了", "[ ]"],
    ["- [x] 完了", "[x]"],
    ["- [X] 大文字", "[X]"],
    ["- [-] 取り消し", "[-]"],
    ["- [?] 疑問", "[?]"],
    ["- [/] 途中", "[/]"],
    ["- [あ] 全角", "[あ]"],
    ["- [　] 全角空白", "[　]"],
    ["- [😀] 絵文字", "[😀]"],
    ["- [\t] タブ", "[\t]"],
    ["- [x]\tタブ区切り", "[x]"],
    ["- [ ] ", "[ ]"],
    ["* [x] a", "[x]"],
    ["+ [x] a", "[x]"],
    ["1. [x] a", "[x]"],
    ["1) [ ] a", "[ ]"],
  ])("parses %j as a task with the marker %j", (doc, marker) => {
    expect(markers(doc)).toEqual([marker]);
  });

  it.each([
    ["an empty bracket", "- [] a"],
    ["two characters", "- [xx] a"],
    ["a backtick in the bracket", "- [`] a"],
    ["no whitespace after the bracket", "- [x]a"],
    ["nothing after the bracket", "- [ ]"],
    ["a bracket that is not at the start of the item", "- a [x] b"],
    ["a paragraph outside a list", "[x] a"],
    ["an indented code block in a list", "-     [x] a"],
    ["a fenced code block", "```\n- [x] a\n```"],
  ])("does not parse %s as a task", (_, doc) => {
    expect(markers(doc)).toEqual([]);
  });

  it("parses nested tasks and tasks inside a blockquote", () => {
    expect(markers("- [ ] 親\n  - [x] 子\n    - [-] 孫")).toEqual(["[ ]", "[x]", "[-]"]);
    expect(markers("> - [x] 引用")).toEqual(["[x]"]);
  });

  it("covers the whole first paragraph of the item, including continuation lines", () => {
    expect(tasks("- [x] 一行目\n  二行目\n- [ ] 次")).toEqual(["[x] 一行目\n  二行目", "[ ] 次"]);
  });

  it("parses the inline syntax after the marker", () => {
    const doc = "- [x] [[Title]] #tag ^block1";
    const names: string[] = [];
    taskParser.parse(doc).iterate({
      enter(node) {
        names.push(node.name);
        return true;
      },
    });
    expect(names).toContain(wikiLinkNodes.link);
    expect(names).toContain(tagNodes.name);
    expect(names).toContain(blockIdNodes.name);
  });

  it("replaces the GFM TaskList, which only accepts a space and x", () => {
    expect(markers("- [-] a\n- [?] b\n- [x] c", gfmTaskParser)).toEqual(["[-]", "[?]", "[x]"]);
    expect(markers("- [-] a", parser.configure(GFM))).toEqual([]);
  });
});

describe("parseTaskMarker", () => {
  it("treats only a space as unchecked", () => {
    expect(parseTaskMarker("[ ]")).toEqual({ status: " ", checked: false });
    for (const status of ["x", "X", "-", "?", "あ", "　", "\t", "😀"]) {
      expect(parseTaskMarker(`[${status}]`)).toEqual({ status, checked: true });
    }
  });

  it.each(["[]", "[xx]", "[x] ", " [x]", "[x", "x]", "[]]", "[\n]", "[`]", "(x)"])(
    "rejects %j",
    (marker) => {
      expect(parseTaskMarker(marker)).toBeNull();
    },
  );
});

describe("toggledTaskStatus", () => {
  it("writes x into an unchecked task", () => {
    const marker = parseTaskMarker("[ ]");
    if (!marker) throw new Error("not a marker");
    expect(toggledTaskStatus(marker)).toBe("x");
  });

  it.each(["x", "X", "-", "?", "😀"])("clears a task checked with %j", (status) => {
    const marker = parseTaskMarker(`[${status}]`);
    if (!marker) throw new Error("not a marker");
    expect(toggledTaskStatus(marker)).toBe(" ");
  });
});

/**
 * links/tags/block id の抽出は ObsidianTaskList を載せない parser を使う。
 * Task の中身は段落と同じく inline として解析されるので、載せた parser との比較で抽出結果が
 * 変わらないことを固定する。
 */
describe("extraction is unaffected by task lists", () => {
  const docs = [
    "- [ ] [[Title]] と #tag",
    "- [x] [[Other|Label]] ^done1",
    "- [-] #日本語 の ![[Embed]]\n  続き [[Next]] ^cont1",
    "1. [?] [[A]]\n   - [x] [[B]] #nested ^nested1",
    "> - [ ] [[Quoted]] #quote",
  ];

  for (const doc of docs) {
    it(`finds the same links, tags and block ids with or without ObsidianTaskList: ${JSON.stringify(doc)}`, () => {
      const links: [number, number][] = [];
      const tagNames: string[] = [];
      const blockIds: string[] = [];
      taskParser.parse(doc).iterate({
        enter(node) {
          if (node.name === wikiLinkNodes.link) links.push([node.from, node.to]);
          if (node.name === tagNodes.name) tagNames.push(doc.slice(node.from, node.to));
          if (node.name === blockIdNodes.name) blockIds.push(doc.slice(node.from, node.to));
          return true;
        },
      });
      expect(markers(doc).length).toBeGreaterThan(0);
      expect(extractWikiLinks(doc).map((ref) => [ref.from, ref.to])).toEqual(links);
      expect(extractTags(doc)).toEqual(tagNames);
      expect(extractBlockIds(doc).map((ref) => ref.id)).toEqual(blockIds);
    });
  }

  // task にすると Editor は `#tag` を tag として読むが、抽出では `` ` `` が開いた code span に入る
  it("does not make a task of a backtick bracket, whose backtick opens a code span in extraction", () => {
    const doc = "- [`] #tag `x`";
    expect(markers(doc)).toEqual([]);
    const tagNames: string[] = [];
    taskParser.parse(doc).iterate({
      enter(node) {
        if (node.name === tagNodes.name) tagNames.push(doc.slice(node.from, node.to));
        return true;
      },
    });
    expect(extractTags(doc)).toEqual([]);
    expect(tagNames).toEqual([]);
  });
});
