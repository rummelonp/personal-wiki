import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlineItem } from "./heading-outline";
import { InlineOutline, Outline } from "./Outline";

const item = (offset: number): OutlineItem => ({ level: 2, text: `見出し ${offset}`, offset });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("InlineOutline", () => {
  it("見出しが 3 つに満たないと出さない", () => {
    act(() => root.render(<InlineOutline items={[item(0), item(10)]} onJump={vi.fn()} />));
    expect(container.querySelector("details.toc")).toBeNull();
  });

  it("見出しを選ぶと、畳んでからその位置へ移る", () => {
    const onJump = vi.fn();
    act(() => root.render(<InlineOutline items={[item(0), item(10), item(20)]} onJump={onJump} />));
    const details = container.querySelector("details.toc") as HTMLDetailsElement;
    details.open = true;
    const target = [...details.querySelectorAll("button")].find(
      (b) => b.textContent === "見出し 10",
    );
    act(() => target?.click());
    expect(details.open).toBe(false);
    expect(onJump).toHaveBeenCalledExactlyOnceWith(10);
  });
});

describe("Outline（右の列）", () => {
  it("見出しが 1 つでも出し、無ければ出さない", () => {
    act(() => root.render(<Outline items={[item(0)]} onJump={vi.fn()} />));
    expect(container.querySelector(".rail-section-outline")).not.toBeNull();
    act(() => root.render(<Outline items={[]} onJump={vi.fn()} />));
    expect(container.querySelector(".rail-section-outline")).toBeNull();
  });
});
