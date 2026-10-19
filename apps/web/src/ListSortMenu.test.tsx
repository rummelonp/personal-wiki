import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { ListSortMenu } from "./ListSortMenu";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(onChange = vi.fn()) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<ListSortMenu sort="updated" onChange={onChange} />));
  return onChange;
}

const button = () => {
  const found = container?.querySelector<HTMLButtonElement>(".list-sort-button");
  if (found == null) throw new Error("ボタンが無い");
  return found;
};
const menu = () => container?.querySelector<HTMLElement>("[role='menu']") ?? null;

describe("ListSortMenu の Tab", () => {
  it("Tab で閉じる前にボタンへ焦点を戻し、移動の既定の動作は止めない", () => {
    render();
    act(() => button().click());
    expect(document.activeElement?.getAttribute("role")).toBe("menuitemradio");
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => {
      document.activeElement?.dispatchEvent(event);
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(button());
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("ListSortMenu の外側を押して閉じる", () => {
  it("焦点を持たない外側を押すと、焦点をボタンに戻し、並びは変えない", async () => {
    const outside = document.createElement("div");
    outside.style.height = "40px";
    document.body.append(outside);
    try {
      const onChange = render();
      act(() => button().click());
      expect(document.activeElement?.getAttribute("role")).toBe("menuitemradio");
      const focus = vi.spyOn(button(), "focus");
      await userEvent.click(outside);
      expect(menu()).toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(button()));
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      outside.remove();
    }
  });

  it("入力欄を押して閉じたときは、焦点を入力欄に残す", async () => {
    const input = document.createElement("input");
    document.body.append(input);
    try {
      render();
      act(() => button().click());
      await userEvent.click(input);
      expect(menu()).toBeNull();
      // ボタンへ戻す判定は setTimeout(0) の後に走るので、それより後に見る
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(document.activeElement).toBe(input);
    } finally {
      input.remove();
    }
  });

  it("戻す前にアンマウントされても、後からボタンに焦点を移さない", async () => {
    const outside = document.createElement("div");
    document.body.append(outside);
    try {
      render();
      act(() => button().click());
      const focus = vi.spyOn(button(), "focus");
      act(() => {
        outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        root?.unmount();
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(focus).not.toHaveBeenCalled();
    } finally {
      outside.remove();
    }
  });
});
