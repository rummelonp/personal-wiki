import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { createEditor } from "./create-editor";
import { colorOf, contrastRatio, MIN_CONTRAST, over, resolve, toRgb } from "./test-contrast";
import { resetScheme, setScheme } from "./test-tokens";
import { createTitleEditor } from "./title-editor";

const SCHEMES = ["light", "dark"] as const;

const CALLOUT_LINE = 5;
const DOC = ["一行目", "二行目", "三行目", "", "> [!success] 成功", "> 引用の本文"].join("\n");

/**
 * focus の変化を CodeMirror が view に反映するのは 10ms 後の transaction で、
 * 枠の class もカーソル行の地もそこで決まる。その transaction が届いた回数を数え、
 * focus を動かす操作のたびに 1 つ増えるのを待つ。class や地の出現を直接待つと、
 * 「まだ反映されていない」状態を「出ない」と読み違える。
 */
let focusChanges = 0;
const countFocusChange = (update: ViewUpdate) => {
  if (update.focusChanged) focusChanges += 1;
};

let views: EditorView[] = [];
let host: HTMLElement | null = null;

function container(): HTMLElement {
  if (!host) {
    host = document.createElement("div");
    document.body.append(host);
  }
  return host;
}

function mount(): EditorView {
  const view = createEditor(container(), { doc: DOC, onUpdate: countFocusChange });
  views.push(view);
  return view;
}

function mountTitle(): EditorView {
  const view = createTitleEditor(container(), { doc: "題", onUpdate: countFocusChange });
  views.push(view);
  return view;
}

afterEach(() => {
  for (const view of views) view.destroy();
  views = [];
  host?.remove();
  host = null;
  focusChanges = 0;
  resetScheme();
});

const waitForFocusChange = (after: number): Promise<void> =>
  vi.waitFor(() => expect(focusChanges).toBeGreaterThan(after));

async function clickInto(view: EditorView): Promise<void> {
  const before = focusChanges;
  await userEvent.click(view.contentDOM);
  await waitForFocusChange(before);
  expect(view.hasFocus).toBe(true);
}

/** keyboard で focus を入れる。Tab の移り先になるよう、view の直前に押せる要素を置く */
async function tabInto(view: EditorView): Promise<void> {
  const before = focusChanges;
  const previous = document.createElement("button");
  view.dom.before(previous);
  previous.focus();
  await userEvent.keyboard("{Tab}");
  await waitForFocusChange(before);
  expect(view.hasFocus).toBe(true);
}

/** view の外の押せる要素へ pointer で focus を移す */
async function clickOutside(view: EditorView): Promise<void> {
  const before = focusChanges;
  const outside = document.createElement("button");
  container().append(outside);
  await userEvent.click(outside);
  await waitForFocusChange(before);
  expect(view.hasFocus).toBe(false);
}

const outlineOf = (view: EditorView): CSSStyleDeclaration => getComputedStyle(view.dom);

/** カーソル行の地が敷かれた行の文字列。敷かれていなければ null */
function activeLineText(view: EditorView): string | null {
  const lines = view.contentDOM.querySelectorAll(".cm-active-line");
  expect(lines.length).toBeLessThanOrEqual(1);
  return lines[0]?.textContent ?? null;
}

