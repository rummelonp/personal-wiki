import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { setLoadingDelay } from "./Loading";
import type { LinkedDraft } from "./linked-drafts";
import type { ApiResult } from "./pages-api";
import { VisibilityControl } from "./VisibilityControl";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;
let restoreDelay: (() => void) | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  restoreDelay?.();
  restoreDelay = null;
});

type Props = Parameters<typeof VisibilityControl>[0];

function render(overrides: Partial<Props> = {}) {
  const props: Props = {
    visibility: "draft",
    disabled: false,
    externalBases: 0,
    pending: null,
    onChange: async () => {},
    ...overrides,
  };
  if (container === null) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root?.render(<VisibilityControl {...props} />));
}

const pill = () => {
  const found = container?.querySelector<HTMLButtonElement>(".visibility-pill");
  if (found == null) throw new Error("印が無い");
  return found;
};
const menu = () => container?.querySelector<HTMLElement>("[role='menu']") ?? null;
const item = (name: string) => {
  const found = [
    ...(container?.querySelectorAll<HTMLElement>("[role='menuitemradio']") ?? []),
  ].find((el) => el.querySelector(".visibility-option-label")?.textContent === name);
  if (found === undefined) throw new Error(`項目が無い: ${name}`);
  return found;
};
const dialog = () => container?.querySelector<HTMLDialogElement>("dialog") ?? null;
const status = () => container?.querySelector(".visibility > [role='status']")?.textContent;

function button(name: string): HTMLButtonElement {
  const found = [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (el) => el.textContent === name,
  );
  if (found === undefined) throw new Error(`ボタンが無い: ${name}`);
  return found;
}

