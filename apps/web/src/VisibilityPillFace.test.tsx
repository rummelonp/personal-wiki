/// <reference types="@vitest/browser-playwright" />
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cdp } from "vitest/browser";
import { VisibilityPillFace } from "./VisibilityPillFace";
import "./theme.css";
import "./styles.css";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderMark(visibility: "draft" | "public", spinning: boolean): CSSStyleDeclaration {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <button type="button" className="visibility-pill" data-visibility={visibility}>
        <VisibilityPillFace shown={visibility} spinning={spinning} />
      </button>,
    ),
  );
  const mark = container.querySelector(".visibility-mark");
  if (!(mark instanceof HTMLElement)) throw new Error("印の丸が無い");
  return getComputedStyle(mark);
}

const TRANSPARENT = "rgba(0, 0, 0, 0)";

describe("印の丸", () => {
  it("公開は塗りの丸にする", () => {
    expect(renderMark("public", false).backgroundColor).not.toBe(TRANSPARENT);
  });

  it.each(["draft", "public"] as const)(
    "%s へ向かって待つ間は、塗らずに右の欠けた輪にする",
    (visibility) => {
      const style = renderMark(visibility, true);
      expect(style.backgroundColor).toBe(TRANSPARENT);
      expect(style.borderRightColor).toBe(TRANSPARENT);
      expect(style.borderTopColor).not.toBe(TRANSPARENT);
    },
  );
});

describe("動きを減らす設定", () => {
  it("待つ間の輪を回さない", async () => {
    await cdp().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    const style = renderMark("public", true);
    expect(style.animationName).toBe("none");
    expect(style.borderRightColor).toBe(TRANSPARENT);
  });
});
