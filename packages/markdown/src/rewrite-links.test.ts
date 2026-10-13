import { normalizeTitleKey } from "@personal-wiki/domain";
import { describe, expect, it } from "vitest";
import { extractDerived } from "./extract-derived";
import { rewriteWikiLinkTargets } from "./rewrite-links";

function key(title: string): string {
  const result = normalizeTitleKey(title);
  if (!result.ok) throw new Error(`invalid title: ${title}`);
  return result.value;
}

function rewrite(body: string, ...pairs: [string, string][]) {
  return rewriteWikiLinkTargets(body, new Map(pairs.map(([from, to]) => [key(from), to])));
}

function linkKeys(body: string): string[] {
  return extractDerived(body).links.map((l) => l.targetTitleKey);
}

describe("rewriteWikiLinkTargets", () => {
  it("rewrites only the target of a plain link", () => {
    expect(rewrite("[[旧]]", ["旧", "新"])).toEqual({ body: "[[新]]", rewritten: 1 });
  });

  it("keeps the label and its separator", () => {
    expect(rewrite("[[旧|ラベル]]", ["旧", "新"]).body).toBe("[[新|ラベル]]");
    expect(rewrite("| [[旧\\|ラベル]] |", ["旧", "新"]).body).toBe("| [[新\\|ラベル]] |");
  });

  it("keeps the heading, block id and combined reference", () => {
    expect(rewrite("[[旧#節]] [[旧^abc]] [[旧#^abc]] [[旧#節|ラベル]]", ["旧", "新"])).toEqual({
      body: "[[新#節]] [[新^abc]] [[新#^abc]] [[新#節|ラベル]]",
      rewritten: 4,
    });
  });

  it("keeps the embed marker", () => {
    expect(rewrite("![[旧]] ![[旧#節]]", ["旧", "新"]).body).toBe("![[新]] ![[新#節]]");
  });

  it("keeps whitespace around the target", () => {
    expect(rewrite("[[  旧  ]] [[ 旧 #節]] [[\t旧 |ラベル]]", ["旧", "新"]).body).toBe(
      "[[  新  ]] [[ 新 #節]] [[\t新 |ラベル]]",
    );
  });

  it("matches differently written targets and normalizes them to the new title", () => {
    expect(rewrite("[[Note]] [[note]] [[ＮＯＴＥ]] [[ Note  ]]", ["Note", "Memo"])).toEqual({
      body: "[[Memo]] [[Memo]] [[Memo]] [[ Memo  ]]",
      rewritten: 4,
    });
  });

  it("leaves a same-page reference alone", () => {
    const body = "[[#旧]] [[#^旧]] [[#旧|旧]]";
    expect(rewrite(body, ["旧", "新"])).toEqual({ body, rewritten: 0 });
  });

  it("leaves other targets alone and rewrites several renames at once", () => {
    expect(rewrite("[[A]] [[B]] [[C]] [[A|a]]", ["A", "X"], ["B", "Y"])).toEqual({
      body: "[[X]] [[Y]] [[C]] [[X|a]]",
      rewritten: 3,
    });
  });

  it("rewrites several links on one line", () => {
    expect(rewrite("前 [[旧]] 中 [[旧|a]] ![[旧]] 後", ["旧", "新"])).toEqual({
      body: "前 [[新]] 中 [[新|a]] ![[新]] 後",
      rewritten: 3,
    });
  });

  it("does not rewrite an attachment embed but rewrites a link with the same name", () => {
    expect(
      rewrite("![[旧.png]] [[旧.png]] ![[旧.mp4]]", ["旧.png", "新"], ["旧.mp4", "新"]),
    ).toEqual({
      body: "![[旧.png]] [[新]] ![[旧.mp4]]",
      rewritten: 1,
    });
  });

  it("does not rewrite inside fenced code blocks", () => {
    const body = "[[旧]]\n```\n[[旧]]\n```\n~~~md\n[[旧]]\n~~~\n[[旧]]\n";
    expect(rewrite(body, ["旧", "新"])).toEqual({
      body: "[[新]]\n```\n[[旧]]\n```\n~~~md\n[[旧]]\n~~~\n[[新]]\n",
      rewritten: 2,
    });
  });

  it("does not rewrite inside inline code", () => {
    expect(rewrite("`[[旧]]` と [[旧]] と ``[[旧]]``", ["旧", "新"])).toEqual({
      body: "`[[旧]]` と [[新]] と ``[[旧]]``",
      rewritten: 1,
    });
  });

  it("does not rewrite inside frontmatter", () => {
    const body = "---\nrelated: '[[旧]]'\n---\n[[旧]]\n";
    expect(rewrite(body, ["旧", "新"])).toEqual({
      body: "---\nrelated: '[[旧]]'\n---\n[[新]]\n",
      rewritten: 1,
    });
  });

  it("returns the same body when there are no renames", () => {
    const body = "[[旧]] `x` ![[a.png]]";
    expect(rewriteWikiLinkTargets(body, new Map())).toEqual({ body, rewritten: 0 });
  });

  it("does not replace or count a target that already equals the new title", () => {
    expect(rewrite("[[Note]] [[ Note |a]]", ["note", "Note"])).toEqual({
      body: "[[Note]] [[ Note |a]]",
      rewritten: 0,
    });
    expect(rewrite("[[note]] [[Note]]", ["note", "Note"])).toEqual({
      body: "[[Note]] [[Note]]",
      rewritten: 1,
    });
  });

  it("returns the same body when nothing matches", () => {
    const body = "[[他]] plain text";
    expect(rewrite(body, ["旧", "新"])).toEqual({ body, rewritten: 0 });
  });

  it("changes only the renamed key when the result is parsed again", () => {
    const body = [
      "---",
      "tags: [x]",
      "---",
      "[[旧]] [[旧#節|a]] ![[旧]] [[他]] [[他2^id]] [[#節]]",
      "`[[旧]]`",
      "```",
      "[[旧]]",
      "```",
      "",
    ].join("\n");
    expect(linkKeys(body)).toEqual([key("旧"), key("他"), key("他2")]);
    const { body: after } = rewrite(body, ["旧", "新"]);
    expect(linkKeys(after)).toEqual([key("新"), key("他"), key("他2")]);
    expect(extractDerived(after).tags).toEqual(extractDerived(body).tags);
  });
});
