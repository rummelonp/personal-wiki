import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearBodyFocusRequest } from "./body-focus";
import { NewPageDialog } from "./NewPageDialog";
import { type ApiResult, createPage, type Page } from "./pages-api";

vi.mock("./pages-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pages-api")>();
  return { ...actual, createPage: vi.fn(), findPageByTitle: vi.fn() };
});

const CREATED_ID = "NNNNNNNNNNNNNNNNNNNNNN";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const startUrl = location.href;
let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  clearBodyFocusRequest(CREATED_ID);
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  history.replaceState(null, "", startUrl);
});

describe("NewPageDialog", () => {
  it("作成すると modal を閉じた後に、キーボードを保つ input が focus を持つ", async () => {
    vi.mocked(createPage).mockResolvedValue({
      ok: true,
      value: { id: CREATED_ID, title: "ほげ" } as Page,
    } satisfies ApiResult<Page>);
    const dialogRef = createRef<HTMLDialogElement>();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const mounted = root;
    act(() => mounted.render(<NewPageDialog dialogRef={dialogRef} />));
    act(() => dialogRef.current?.showModal());
    const input = container.querySelector<HTMLInputElement>("input.text-input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "ほげ");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const submit = [...container.querySelectorAll("button")].find((b) => b.textContent === "作成");
    act(() => submit?.click());

    await vi.waitFor(() => expect(location.pathname).toBe(`/p/${CREATED_ID}`));
    expect(dialogRef.current?.open).toBe(false);
    const holder = document.querySelector("[data-body-focus-holder]");
    expect(holder).not.toBeNull();
    expect(document.activeElement).toBe(holder);
  });
});
