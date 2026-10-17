/// <reference types="@vitest/browser-playwright" />
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page as browserPage, cdp } from "vitest/browser";
import { NO_FEATURES } from "./api";
import { Header } from "./Header";
import "./theme.css";
import "./styles.css";

// 既定の名前でない、利用者が付けた名前で描く
vi.mock("./site-name", () => ({ SITE_NAME: "My Notes" }));

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

describe("付けたサイト名", () => {
  it("短い表示を持たず、狭い幅でも名前をそのまま出す", async () => {
    await browserPage.viewport(375, 800);
    const { find, visible } = mountOwnerHeader();
    expect(container?.querySelector(".brand-text-short")).toBeNull();
    expect(find(".brand").hasAttribute("aria-label")).toBe(false);
    expect(visible().map((el) => el.textContent)).toEqual(["My Notes"]);
  });
});
