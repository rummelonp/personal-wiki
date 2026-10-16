import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SignInNotice } from "./SignInNotice";

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

function render(expired: boolean) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<SignInNotice expired={expired} />));
  const el = container;
  return {
    heading: el.querySelector("h1")?.textContent,
    text: el.querySelector(".empty-text")?.textContent,
    button: el.querySelector("a.button")?.textContent,
  };
}

describe("ログインの案内", () => {
  it("期限が切れたときは、ログインし直すことと、再読み込みで公開ページを読めることを伝える", () => {
    expect(render(true)).toEqual({
      heading: "ログインの期限が切れました",
      text: "ログインせずに公開ページを読むには、再読み込みしてください。",
      button: "ログインし直す",
    });
  });

  it("ログインしていないときは、見出しで目的を言い、補足を出さない", () => {
    expect(render(false)).toEqual({
      heading: "ページを作るにはログインが必要です",
      text: undefined,
      button: "ログイン",
    });
  });
});
