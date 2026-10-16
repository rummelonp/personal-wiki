import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PublishBar } from "./PublishBar";

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

function render(visibility: "draft" | "public") {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <PublishBar
        visibility={visibility}
        uncreated={false}
        disabled={false}
        externalBases={0}
        titlePending={false}
        sharePath="/設計メモ"
        pending={null}
        onChange={async () => {}}
      />,
    ),
  );
}

function button(name: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (el) => el.textContent === name,
  );
  if (found === undefined) throw new Error(`ボタンが無い: ${name}`);
  return found;
}

describe("公開の確認", () => {
  it("取り消せない範囲まで伝え、確定とやめるの両方にその文を結び付ける", () => {
    render("draft");
    act(() => button("公開").click());
    const text = container?.querySelector(".publish-confirm p");
    expect(text?.textContent).toBe(
      "誰でもこのページを読めるようになり、最近の更新、検索、タグの一覧にも載ります。下書きに戻しても、すでに読まれた内容は取り消せません。",
    );
    expect(text?.id).not.toBe("");
    expect(button("公開する").getAttribute("aria-describedby")).toBe(text?.id);
    expect(button("やめる").getAttribute("aria-describedby")).toBe(text?.id);
  });
});
