import { normalizeTitleKey } from "@personal-wiki/domain";
import { describe, expect, it } from "vitest";
import { extractDerived } from "./extract-derived";

describe("extractDerived", () => {
  it("returns empty data for an empty body", () => {
    expect(extractDerived("")).toEqual({ links: [], tags: [], plainText: "" });
  });

  it("does not derive a link from a same-page heading or block reference", () => {
    expect(
      extractDerived("[[#見出し]] [[#^abc]] [[A#見出し]]").links.map((l) => l.targetTitle),
    ).toEqual(["A"]);
  });

  it("derives no tag from a same-page heading link, and keeps its text in the plain text", () => {
    const derived = extractDerived("前 [[#見出し]] [[#foo|lbl]] [[#^abc]] 後");
    expect(derived.tags).toEqual([]);
    expect(derived.plainText).toBe("前 #見出し lbl #^abc 後");
  });

  it("derives links, tags and plain text from one body", () => {
    const derived = extractDerived("# 見出し\n\n[[読書メモ|メモ]] と #project/x を書く。\n");
    expect(derived.links).toEqual([{ targetTitle: "読書メモ", targetTitleKey: "読書メモ" }]);
    expect(derived.tags.map((t) => t.tag)).toEqual(["project/x"]);
    expect(derived.plainText).toBe("見出し メモ と #project/x を書く。");
  });

  it("uses the domain normalization for targetTitleKey", () => {
    const [link] = extractDerived("[[ＣｏｄｅＭｉｒｒｏｒ  Review]]").links;
    const expected = normalizeTitleKey("ＣｏｄｅＭｉｒｒｏｒ  Review");
    expect(link?.targetTitleKey).toBe(expected.ok ? expected.value : undefined);
    expect(link?.targetTitleKey).toBe("codemirror review");
  });

  it("drops the heading and block id from the target", () => {
    const { links } = extractDerived("[[A#見出し]] [[B^blk]]");
    expect(links.map((l) => l.targetTitle)).toEqual(["A", "B"]);
  });

  it("folds links with the same title_key into the first one", () => {
    const { links } = extractDerived("[[Note]] [[ note ]] [[ＮＯＴＥ|別名]] [[Other]]");
    expect(links.map((l) => l.targetTitle)).toEqual(["Note", "Other"]);
  });

  it("keeps page embeds but drops attachment embeds", () => {
    const { links } = extractDerived(
      "![[Page]] ![[a.png]] ![[b.MP4]] ![[doc.pdf]] ![[song.mp3]] [[c.png]]",
    );
    expect(links.map((l) => l.targetTitle)).toEqual(["Page", "c.png"]);
  });

  it("skips targets that have no title_key", () => {
    expect(extractDerived("[[ ]] [[Real]]").links.map((l) => l.targetTitle)).toEqual(["Real"]);
  });

  it("ignores links and tags in code and in frontmatter links", () => {
    const body =
      "---\nrelated: '[[InFront]]'\n---\n\n`[[Code]] #code`\n\n```\n[[Fence]] #fence\n```\n";
    const derived = extractDerived(body);
    expect(derived.links).toEqual([]);
    expect(derived.tags.map((t) => t.tag)).toEqual([]);
  });

  it("puts frontmatter tags before body tags and folds duplicates", () => {
    const body = "---\ntags: [Rust, web]\n---\n\n#web #rust #go\n";
    expect(extractDerived(body).tags.map((t) => t.tag)).toEqual(["Rust", "web", "go"]);
  });

  it("drops frontmatter tag values that cannot be read as a tag", () => {
    const body = "---\ntags: [ok, 'a b']\n---\n";
    expect(extractDerived(body).tags.map((t) => t.tag)).toEqual(["ok"]);
  });

  it("returns a folded tag key shared across spellings", () => {
    expect(extractDerived("#Rust").tags).toEqual([{ tag: "Rust", tagKey: "rust" }]);
    expect(extractDerived("#ｒｕｓｔ").tags[0]?.tagKey).toBe("rust");
  });

  it("does not read a tags line outside the frontmatter", () => {
    expect(extractDerived("text\n\ntags: [x]\n").tags.map((t) => t.tag)).toEqual([]);
  });

  it("leaves out frontmatter and syntax from the plain text", () => {
    const body = "---\ntags: [a]\n---\n\n**強調** と ==ハイライト== %%コメント%%\n";
    expect(extractDerived(body).plainText).toBe("強調 と ハイライト");
  });
});
