import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page as browserPage } from "vitest/browser";
import { BodyEditor } from "./BodyEditor";
import { TitleEditor } from "./TitleEditor";
import "./theme.css";
import "./styles.css";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let roots: Root[] = [];
let containers: HTMLElement[] = [];

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  for (const container of containers) container.remove();
  roots = [];
  containers = [];
});

const noop = () => {};
const TITLE = "題名";
const BODY = "本文の一行目";

/** PageReader と PageEditor の、title と本文の並びだけを作る */
function mountNote(kind: "reader" | "editor"): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <article className="note">
        {kind === "reader" ? (
          <h1 className="note-title">{TITLE}</h1>
        ) : (
          <TitleEditor
            value={TITLE}
            onChange={noop}
            onCommit={noop}
            onBlur={noop}
            readOnly={false}
            bodyView={() => null}
          />
        )}
        <BodyEditor value={BODY} readOnly={kind === "reader"} />
      </article>,
    ),
  );
  const article = container.querySelector<HTMLElement>("article.note");
  if (!article) throw new Error("article が無い");
  return article;
}

/** 最初の文字の矩形。書体の差に左右されないよう、文字の始まりの位置だけを比べる */
function firstCharRect(element: Element): DOMRect {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const text = walker.nextNode();
  if (!text) throw new Error("文字が無い");
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 1);
  return range.getBoundingClientRect();
}

function titleElement(article: HTMLElement): HTMLElement {
  const found = article.querySelector<HTMLElement>(".note-title, .title-input");
  if (!found) throw new Error("title が無い");
  return found;
}

function bodyLine(article: HTMLElement): HTMLElement {
  const found = article.querySelector<HTMLElement>(".body-editor .cm-line");
  if (!found) throw new Error("本文の行が無い");
  return found;
}

function measure(article: HTMLElement) {
  const origin = article.getBoundingClientRect();
  const title = firstCharRect(titleElement(article));
  const body = firstCharRect(bodyLine(article));
  return {
    titleLeft: title.left - origin.left,
    titleTop: title.top - origin.top,
    bodyLeft: body.left - origin.left,
    bodyTop: body.top - origin.top,
  };
}

describe.each([
  ["広い画面", 1024],
  ["狭い画面", 375],
])("読み取りの画面の title と本文の位置（%s）", (_, width) => {
  it("編集の画面の title 欄と本文に重なる", async () => {
    await browserPage.viewport(width, 800);
    const reader = measure(mountNote("reader"));
    const editor = measure(mountNote("editor"));
    for (const key of Object.keys(reader) as (keyof typeof reader)[]) {
      expect(Math.abs(reader[key] - editor[key]), key).toBeLessThan(1);
    }
  });
});

describe("title 欄のカーソル", () => {
  it("縦の padding が無くても、カーソルを行の高さの中に描く", async () => {
    await browserPage.viewport(1024, 800);
    const article = mountNote("editor");
    const content = article.querySelector<HTMLElement>(".title-input .cm-content");
    const view = content ? EditorView.findFromDOM(content) : null;
    if (!view) throw new Error("title の view が無い");
    view.focus();
    view.dispatch({ selection: { anchor: 1 } });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const cursor = article.querySelector(".title-input .cm-cursor")?.getBoundingClientRect();
    const line = article.querySelector(".title-input .cm-line")?.getBoundingClientRect();
    if (!cursor || !line) throw new Error("カーソルか行が無い");
    expect(cursor.height).toBeGreaterThan(0);
    expect(cursor.top).toBeGreaterThanOrEqual(line.top - 1);
    expect(cursor.bottom).toBeLessThanOrEqual(line.bottom + 1);
    const char = firstCharRect(view.contentDOM);
    expect(Math.abs(cursor.left - char.right)).toBeLessThan(2);
  });

  it("縦の padding が無くても、選択の地を行の高さの中に、文字に重ねて描く", async () => {
    await browserPage.viewport(1024, 800);
    const article = mountNote("editor");
    const content = article.querySelector<HTMLElement>(".title-input .cm-content");
    const view = content ? EditorView.findFromDOM(content) : null;
    if (!view) throw new Error("title の view が無い");
    view.focus();
    view.dispatch({ selection: { anchor: 0, head: TITLE.length } });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const selection = article
      .querySelector(".title-input .cm-selectionBackground")
      ?.getBoundingClientRect();
    const line = article.querySelector(".title-input .cm-line")?.getBoundingClientRect();
    if (!selection || !line) throw new Error("選択か行が無い");
    expect(selection.height).toBeGreaterThan(0);
    expect(selection.top).toBeGreaterThanOrEqual(line.top - 1);
    expect(selection.bottom).toBeLessThanOrEqual(line.bottom + 1);
    expect(Math.abs(selection.left - firstCharRect(view.contentDOM).left)).toBeLessThan(2);
  });
});
