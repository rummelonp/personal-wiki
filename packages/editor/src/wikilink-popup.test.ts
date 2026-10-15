import { currentCompletions } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "./create-editor";
import { createMemoryPageIndex } from "./page-index";

let view: EditorView | null = null;
let host: HTMLElement | null = null;
let restoreViewport: (() => void) | null = null;

afterEach(() => {
  restoreViewport?.();
  restoreViewport = null;
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

/** 本文を画面の上寄りに固定し、caret の上下の余地を test が決められるようにする */
function mount(): EditorView {
  host = document.createElement("div");
  host.style.cssText = "position: fixed; top: 150px; left: 0; width: 320px";
  document.body.append(host);
  view = createEditor(host, {
    doc: "",
    pageIndex: createMemoryPageIndex(
      ["Code", "Codex", "Coda"].map((title) => ({ id: title, title })),
      { normalize: (text) => text.toLowerCase() },
    ),
  });
  return view;
}

type FakeViewport = EventTarget & {
  offsetTop: number;
  offsetLeft: number;
  height: number;
  width: number;
};

/** ソフトキーボードで縮んだ visual viewport を模す。返した値を書き換えて event を送ると、その後の変化を模せる */
function shrinkVisualViewport(height: number, offsetTop = 0): FakeViewport {
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const viewport: FakeViewport = Object.assign(new EventTarget(), {
    offsetTop,
    offsetLeft: 0,
    height,
    width: window.innerWidth,
  });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  restoreViewport = () => {
    if (original) Object.defineProperty(window, "visualViewport", original);
    else Reflect.deleteProperty(window, "visualViewport");
  };
  return viewport;
}

async function openCompletion(v: EditorView): Promise<HTMLElement> {
  v.dispatch({
    changes: { from: 0, insert: "[[Co" },
    selection: { anchor: 4 },
    userEvent: "input.type",
  });
  await vi.waitFor(() => expect(currentCompletions(v.state).length).toBe(3));
  const tooltip = document.querySelector(".cm-tooltip-autocomplete");
  if (!(tooltip instanceof HTMLElement)) throw new Error("the completion tooltip is not rendered");
  return tooltip;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

// 窓の測り直しは描画の前（requestMeasure）と、ResizeObserver 経由の 50ms の遅延で起きる。
// その遅延より長い間、位置が動かなければ測り直しは残っていないとみなす
const STABLE_FRAMES = 12;
const MAX_FRAMES = 300;

/**
 * 窓を開いた直後の更新（候補の選択など）が終わるのを待つ。それらの更新でも tooltip は測り直されるので、
 * 待たずに visual viewport を変えると、その event を拾わなくても窓が動いて test が素通りする。
 * 窓の位置と上下の向きが `STABLE_FRAMES` 回続けて変わらなくなったら終わりとする。
 */
async function settle(tooltip: HTMLElement): Promise<void> {
  const snapshot = () => {
    const rect = tooltip.getBoundingClientRect();
    return [tooltip.className, rect.top, rect.left, rect.width, rect.height].join("|");
  };
  let last = snapshot();
  let stable = 0;
  for (let frame = 0; frame < MAX_FRAMES; frame++) {
    await nextFrame();
    const current = snapshot();
    stable = current === last ? stable + 1 : 0;
    last = current;
    if (stable >= STABLE_FRAMES) return;
  }
  throw new Error("the completion tooltip keeps moving");
}

/**
 * visual viewport の値だけを変えて event を送らずに待ち、窓が下に残ることを確かめる。
 * 遅い環境などで開いた直後の測り直しが settle の後まで残ると、event を送る前に窓が動く。
 * そのときは test を素通りさせず、ここで落とす。
 */
async function expectStaysBelowWithoutEvent(tooltip: HTMLElement): Promise<void> {
  await settle(tooltip);
  expect(tooltip.classList.contains("cm-tooltip-below")).toBe(true);
}

describe("the completion popup position", () => {
  it("opens below the caret when there is room", async () => {
    const v = mount();
    const tooltip = await openCompletion(v);
    const caret = v.coordsAtPos(4);
    if (!caret) throw new Error("the caret has no coordinates");
    await vi.waitFor(() => expect(tooltip.classList.contains("cm-tooltip-below")).toBe(true));
    expect(tooltip.getBoundingClientRect().top).toBeGreaterThanOrEqual(caret.bottom);
  });

  it("opens above the caret when the soft keyboard leaves too little room below", async () => {
    const v = mount();
    // caret（top 150px 付近）の下が 30px ほどしか残らない高さ
    shrinkVisualViewport(210);
    const tooltip = await openCompletion(v);
    const caret = v.coordsAtPos(4);
    if (!caret) throw new Error("the caret has no coordinates");
    await vi.waitFor(() => expect(tooltip.classList.contains("cm-tooltip-above")).toBe(true));
    expect(tooltip.getBoundingClientRect().bottom).toBeLessThanOrEqual(caret.top);
  });

  it("measures the room from the visual viewport's offset, not the layout viewport", async () => {
    const v = mount();
    // layout viewport の 100px から 210px までが見えている（キーボードを避けて画面が上へずれた状態）。
    // offsetTop を足さないと範囲が 0 から 110px になり、caret（180px 付近）が範囲の外に出て窓が隠れる
    shrinkVisualViewport(110, 100);
    const tooltip = await openCompletion(v);
    await vi.waitFor(() => expect(tooltip.classList.contains("cm-tooltip-above")).toBe(true));
    expect(tooltip.getBoundingClientRect().top).toBeGreaterThanOrEqual(100);
  });

  it("moves above the caret when the visual viewport shrinks after the popup opened", async () => {
    const viewport = shrinkVisualViewport(window.innerHeight);
    const v = mount();
    const tooltip = await openCompletion(v);
    await vi.waitFor(() => expect(tooltip.classList.contains("cm-tooltip-below")).toBe(true));
    await settle(tooltip);
    // 窓を開いた後にキーボードが出て、caret の下が 30px ほどしか残らなくなる
    viewport.height = 210;
    await expectStaysBelowWithoutEvent(tooltip);
    viewport.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(tooltip.classList.contains("cm-tooltip-above")).toBe(true));
  });

  it("moves into view when the visual viewport scrolls after the popup opened", async () => {
    const viewport = shrinkVisualViewport(window.innerHeight);
    const v = mount();
    const tooltip = await openCompletion(v);
    await vi.waitFor(() => expect(tooltip.classList.contains("cm-tooltip-below")).toBe(true));
    await settle(tooltip);
    // 画面が上へずれ、layout viewport の 100px から 210px までが見える。高さを変えずに offsetTop だけを
    // 増やすと caret の下の余地が増え、上へ移る形を作れないので、キーボードが出た分の高さも縮める
    viewport.height = 110;
    viewport.offsetTop = 100;
    await expectStaysBelowWithoutEvent(tooltip);
    viewport.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(tooltip.classList.contains("cm-tooltip-above")).toBe(true));
    expect(tooltip.getBoundingClientRect().top).toBeGreaterThanOrEqual(100);
  });

  it("stops following the visual viewport when the editor is destroyed", () => {
    const viewport = shrinkVisualViewport(window.innerHeight);
    const add = vi.spyOn(viewport, "addEventListener");
    const remove = vi.spyOn(viewport, "removeEventListener");
    const v = mount();
    const added = add.mock.calls.map(([type, listener]) => [type, listener]);
    expect(added.map(([type]) => type)).toEqual(expect.arrayContaining(["resize", "scroll"]));
    v.destroy();
    view = null;
    const removed = remove.mock.calls.map(([type, listener]) => [type, listener]);
    for (const pair of added) expect(removed).toContainEqual(pair);
  });
});

/** `@media (pointer: coarse)` の中の規則を media 抜きで取り出す */
function coarseRules(): string {
  const sheets = [...document.styleSheets, ...document.adoptedStyleSheets];
  const rules: string[] = [];
  for (const sheet of sheets) {
    for (const rule of sheet.cssRules) {
      if (rule instanceof CSSMediaRule && rule.conditionText.includes("pointer: coarse")) {
        for (const inner of rule.cssRules) rules.push(inner.cssText);
      }
    }
  }
  return rules.join("\n");
}

describe("the completion popup rows", () => {
  it("are at least 44px tall for a coarse pointer", async () => {
    const v = mount();
    const tooltip = await openCompletion(v);
    const rows = [...tooltip.querySelectorAll("li")];
    expect(rows.length).toBe(3);
    // pointer が coarse でない環境では、行は 44px 未満に詰めたまま
    const compact = rows[0]?.getBoundingClientRect().height ?? 0;
    if (!matchMedia("(pointer: coarse)").matches) expect(compact).toBeLessThan(44);

    const css = coarseRules();
    expect(css, "no rule under @media (pointer: coarse)").toContain("cm-tooltip-autocomplete");
    // 実機の media の判定は差し替えられないので、media 抜きで同じ規則を当てて実際の高さを測る
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    try {
      for (const row of rows) {
        expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }
      const list = tooltip.querySelector("ul");
      expect(list?.getBoundingClientRect().height).toBeGreaterThanOrEqual(44 * 3);
    } finally {
      style.remove();
    }
  });
});