describe("focus の枠", () => {
  it("pointer で入ったときは枠を出さない", async () => {
    const view = mount();
    await clickInto(view);
    expect(outlineOf(view).outlineStyle).toBe("none");
  });

  // 枠の有無は focus した時点の操作で決まる。update のたびに判定すると、pointer で入った後に
  // 打鍵しただけで枠が出る
  it("pointer で入った後に打鍵しても枠は出ない", async () => {
    const view = mount();
    await clickInto(view);
    await userEvent.keyboard("あ");
    expect(outlineOf(view).outlineStyle).toBe("none");
  });

  it("keyboard で入ったときは accent の枠を出す", async () => {
    const view = mount();
    await tabInto(view);
    const outline = outlineOf(view);
    expect(outline.outlineStyle).toBe("solid");
    expect(outline.outlineWidth).toBe("2px");
    expect(toRgb(outline.outlineColor)).toEqual(resolve(view.contentDOM, "var(--ui-color-accent)"));
  });

  it("keyboard で入った後に pointer で入り直すと枠は消える", async () => {
    const view = mount();
    await tabInto(view);
    expect(outlineOf(view).outlineStyle).toBe("solid");

    await clickOutside(view);
    await clickInto(view);
    expect(outlineOf(view).outlineStyle).toBe("none");
  });

  it("title 欄も本文と同じ枠になる", async () => {
    const title = mountTitle();
    await clickInto(title);
    expect(outlineOf(title).outlineStyle).toBe("none");

    await clickOutside(title);
    await tabInto(title);
    expect(outlineOf(title).outlineStyle).toBe("solid");
  });

  // Enter と ↓ は keyboard の操作だが、移り先は本文の caret で分かるので、本文の全体を枠で囲まない
  it.each(["{Enter}", "{ArrowDown}"])(
    "title から %s で本文へ移ったときは枠を出さない",
    async (key) => {
      const body = mount();
      const title = createTitleEditor(container(), {
        doc: "題",
        bodyView: () => body,
        onUpdate: countFocusChange,
      });
      views.push(title);
      await tabInto(title);
      expect(outlineOf(title).outlineStyle).toBe("solid");

      await userEvent.keyboard(key);
      // title の blur も数に入るので、回数ではなく本文の側の反映（枠と同じ transaction で付く class）を待つ
      await vi.waitFor(() => expect(body.dom.classList.contains("cm-focused")).toBe(true));
      expect(outlineOf(body).outlineStyle).toBe("none");
    },
  );
});

describe("カーソル行の地", () => {
  it("カーソルのある行に付き、カーソルと一緒に移る", async () => {
    const view = mount();
    await clickInto(view);

    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(activeLineText(view)).toBe("一行目");

    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).from) });
    expect(activeLineText(view)).toBe("二行目");
  });

  // 今の Editor は複数カーソルを許していない（`allowMultipleSelections` を入れていない）。
  // 許したときに main の行しか光らない作りになっていないことを、この test でだけ facet を足して確かめる
  it("カーソルが複数あるときはその行すべてに敷く", async () => {
    const view = createEditor(container(), {
      doc: DOC,
      onUpdate: countFocusChange,
      extensions: EditorState.allowMultipleSelections.of(true),
    });
    views.push(view);
    await clickInto(view);
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(view.state.doc.line(1).from),
        EditorSelection.cursor(view.state.doc.line(1).to),
        EditorSelection.cursor(view.state.doc.line(3).from),
      ]),
    });

    const lines = [...view.contentDOM.querySelectorAll(".cm-active-line")];
    expect(lines.map((line) => line.textContent)).toEqual(["一行目", "三行目"]);
  });

  it("focus の無い view には敷かない", async () => {
    const view = mount();
    await clickInto(view);
    expect(activeLineText(view)).not.toBeNull();

    const before = focusChanges;
    view.contentDOM.blur();
    await waitForFocusChange(before);
    expect(activeLineText(view)).toBeNull();
  });

  it("callout の行では callout の地が勝つ", async () => {
    const view = mount();
    await clickInto(view);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(CALLOUT_LINE).from) });

    const [withCursor, withoutCursor] = view.contentDOM.querySelectorAll(".cm-lp-callout");
    if (!withCursor || !withoutCursor) throw new Error("callout is not rendered");
    expect(withCursor.classList.contains("cm-active-line")).toBe(true);
    expect(getComputedStyle(withCursor).backgroundColor).toBe(
      getComputedStyle(withoutCursor).backgroundColor,
    );
  });

  it.each(SCHEMES)("%s: カーソル行の地の上でも本文が 4.5:1 以上", async (scheme) => {
    setScheme(scheme);
    const view = mount();
    await clickInto(view);
    view.dispatch({ selection: EditorSelection.cursor(0) });

    const line = view.contentDOM.querySelector(".cm-active-line");
    if (!line) throw new Error("active line is not rendered");
    // 地は半透明（選択範囲を透かすため）なので、エディタ面に重ねた色で測る
    const background = over(
      getComputedStyle(line).backgroundColor,
      resolve(view.contentDOM, "var(--ui-color-background)"),
    );
    expect(contrastRatio(colorOf(view.contentDOM), background)).toBeGreaterThanOrEqual(
      MIN_CONTRAST,
    );
  });
});
