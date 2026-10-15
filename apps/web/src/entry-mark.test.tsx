import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EntryRow } from "./EntryRow";
import "./theme.css";
import "./styles.css";

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount() {
  container = document.createElement("ul");
  document.body.append(container);
  root = createRoot(container);
  const entry = {
    id: "p1",
    title: "かさな",
    visibility: "public" as const,
    updatedAt: 0,
    excerpt: "かあ さかさあ",
    tags: [],
  };
  await act(async () => root?.render(<EntryRow entry={entry} now={0} highlight="かさ" />));
}

const element = (selector: string) => {
  const found = container?.querySelector(selector);
  if (!found) throw new Error(`${selector} が無い`);
  return found;
};

const markStyle = (selector: string) => {
  const s = getComputedStyle(element(`${selector} mark`));
  return {
    color: s.color,
    background: s.backgroundColor,
    radius: s.borderRadius,
    decoration: s.textDecorationLine,
  };
};

describe("一覧の行の一致箇所", () => {
  it("title と抜粋で、同じ規則（地、文字色、角丸）の強調が付く", async () => {
    await mount();
    const title = markStyle(".entry-title");
    expect(title).toEqual(markStyle(".entry-excerpt"));
    expect(title.background).not.toBe("rgba(0, 0, 0, 0)");
  });

  // 太さで示すと、最初から太い title だけ強調が弱く見える
  it("太さは周りの文字のままで、地だけで示す", async () => {
    await mount();
    for (const selector of [".entry-title", ".entry-excerpt"]) {
      expect(getComputedStyle(element(`${selector} mark`)).fontWeight).toBe(
        getComputedStyle(element(selector)).fontWeight,
      );
    }
  });

  it("抜粋の一致箇所の文字は、周りの補助色でなく本文色になる", async () => {
    await mount();
    expect(getComputedStyle(element(".entry-excerpt mark")).color).not.toBe(
      getComputedStyle(element(".entry-excerpt")).color,
    );
  });
});
