import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VisibilityFilterPanel } from "./VisibilityFilterPanel";
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

const corners = (element: Element) => {
  const style = getComputedStyle(element);
  return [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ];
};

describe("segmented の選択肢の角", () => {
  it("両端の選択肢は外側の角だけを枠と同じ丸みにし、focus の輪が枠の丸みで切れない", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<VisibilityFilterPanel tag="" active="" />));
    const frame = container.querySelector(".segmented");
    const options = [...container.querySelectorAll(".segmented-option")];
    expect(frame).not.toBeNull();
    expect(options).toHaveLength(3);
    const [pill] = corners(frame as Element);
    expect(pill).not.toBe("0px");
    expect(corners(options[0] as Element)).toEqual([pill, "0px", "0px", pill]);
    expect(corners(options[1] as Element)).toEqual(["0px", "0px", "0px", "0px"]);
    expect(corners(options[2] as Element)).toEqual(["0px", pill, pill, "0px"]);
  });
});