function key(target: Element, name: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

async function openConfirm() {
  act(() => pill().click());
  await act(async () => item("公開").click());
}

describe("印", () => {
  it("今の公開範囲を名前に含め、メニューを開くボタンだと伝える", () => {
    render({ visibility: "public" });
    expect(pill().getAttribute("aria-label")).toBe("公開範囲：公開");
    expect(pill().dataset.visibility).toBe("public");
    expect(pill().getAttribute("aria-haspopup")).toBe("menu");
    expect(pill().getAttribute("aria-expanded")).toBe("false");
  });

  it("押すとメニューを開き、選択中の項目に焦点を移す", () => {
    render();
    act(() => pill().click());
    expect(pill().getAttribute("aria-expanded")).toBe("true");
    expect(pill().getAttribute("aria-controls")).toBe(menu()?.id);
    expect(item("下書き").getAttribute("aria-checked")).toBe("true");
    expect(item("公開").getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement).toBe(item("下書き"));
  });

  it("切り替えられない間は押せず、開いていたメニューも閉じる", () => {
    render();
    act(() => pill().click());
    render({ disabled: true });
    expect(pill().disabled).toBe(true);
    expect(menu()).toBeNull();
  });
});

describe("メニューの操作", () => {
  it("矢印で項目を巡り、Home と End で端に移る", () => {
    render();
    act(() => pill().click());
    const list = menu() as HTMLElement;
    key(list, "ArrowDown");
    expect(document.activeElement).toBe(item("公開"));
    key(list, "ArrowDown");
    expect(document.activeElement).toBe(item("下書き"));
    key(list, "ArrowUp");
    expect(document.activeElement).toBe(item("公開"));
    key(list, "Home");
    expect(document.activeElement).toBe(item("下書き"));
    key(list, "End");
    expect(document.activeElement).toBe(item("公開"));
  });

  it("印の上で下の矢印を押しても開く", () => {
    render();
    pill().focus();
    key(pill(), "ArrowDown");
    expect(menu()).not.toBeNull();
  });

  it("Escape で閉じて印に焦点を戻し、外側の Escape の処理には渡さない", () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    try {
      render();
      act(() => pill().click());
      key(menu() as HTMLElement, "Escape");
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(pill());
      expect(outer).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", outer);
    }
  });

  it("外側を押すと閉じ、何も変えない", () => {
    const onChange = vi.fn(async () => {});
    render({ onChange });
    act(() => pill().click());
    act(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(menu()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("焦点を持たない外側を押して閉じると、焦点を印に戻す", async () => {
    const outside = document.createElement("div");
    outside.style.height = "40px";
    document.body.append(outside);
    try {
      render();
      act(() => pill().click());
      expect(document.activeElement).toBe(item("下書き"));
      const focus = vi.spyOn(pill(), "focus");
      await userEvent.click(outside);
      expect(menu()).toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(pill()));
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      outside.remove();
    }
  });

  it("入力欄を押して閉じたときは、焦点を入力欄に残す", async () => {
    const input = document.createElement("input");
    document.body.append(input);
    try {
      render();
      act(() => pill().click());
      await userEvent.click(input);
      expect(menu()).toBeNull();
      // 印へ戻す判定は setTimeout(0) の後に走るので、それより後に見る
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(document.activeElement).toBe(input);
    } finally {
      input.remove();
    }
  });

  it("焦点が外へ移ると閉じる。行き先の無い focusout では閉じない", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      render();
      act(() => pill().click());
      act(() => {
        item("下書き").dispatchEvent(
          new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
        );
      });
      expect(menu()).not.toBeNull();
      act(() => outside.focus());
      expect(menu()).toBeNull();
    } finally {
      outside.remove();
    }
  });

  it("今と同じ公開範囲を選ぶと、閉じるだけで依頼しない", () => {
    const onChange = vi.fn(async () => {});
    render({ onChange });
    act(() => pill().click());
    act(() => item("下書き").click());
    expect(menu()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(pill());
  });

  it("公開から下書きは確認せずに依頼する", async () => {
    const onChange = vi.fn(async () => {});
    render({ visibility: "public", onChange });
    act(() => pill().click());
    await act(async () => item("下書き").click());
    expect(onChange).toHaveBeenCalledWith("draft");
    expect(dialog()?.open).toBe(false);
  });
});

describe("公開の確認", () => {
  it("メニューで公開を選ぶとメニューを閉じ、やめるに焦点を置いたダイアログを開く", async () => {
    render();
    await openConfirm();
    expect(menu()).toBeNull();
    expect(dialog()?.open).toBe(true);
    expect(dialog()?.getAttribute("aria-label")).toBe("公開の確認");
    expect(document.activeElement).toBe(button("やめる"));
  });

  it("取り消せない範囲まで伝え、確定とやめるの両方にその文を結び付ける", async () => {
    render();
    await openConfirm();
    const text = dialog()?.querySelector(".publish-dialog-head > p");
    expect(text?.textContent).toBe(
      "誰でもこのページを読めるようになり、最近の更新、検索、タグの一覧にも載ります。下書きに戻しても、すでに読まれた内容は取り消せません。",
    );
    expect(text?.id).not.toBe("");
    expect(button("公開する").getAttribute("aria-describedby")).toBe(text?.id);
    expect(button("やめる").getAttribute("aria-describedby")).toBe(text?.id);
  });

  it("やめると何も依頼せずに閉じ、印に焦点を戻す", async () => {
    const onChange = vi.fn(async () => {});
    render({ onChange });
    await openConfirm();
    act(() => button("やめる").click());
    expect(dialog()?.open).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(pill().dataset.visibility).toBe("draft");
    expect(document.activeElement).toBe(pill());
  });

  it("Escape で閉じても何も依頼しない", async () => {
    const onChange = vi.fn(async () => {});
    render({ onChange });
    await openConfirm();
    act(() => {
      dialog()?.dispatchEvent(new Event("cancel", { cancelable: true }));
      dialog()?.close();
    });
    expect(dialog()?.open).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("枠の外を押すと閉じ、中を押しても閉じない", async () => {
    const onChange = vi.fn(async () => {});
    render({ onChange });
    await openConfirm();
    act(() => {
      dialog()
        ?.querySelector("p")
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(dialog()?.open).toBe(true);
    act(() => {
      dialog()?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(dialog()?.open).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("公開するで依頼して閉じる", async () => {
    const onChange = vi.fn(async () => {});
    render({ onChange });
    await openConfirm();
    await act(async () => button("公開する").click());
    expect(onChange).toHaveBeenCalledWith("public");
    expect(dialog()?.open).toBe(false);
  });

  it("公開するを続けて 2 回押しても、依頼は 1 回だけ", async () => {
    const onChange = vi.fn(async () => {});
    render({ onChange });
    await openConfirm();
    const confirm = button("公開する");
    // 閉じる描画が済む前の 2 回目の click も、同じボタンに届く
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("切り替えられない間は公開するを押せない", async () => {
    render();
    await openConfirm();
    render({ disabled: true });
    expect(button("公開する").disabled).toBe(true);
  });

  it("開いている間に他から内容が変わったら閉じる", async () => {
    render();
    await openConfirm();
    render({ externalBases: 1 });
    expect(dialog()?.open).toBe(false);
  });
});

describe("待っている間と結果", () => {
  it("押した先をすぐ印に出し、遅れて回る印と読み上げを出す", () => {
    restoreDelay = setLoadingDelay(0);
    render({ pending: "public" });
    expect(pill().dataset.visibility).toBe("public");
    expect(pill().getAttribute("aria-label")).toBe("公開範囲：公開");
    expect(pill().getAttribute("aria-busy")).toBe("true");
    expect(pill().disabled).toBe(true);
    expect(container?.querySelector(".visibility-spinner")).not.toBeNull();
    expect(status()).toBe("公開に変更中…");
  });

  it("届いたら回る印を消し、結果を読み上げて印に焦点を戻す", async () => {
    restoreDelay = setLoadingDelay(0);
    let finish: () => void = () => {};
    const onChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render({ onChange });
    await openConfirm();
    await act(async () => button("公開する").click());
    render({ onChange, pending: "public" });
    await act(async () => finish());
    render({ onChange, visibility: "public" });
    expect(container?.querySelector(".visibility-spinner")).toBeNull();
    expect(pill().getAttribute("aria-busy")).toBe("false");
    expect(status()).toBe("公開しました。");
    expect(document.activeElement).toBe(pill());
  });

  it("待つ間に焦点を入力欄へ移していたら、届いても焦点を印に戻さない", async () => {
    restoreDelay = setLoadingDelay(0);
    let finish: () => void = () => {};
    const onChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const input = document.createElement("textarea");
    document.body.append(input);
    try {
      render({ onChange, visibility: "public" });
      act(() => pill().click());
      await act(async () => item("下書き").click());
      render({ onChange, visibility: "public", pending: "draft" });
      input.focus();
      await act(async () => finish());
      render({ onChange, visibility: "draft" });
      expect(status()).toBe("下書きに戻しました。");
      expect(document.activeElement).toBe(input);
    } finally {
      input.remove();
    }
  });

  it("失敗して元の値のまま待ちが終わったら、印を元に戻す", () => {
    restoreDelay = setLoadingDelay(0);
    render({ pending: "public" });
    render({ pending: null });
    expect(pill().dataset.visibility).toBe("draft");
    expect(container?.querySelector(".visibility-spinner")).toBeNull();
    expect(status()).toBe("");
  });
});

describe("公開の確認の、リンクしている下書き", () => {
  const draftsBox = () => dialog()?.querySelector(".publish-drafts");
  const confirmText = () => dialog()?.querySelector(".publish-dialog-head > p");
  const found = (value: readonly LinkedDraft[]): ApiResult<readonly LinkedDraft[]> => ({
    ok: true,
    value,
  });

  // 0 件と見分けがつかないと、リンクしていないと誤って読める
  it.each([
    [
      "失敗が返る",
      async (): Promise<ApiResult<readonly LinkedDraft[]>> => ({
        ok: false,
        reason: "error",
        message: "通信できませんでした",
      }),
    ],
    [
      "reject される",
      async (): Promise<ApiResult<readonly LinkedDraft[]>> => {
        throw new TypeError("Failed to fetch");
      },
    ],
  ])("%s と、調べられなかったことを一覧の場所に出し、公開は止めない", async (_, find) => {
    render({ findLinkedDrafts: find });
    await openConfirm();
    const text = draftsBox()?.querySelector("p");
    expect(text?.textContent).toBe(
      "リンク先の下書きを調べられませんでした。やめて開き直すと、もう一度調べます。",
    );
    expect(draftsBox()?.querySelector("ul")).toBeNull();
    expect(button("やめる").getAttribute("aria-describedby")).toBe(
      `${confirmText()?.id} ${text?.id}`,
    );
    expect(button("公開する").disabled).toBe(false);
  });

  it("確認を開くと調べ、届いた下書きを id の URL のリンクで並べる", async () => {
    const find = vi.fn(async () =>
      found([
        { id: "d1", title: "計画" },
        { id: "d2", title: "メモ" },
      ]),
    );
    render({ findLinkedDrafts: find });
    act(() => pill().click());
    expect(find).not.toHaveBeenCalled();
    await act(async () => item("公開").click());
    expect(find).toHaveBeenCalledTimes(1);
    expect(draftsBox()?.getAttribute("role")).toBe("status");
    const text = draftsBox()?.querySelector("p");
    expect(text?.textContent).toBe(
      "本文から2件の下書きにリンクしています。公開しても、読む人にはリンクではなく文字に見えます。",
    );
    const anchors = [...(draftsBox()?.querySelectorAll("a") ?? [])];
    expect(anchors.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["計画", "/p/d1"],
      ["メモ", "/p/d2"],
    ]);
    // 確定とやめるの読み上げにも、一覧の文を結び付ける
    expect(button("やめる").getAttribute("aria-describedby")).toBe(
      `${confirmText()?.id} ${text?.id}`,
    );
    // 一覧は操作の後ろに置き、届いても操作の位置を動かさない
    const actions = dialog()?.querySelector(".publish-dialog-head .actions");
    expect(actions?.parentElement?.nextElementSibling).toBe(draftsBox());
  });

  it("0 件なら何も足さない", async () => {
    render({ findLinkedDrafts: async () => found([]) });
    await openConfirm();
    expect(draftsBox()?.textContent).toBe("");
    expect(button("やめる").getAttribute("aria-describedby")).toBe(confirmText()?.id);
  });

  it("閉じた後に届いた結果は捨て、開き直すと調べ直す", async () => {
    let release: (drafts: ApiResult<readonly LinkedDraft[]>) => void = () => {};
    const signals: AbortSignal[] = [];
    const find = vi.fn(
      (signal: AbortSignal) =>
        new Promise<ApiResult<readonly LinkedDraft[]>>((resolve) => {
          signals.push(signal);
          release = resolve;
        }),
    );
    render({ findLinkedDrafts: find });
    await openConfirm();
    await act(async () => button("やめる").click());
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => release(found([{ id: "d1", title: "計画" }])));
    expect(draftsBox()).toBeNull();

    await openConfirm();
    expect(find).toHaveBeenCalledTimes(2);
    expect(draftsBox()?.textContent).toBe("");
  });
});
