import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BodyEditor } from "./BodyEditor";
import { PageSkeleton } from "./Loading";
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
  document.documentElement.style.removeProperty("font-size");
});

function mount(element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element));
  return container;
}

const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

/** 同じ親の隣り合う要素の上端の間隔。箱の高さと上下の余白の和なので、行の刻みになる。レイアウトは 1/64px に丸めるので、比べる側は小数 1 桁の誤差を許す */
function steps(elements: Element[]): number[] {
  const tops = elements.map((element) => element.getBoundingClientRect().top);
  return tops.slice(1).map((top, i) => top - (tops[i] ?? 0));
}

async function measure() {
  const skeleton = mount(<PageSkeleton />);
  const editor = mount(<BodyEditor value={"一行目\n二行目\n三行目\n四行目"} readOnly={false} />);
  await frame();
  const bars = [...skeleton.querySelectorAll(".skeleton-body .skeleton-text")];
  const lines = [...editor.querySelectorAll(".cm-content > .cm-line")];
  expect(bars.length).toBeGreaterThanOrEqual(2);
  expect(lines.length).toBe(4);
  return { bars: steps(bars), lines: steps(lines) };
}

describe("スケルトンの本文の1行の刻み", () => {
  it("エディタの本文の行の刻みと同じ", async () => {
    const { bars, lines } = await measure();
    for (const step of lines) expect(step).toBeGreaterThan(0);
    for (const step of bars) expect(step).toBeCloseTo(lines[0] ?? 0, 1);
  });

  it("ルートの font-size を変えても、エディタと同じ刻みのまま", async () => {
    document.documentElement.style.fontSize = "20px";
    const { bars, lines } = await measure();
    for (const step of bars) expect(step).toBeCloseTo(lines[0] ?? 0, 1);
    // 本文は固定 px なので、ルートにつられて 20px * 1.8 にならない
    expect(lines[0]).toBeCloseTo(28.8, 1);
  });
});
