import { describe, expect, it } from "vitest";
import { decideRetryFocus, type RetryFocusInput, retryButtonState } from "./retry-focus";

const base: RetryFocusInput = {
  anchorPresent: false,
  onAnchor: false,
  lost: true,
  parked: false,
  restore: true,
  afterFailure: true,
  button: "absent",
  busy: true,
  titleTaken: false,
};

describe("decideRetryFocus", () => {
  it("押せるようになった再送のボタンへ focus を戻す", () => {
    expect(
      decideRetryFocus({
        ...base,
        anchorPresent: true,
        onAnchor: true,
        lost: false,
        parked: true,
        button: "enabled",
      }),
    ).toEqual({ restore: false, parked: true, action: "retry" });
  });

  it("ボタンが消えて focus が落ちたら、置き場へ預けて戻す予定を残す", () => {
    expect(decideRetryFocus({ ...base, anchorPresent: true })).toEqual({
      restore: true,
      parked: true,
      action: "anchor",
    });
  });

  it("ボタンが disabled の間に置き場にいるなら、そのまま待つ", () => {
    expect(
      decideRetryFocus({
        ...base,
        anchorPresent: true,
        onAnchor: true,
        lost: false,
        parked: true,
        button: "disabled",
      }),
    ).toEqual({ restore: true, parked: true, action: null });
  });

  it("失敗の後の操作が終わったら、戻す予定を捨てる", () => {
    expect(decideRetryFocus({ ...base, afterFailure: false, anchorPresent: true })).toEqual({
      restore: false,
      parked: false,
      action: null,
    });
  });

  it("focus が別の要素へ移っていたら、戻す予定を捨てる", () => {
    expect(
      decideRetryFocus({ ...base, anchorPresent: true, lost: false, button: "enabled" }),
    ).toEqual({
      restore: false,
      parked: false,
      action: null,
    });
  });

  it("操作が終わってもボタンが無ければ、戻す予定を捨てる", () => {
    expect(decideRetryFocus({ ...base, busy: false })).toEqual({
      restore: false,
      parked: false,
      action: null,
    });
  });

  it("預けた後に再送が成功して通知が消えたら、戻す予定を捨てて body の欄へ移す", () => {
    expect(decideRetryFocus({ ...base, afterFailure: false, parked: true })).toEqual({
      restore: false,
      parked: false,
      action: "body",
    });
  });

  it("預けた後の再送が title の重複で終わったら、戻す予定を捨てて title の欄へ移す", () => {
    expect(
      decideRetryFocus({ ...base, afterFailure: false, parked: true, titleTaken: true }),
    ).toEqual({
      restore: false,
      parked: false,
      action: "title",
    });
  });

  it("預けた置き場がボタンに戻らずに消えたら、body の欄へ移す", () => {
    expect(decideRetryFocus({ ...base, restore: false, parked: true })).toEqual({
      restore: false,
      parked: false,
      action: "body",
    });
  });

  it("title の重複で終わったら、title の欄へ移す", () => {
    expect(
      decideRetryFocus({ ...base, restore: false, parked: true, titleTaken: true }),
    ).toMatchObject({
      action: "title",
    });
  });

  it("戻す予定が残っている間は、置き場が消えても移さない", () => {
    expect(decideRetryFocus({ ...base, parked: true, busy: true })).toEqual({
      restore: true,
      parked: false,
      action: null,
    });
  });

  it("置き場が残っていれば、預けた状態を保つ", () => {
    expect(
      decideRetryFocus({ ...base, restore: false, anchorPresent: true, parked: true }),
    ).toEqual({
      restore: false,
      parked: true,
      action: null,
    });
  });
});

describe("retryButtonState", () => {
  it("ボタンが無ければ absent、disabled なら disabled、それ以外は enabled にする", () => {
    expect(retryButtonState(null)).toBe("absent");
    expect(retryButtonState({ disabled: true } as HTMLButtonElement)).toBe("disabled");
    expect(retryButtonState({ disabled: false } as HTMLButtonElement)).toBe("enabled");
  });
});
