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

/** ソフトキーボードで縮んだ visual viewport を模す */
function shrinkVisualViewport(height: number, offsetTop = 0): void {
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: { offsetTop, offsetLeft: 0, height, width: window.innerWidth },
  });
  restoreViewport = () => {
    if (original) Object.defineProperty(window, "visualViewport", original);
    else Reflect.deleteProperty(window, "visualViewport");
  };
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
    // 密度は今のまま（デスクトップでは詰めたまま）
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
