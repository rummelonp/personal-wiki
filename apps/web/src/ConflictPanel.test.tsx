import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConflictPanel } from "./ConflictPanel";
import type { Page } from "./pages-api";

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

const SERVER: Page = {
  id: "p1",
  title: "題",
  body: "サーバーの本文",
  visibility: "draft",
  version: 2,
  createdAt: 0,
  updatedAt: 0,
};

function mount() {
  const onOverwrite = vi.fn();
  const onTakeServer = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (busy: boolean) =>
    act(() =>
      root?.render(
        <ConflictPanel
          server={SERVER}
          local={{ title: "題", body: "手元の本文" }}
          busy={busy}
          onOverwrite={onOverwrite}
          onTakeServer={onTakeServer}
        />,
      ),
    );
  render(false);
  return { render, onOverwrite, onTakeServer };
}

const button = (label: string) => {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`${label} のボタンが無い`);
  return found;
};

describe("衝突の操作の確認", () => {
  it("確認の問いを、実行とやめるの両方のボタンの説明に結ぶ", () => {
    mount();
    act(() => button("手元で上書き").click());
    const question = document.querySelector(".notice-question");
    expect(question?.id).toBeTruthy();
    expect(button("上書きする").getAttribute("aria-describedby")).toBe(question?.id);
    expect(button("やめる").getAttribute("aria-describedby")).toBe(question?.id);
  });

  it.each(["サーバーの版を取り込む", "手元で上書き"])(
    "%s の確認をやめると、押したボタンに focus が戻る",
    (choice) => {
      mount();
      act(() => button(choice).click());
      expect(document.activeElement).toBe(button("やめる"));
      act(() => button("やめる").click());
      expect(document.activeElement).toBe(button(choice));
    },
  );

  it("戻る先のボタンが押せないときは、通知の見出しに focus を戻す", () => {
    const { render } = mount();
    act(() => button("手元で上書き").click());
    render(true);
    act(() => button("やめる").click());
    expect(button("手元で上書き").disabled).toBe(true);
    expect(document.activeElement).toBe(document.querySelector(".notice-title"));
  });

  it("実行は、選んだ側の処理だけを呼ぶ", () => {
    const { onOverwrite, onTakeServer } = mount();
    act(() => button("手元で上書き").click());
    act(() => button("上書きする").click());
    expect(onOverwrite).toHaveBeenCalledTimes(1);
    expect(onTakeServer).not.toHaveBeenCalled();
  });
});
