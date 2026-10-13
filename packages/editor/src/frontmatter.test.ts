import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createEditor } from "./create-editor";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc: string): EditorView {
  host = document.createElement("div");
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

function firstBlock(v: EditorView): { name: string; to: number } {
  const tree = ensureSyntaxTree(v.state, v.state.doc.length, 5000);
  const node = tree?.topNode.firstChild;
  return { name: node?.name ?? "", to: node?.to ?? -1 };
}

// TreeFragment は 128 文字未満だと再利用されないので、incremental parse が起きる長さにする
const properties = "key: value\n".repeat(20);

describe("frontmatter", () => {
  it("中の WikiLink と tag を装飾しない", () => {
    const v = mount("---\nrelated: [[A]] #inner\n---\n[[B]] #outer");
    ensureSyntaxTree(v.state, v.state.doc.length, 5000);

    const links = [...v.contentDOM.querySelectorAll(".cm-wikilink")].map((el) => el.textContent);
    const tags = [...v.contentDOM.querySelectorAll(".cm-tag")].map((el) => el.textContent);
    expect(links.join("")).not.toContain("A");
    expect(tags.join("")).not.toContain("inner");
    expect(tags.join("")).toContain("outer");
  });

  it("後から閉じ `---` を打つと、先頭の区切り線が frontmatter に置き換わる", () => {
    const v = mount(`---\n${properties}\nbody`);
    expect(firstBlock(v).name).toBe("HorizontalRule");

    const at = v.state.doc.toString().indexOf("\nbody");
    v.dispatch({ changes: { from: at, insert: "---\n" } });

    expect(firstBlock(v)).toEqual({ name: "Frontmatter", to: at + 3 });
  });

  it("閉じ `---` を崩すと、frontmatter でなくなる", () => {
    const v = mount(`---\n${properties}---\n\nbody`);
    expect(firstBlock(v).name).toBe("Frontmatter");

    const at = v.state.doc.toString().indexOf("---\n\nbody") + 3;
    v.dispatch({ changes: { from: at, insert: "x" } });

    expect(firstBlock(v).name).toBe("HorizontalRule");
  });
});
