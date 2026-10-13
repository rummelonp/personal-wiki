import { describe, expect, it } from "vitest";
import type { PageEmbedContent } from "./embed";
import { SectionContents } from "./section-content";

const page = (text: string): PageEmbedContent => ({ kind: "resolved", title: "Note", text });

describe("SectionContents", () => {
  it("returns the same section for the same content and heading", () => {
    const sections = new SectionContents();
    const content = page("## A\n\nA の本文\n\n## B");
    sections.startBuild();
    const first = sections.resolve("Note", content, "A");
    expect(first).toEqual(page("## A\n\nA の本文"));
    sections.startBuild();
    expect(sections.resolve("Note", content, "A")).toBe(first);
  });

  it("returns the whole content for a missing heading and passes other states through", () => {
    const sections = new SectionContents();
    const content = page("## A");
    const loading: PageEmbedContent = { kind: "loading" };
    sections.startBuild();
    expect(sections.resolve("Note", content, "無い")).toBe(content);
    expect(sections.resolve("Note", loading, "A")).toBe(loading);
    expect(sections.resolve("Note", content, null)).toBe(content);
  });

  it("reuses the previous section when new content has the same section text", () => {
    const sections = new SectionContents();
    sections.startBuild();
    const first = sections.resolve("Note", page("## A\n\n本文\n\n## B\n\n前"), "A");
    sections.startBuild();
    expect(sections.resolve("Note", page("## A\n\n本文\n\n## B\n\n後"), "A")).toBe(first);
  });

  it("drops a pair that the last build did not see", () => {
    const sections = new SectionContents();
    sections.startBuild();
    const first = sections.resolve("Note", page("## A\n\n本文\n\n## B\n\n前"), "A");
    // この build では embed が画面の外にあるか消えていて、組を見ない
    sections.startBuild();
    sections.startBuild();
    const next = sections.resolve("Note", page("## A\n\n本文\n\n## B\n\n後"), "A");
    expect(next).not.toBe(first);
    expect(next).toEqual(first);
  });
});
