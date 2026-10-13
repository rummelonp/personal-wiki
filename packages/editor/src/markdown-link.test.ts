import { EditorSelection, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "./create-editor";

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

const lineText = (v: EditorView, n = 0) =>
  v.contentDOM.querySelectorAll(".cm-line")[n]?.textContent ?? "";

const placeCursor = (v: EditorView, pos: number) => {
  v.focus();
  v.dispatch({ selection: EditorSelection.cursor(pos) });
};

describe("markdown link decoration", () => {
  it("hides the url and keeps the link text", () => {
    const v = mount("前 [リンク](https://example.com/) 後");
    expect(lineText(v)).toBe("前 リンク 後");
    expect(v.state.doc.toString()).toBe("前 [リンク](https://example.com/) 後");
  });

  it("marks the visible text with the url for navigation", () => {
    const v = mount("[リンク](https://example.com/path)");
    const link = v.contentDOM.querySelector(".cm-md-link");
    expect(link?.textContent).toBe("リンク");
    expect(link?.getAttribute("data-md-link-url")).toBe("https://example.com/path");
  });

  it("keeps a title after the url hidden as well", () => {
    const v = mount('前 [リンク](https://example.com/ "タイトル") 後');
    expect(lineText(v)).toBe("前 リンク 後");
  });

  it("leaves a reference-style link as source, since it has no url to hide", () => {
    const v = mount("[リンク][ref]\n\n[ref]: https://example.com/");
    expect(lineText(v, 0)).toBe("[リンク][ref]");
    expect(v.contentDOM.querySelector(".cm-md-link")).toBeNull();
  });

  it("leaves a shortcut reference link as source", () => {
    const v = mount("[ref]\n\n[ref]: https://example.com/");
    expect(lineText(v, 0)).toBe("[ref]");
  });

  it("decorates emphasis inside the link text", () => {
    const v = mount("[**太字**](https://example.com/)");
    const strong = v.contentDOM.querySelector(".cm-lp-strong");
    expect(strong?.textContent).toBe("太字");
  });

  it("leaves a link inside a fenced code block as source", () => {
    const v = mount("```\n[リンク](https://example.com/)\n```");
    expect(lineText(v, 1)).toBe("[リンク](https://example.com/)");
  });

  it("leaves a link with empty text as source instead of concealing the whole node", () => {
    const v = mount("前 [](https://example.com/) 後");
    expect(lineText(v)).toBe("前 [](https://example.com/) 後");
    expect(v.contentDOM.querySelector(".cm-md-link")).toBeNull();
  });

  it("marks the visible text with a title so the destination is readable on hover", () => {
    const v = mount("[リンク](https://example.com/path)");
    const link = v.contentDOM.querySelector(".cm-md-link");
    expect(link?.getAttribute("title")).toBe("https://example.com/path");
  });

  it("strips angle brackets from the url attribute and title", () => {
    const v = mount("[リンク](<https://example.com/>)");
    const link = v.contentDOM.querySelector(".cm-md-link");
    expect(link?.getAttribute("data-md-link-url")).toBe("https://example.com/");
    expect(link?.getAttribute("title")).toBe("https://example.com/");
  });
});

describe("markdown link reveal", () => {
  const DOC = "前 [リンク](https://example.com/) 後";
  const linkFrom = DOC.indexOf("[");
  const linkTo = DOC.indexOf(")") + 1;

  it.each([
    ["the opening bracket", linkFrom],
    ["inside the url", DOC.indexOf("example")],
    ["the closing paren", linkTo],
  ])("shows the source while the cursor is at %s", (_, pos) => {
    const v = mount(DOC);
    placeCursor(v, pos);
    expect(lineText(v)).toBe(DOC);
  });

  it("collapses back once the cursor leaves the link", () => {
    const v = mount(DOC);
    placeCursor(v, linkFrom + 2);
    expect(lineText(v)).toBe(DOC);
    placeCursor(v, DOC.length);
    expect(lineText(v)).toBe("前 リンク 後");
  });
});

describe("markdown link click", () => {
  it("opens the url in a new tab when the visible text is clicked", () => {
    const v = mount("[リンク](https://example.com/)");
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const link = v.contentDOM.querySelector(".cm-md-link");
    if (!link) throw new Error("link is not drawn");
    const rect = link.getBoundingClientRect();
    link.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );
    expect(openSpy).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener,noreferrer");
    openSpy.mockRestore();
  });

  it("does not open a javascript: url even though the text is clickable", () => {
    const v = mount('[リンク](javascript:alert("x"))');
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const link = v.contentDOM.querySelector(".cm-md-link");
    if (!link) throw new Error("link is not drawn");
    const rect = link.getBoundingClientRect();
    link.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
