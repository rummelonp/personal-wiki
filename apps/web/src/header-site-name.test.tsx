/// <reference types="@vitest/browser-playwright" />
import { DEFAULT_SITE_NAME } from "@personal-wiki/domain";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page as browserPage, cdp } from "vitest/browser";
import { NO_FEATURES } from "./api";
import { Header } from "./Header";
import "./theme.css";
import "./styles.css";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mountOwnerHeader() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <Header
        session={{
          status: "ready",
          me: { kind: "owner", features: { ...NO_FEATURES, oauth: true } },
        }}
        loggingOut={false}
        onLogout={() => {}}
        query=""
        onOpenSearch={() => {}}
      />,
    ),
  );
  const find = (selector: string) => {
    const found = container?.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`${selector} が無い`);
    return found;
  };
  /** 画面に見えている、ロゴの文字の要素 */
  const visible = () =>
    [...(container?.querySelectorAll<HTMLElement>(".brand-text") ?? [])].filter(
      (el) => getComputedStyle(el).display !== "none",
    );
  return { find, visible };
}

// 利用者が名前を付けた場合は header-site-name-custom.test.tsx
describe("既定のサイト名", () => {
  it.each([
    [1280, [DEFAULT_SITE_NAME]],
    [375, ["wiki"]],
    [320, ["wiki"]],
  ])("幅 %dpx で見える文字は %j で、リンクの名前は正式な名前のまま", async (width, shown) => {
    await browserPage.viewport(width, 800);
    const { find, visible } = mountOwnerHeader();
    expect(visible().map((el) => el.textContent)).toEqual(shown);
    expect(find(".brand").getAttribute("aria-label")).toBe(DEFAULT_SITE_NAME);
    for (const el of visible()) expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
  });

  it("タッチ端末の幅 375px でも、見える文字は省略されず、接続のリンクは 44px で残る", async () => {
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await browserPage.viewport(375, 800);
    const { find, visible } = mountOwnerHeader();
    expect(visible().map((el) => el.textContent)).toEqual(["wiki"]);
    for (const el of visible()) expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
    const grants = find(".header-grants").getBoundingClientRect();
    expect(grants.width).toBeGreaterThanOrEqual(44 - 0.1);
    expect(grants.height).toBeGreaterThanOrEqual(44 - 0.1);
  });
});
