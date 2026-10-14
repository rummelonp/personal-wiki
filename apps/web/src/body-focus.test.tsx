import { afterEach, describe, expect, it } from "vitest";
import { clearBodyFocusRequest, requestBodyFocus, wantsBodyFocus } from "./body-focus";

const holders = () => document.querySelectorAll<HTMLInputElement>("[data-body-focus-holder]");

afterEach(() => {
  clearBodyFocusRequest("A");
  clearBodyFocusRequest("B");
  document.body.replaceChildren();
});

describe("requestBodyFocus", () => {
  it("印を付け、不可視の input に focus して本文の focus までつなぐ", () => {
    requestBodyFocus("A");

    expect(wantsBodyFocus("A")).toBe(true);
    expect(holders()).toHaveLength(1);
    const holder = holders()[0] as HTMLInputElement;
    expect(document.activeElement).toBe(holder);
    expect(holder.tabIndex).toBe(-1);
    expect(holder.style.fontSize).toBe("16px");
    expect(holder.getAttribute("aria-label")).toBe("本文を準備中");
    expect(holder.hasAttribute("aria-hidden")).toBe(false);
    expect(holder.autocomplete).toBe("off");
  });

  it("続けて呼んでも input は 1 つだけ残る", () => {
    requestBodyFocus("A");
    requestBodyFocus("B");

    expect(holders()).toHaveLength(1);
    expect(wantsBodyFocus("A")).toBe(false);
    expect(wantsBodyFocus("B")).toBe(true);
  });
});

describe("clearBodyFocusRequest", () => {
  it("印を消すと input も外す", () => {
    requestBodyFocus("A");
    clearBodyFocusRequest("A");

    expect(wantsBodyFocus("A")).toBe(false);
    expect(holders()).toHaveLength(0);
  });

  it("別のページの印では、input を外さない", () => {
    requestBodyFocus("A");
    clearBodyFocusRequest("B");

    expect(wantsBodyFocus("A")).toBe(true);
    expect(holders()).toHaveLength(1);
  });
});

describe("本文などが focus を取ったとき", () => {
  it("input は外れるが、印は本文が読むまで残る", () => {
    const body = document.createElement("div");
    body.contentEditable = "true";
    document.body.append(body);
    requestBodyFocus("A");

    body.focus();

    expect(document.activeElement).toBe(body);
    expect(holders()).toHaveLength(0);
    expect(wantsBodyFocus("A")).toBe(true);
  });
});
