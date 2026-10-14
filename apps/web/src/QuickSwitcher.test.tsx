import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLoadingDelay } from "./Loading";
import { ANONYMOUS_TITLE_INDEX_MAX_REQUESTS, TITLE_INDEX_MAX_REQUESTS } from "./link-sources";
import { openNewPage } from "./new-page";
import { type ApiResult, listPageTitles } from "./pages-api";
import { QuickSwitcher } from "./QuickSwitcher";

vi.mock("./pages-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pages-api")>();
  return {
    ...actual,
    listPageTitles: vi.fn(),
  };
});

vi.mock("./new-page", () => ({ openNewPage: vi.fn() }));

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });

const summary = (id: string, title: string) => ({
  id,
  title,
  visibility: "public" as const,
  updatedAt: 0,
});
// 最近更新した順
const RECENT = [
  summary("AAAAAAAAAAAAAAAAAAAAAA", "読書メモ"),
  summary("BBBBBBBBBBBBBBBBBBBBBB", "Hono のメモ"),
  summary("CCCCCCCCCCCCCCCCCCCCCC", "メモ"),
  summary("DDDDDDDDDDDDDDDDDDDDDD", "買い物"),
];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const startUrl = location.href;
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.mocked(listPageTitles).mockResolvedValue(ok({ pages: RECENT, nextCursor: null }));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  history.replaceState(null, "", startUrl);
});

function Harness({ owner }: { owner: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <QuickSwitcher open={open} onOpenChange={setOpen} owner={owner} />
    </>
  );
}

async function renderSwitcher(owner: boolean) {
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  act(() => mounted.render(<Harness owner={owner} />));
  // 一覧の取得が終わるのを待つ
  await vi.waitFor(() => expect(options().length).toBeGreaterThan(0));
}

const dialog = () =>
  container?.querySelector<HTMLDialogElement>("dialog.switcher") as HTMLDialogElement;
const input = () =>
  container?.querySelector<HTMLInputElement>("input[role='combobox']") as HTMLInputElement;
const optionElements = () => [
  ...(container?.querySelectorAll<HTMLElement>("[role='option']") ?? []),
];
const options = () => optionElements().map((o) => o.textContent);
const selected = () =>
  optionElements().find((o) => o.getAttribute("aria-selected") === "true")?.textContent;

/** 制御された input に値を入れる。React は native の value setter を通した input イベントだけを拾う。 */
function typeText(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(key: string, init: KeyboardEventInit & { keyCode?: number } = {}) {
  act(() => {
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

describe("QuickSwitcher の候補", () => {
  it("開くと入力欄にフォーカスがあり、未入力なら最近更新したページを更新順に出す", async () => {
    await renderSwitcher(true);
    expect(dialog().open).toBe(true);
    expect(document.activeElement).toBe(input());
    expect(options()).toEqual(RECENT.map((p) => p.title));
    expect(container?.querySelector("[role='listbox']")?.getAttribute("aria-label")).toBe(
      "最近更新したページ",
    );
    // 語が無いので「作成」と「本文から検索」は出さない
    expect(container?.querySelector("[data-row-kind='create']")).toBeNull();
    expect(container?.querySelector("[data-row-kind='content-search']")).toBeNull();
  });

  it("打つと title で絞って一致した箇所を強調し、完全一致が無ければ「本文から検索」を先頭に出す", async () => {
    await renderSwitcher(true);
    typeText("買");
    expect(options()).toEqual(["「買」を本文から検索", "買い物", "「買」を作成"]);
    expect(optionElements()[1]?.querySelector("mark")?.textContent).toBe("買");
  });

  it("owner には title が完全に一致するページが無いときだけ「作成」を出す", async () => {
    await renderSwitcher(true);
    typeText("メ");
    expect(options().at(-1)).toBe("「メ」を作成");
    // 「メモ」は部分一致の候補があっても、完全に一致するページがあるので作らせない
    typeText("メモ");
    expect(options()[0]).toBe("メモ");
    expect(options().at(-1)).toBe("「メモ」を本文から検索");
    expect(options()).not.toContain("「メモ」を作成");
    // 全角半角と大文字小文字の違いは、title の比較と同じ畳み方で同じとみなす
    typeText("ＨＯＮＯ　のメモ");
    expect(options()).not.toContain("「ＨＯＮＯ　のメモ」を作成");
  });

  it("匿名には「作成」を出さず、候補が無いことを案内する", async () => {
    await renderSwitcher(false);
    typeText("ほげふ");
    expect(options()).toEqual(["「ほげふ」を本文から検索"]);
    expect(container?.querySelector("[role='status']")?.textContent).toContain("ありません");
  });

  it("匿名が本文を検索できない 3 文字未満では「本文から検索」を出さず、理由を案内する", async () => {
    await renderSwitcher(false);
    typeText("ほげ");
    expect(options()).toEqual([]);
    expect(container?.querySelector("[role='status']")?.textContent).toContain("3 文字以上");
    // 候補があっても本文検索の行は出さない
    typeText("買");
    expect(options()).toEqual(["買い物"]);
    expect(container?.querySelector("[role='status']")?.textContent).toContain("3 文字以上");
    press("Enter");
    expect(location.pathname).toBe(`/p/${RECENT[3]?.id}`);
  });

  it("匿名が 3 文字未満で候補も無いとき、Enter は何も起こさない", async () => {
    await renderSwitcher(false);
    typeText("ほげ");
    press("Enter");
    expect(location.search).toBe(new URL(startUrl).search);
    expect(dialog().open).toBe(true);
  });

  it("owner は 1 文字でも「本文から検索」を出す", async () => {
    await renderSwitcher(true);
    typeText("ほ");
    expect(options()).toContain("「ほ」を本文から検索");
    expect(container?.querySelector("[role='status']")).toBeNull();
  });

  it("前後の空白は無視して、語として扱う", async () => {
    await renderSwitcher(true);
    typeText("  ほげ  ");
    expect(options()).toEqual(["「ほげ」を本文から検索", "「ほげ」を作成"]);
  });

  it("title の一覧は、匿名には続きがあっても 1 回だけ読み、owner には上限の回数まで読む", async () => {
    vi.mocked(listPageTitles).mockResolvedValue(ok({ pages: RECENT, nextCursor: "next" }));
    // 候補は refresh が終わってから描き直すので、renderSwitcher が候補を待った時点で要求の回数は確定している
    await renderSwitcher(false);
    expect(listPageTitles).toHaveBeenCalledTimes(ANONYMOUS_TITLE_INDEX_MAX_REQUESTS);
    act(() => root?.unmount());
    container?.remove();
    vi.mocked(listPageTitles).mockClear();

    await renderSwitcher(true);
    expect(listPageTitles).toHaveBeenCalledTimes(TITLE_INDEX_MAX_REQUESTS);
  });
});

describe("QuickSwitcher の操作", () => {
  it("↑↓で選ぶ行を動かし、端では止まる", async () => {
    await renderSwitcher(true);
    expect(selected()).toBe("読書メモ");
    press("ArrowUp");
    expect(selected()).toBe("読書メモ");
    press("ArrowDown");
    press("ArrowDown");
    expect(selected()).toBe("メモ");
    const active = optionElements().find((o) => o.getAttribute("aria-selected") === "true");
    expect(input().getAttribute("aria-activedescendant")).toBe(active?.id);
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowDown");
    expect(selected()).toBe("買い物");
    press("ArrowUp");
    expect(selected()).toBe("メモ");
  });

  it("Enter で選んだページを開いて閉じる", async () => {
    await renderSwitcher(true);
    press("ArrowDown");
    press("Enter");
    expect(location.pathname).toBe(`/p/${RECENT[1]?.id}`);
    expect(dialog().open).toBe(false);
  });

  it("語を打つと先頭の行が選ばれ、打ち直すと選択も先頭に戻る", async () => {
    await renderSwitcher(true);
    typeText("メ");
    press("ArrowDown");
    expect(selected()).not.toBe(options()[0]);
    typeText("メモ");
    expect(selected()).toBe(options()[0]);
  });

  it("「本文から検索」を選ぶと、語を持って検索結果の画面へ移る", async () => {
    await renderSwitcher(false);
    typeText("ほげ ふが");
    press("Enter");
    expect(location.pathname).toBe("/");
    expect(new URLSearchParams(location.search).get("q")).toBe("ほげ ふが");
    expect(dialog().open).toBe(false);
  });

  it("title が完全に一致するページが無いとき、Enter は作らずに本文から検索する", async () => {
    await renderSwitcher(true);
    typeText("まだ無い語");
    expect(selected()).toBe("「まだ無い語」を本文から検索");
    press("Enter");
    expect(openNewPage).not.toHaveBeenCalled();
    expect(new URLSearchParams(location.search).get("q")).toBe("まだ無い語");
  });

  it("title が完全に一致するなら、Enter はそのページを開く", async () => {
    await renderSwitcher(true);
    typeText("メモ");
    press("Enter");
    expect(openNewPage).not.toHaveBeenCalled();
    expect(location.pathname).toBe(`/p/${RECENT[2]?.id}`);
  });

  it("「作成」を選ぶと、閉じてからその title で新規作成の画面を開く", async () => {
    let openWhenCreated: boolean | null = null;
    vi.mocked(openNewPage).mockImplementation(() => {
      // modal を閉じた後でないと、新規作成の画面の title 欄や本文に focus できない
      openWhenCreated = dialog().open;
    });
    await renderSwitcher(true);
    typeText(" ほげ ");
    expect(selected()).toBe("「ほげ」を本文から検索");
    press("ArrowDown");
    expect(selected()).toBe("「ほげ」を作成");
    press("Enter");
    expect(openNewPage).toHaveBeenCalledWith({ title: "ほげ" });
    expect(openWhenCreated).toBe(false);
    expect(dialog().open).toBe(false);
  });

  it("Esc で閉じる", async () => {
    await renderSwitcher(true);
    press("Escape");
    expect(dialog().open).toBe(false);
  });

  it("ブラウザが閉じた（Esc の既定動作）あとも、開き直せる", async () => {
    await renderSwitcher(true);
    act(() => dialog().close());
    expect(dialog().open).toBe(false);
    // close イベントで、閉じたことが親の状態にも伝わるのを待つ
    await vi.waitFor(() => expect(options()).toEqual([]));
    const open = [...(container?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "open",
    );
    act(() => open?.click());
    await vi.waitFor(() => expect(dialog().open).toBe(true));
    expect(input().value).toBe("");
  });

  it("枠の外を押すと閉じ、枠の中を押しても閉じない", async () => {
    await renderSwitcher(true);
    act(() => {
      input().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(dialog().open).toBe(true);
    act(() => {
      dialog().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(dialog().open).toBe(false);
  });
});

describe("QuickSwitcher の日本語入力", () => {
  it("変換中の Enter（isComposing）では行を実行しない", async () => {
    await renderSwitcher(true);
    typeText("ほげ");
    press("Enter", { isComposing: true });
    expect(location.pathname).not.toMatch(/^\/p\//);
    expect(location.search).toBe(new URL(startUrl).search);
    expect(openNewPage).not.toHaveBeenCalled();
    expect(dialog().open).toBe(true);
    expect(input().value).toBe("ほげ");
  });

  it("Safari のように isComposing: false で届く変換確定の Enter（keyCode 229）でも実行しない", async () => {
    await renderSwitcher(true);
    typeText("ほげ");
    press("Enter", { keyCode: 229 });
    expect(location.search).toBe(new URL(startUrl).search);
    expect(openNewPage).not.toHaveBeenCalled();
    expect(dialog().open).toBe(true);
  });

  it("変換中の↑↓と Esc は変換の操作に任せ、選択も閉じる動作も動かさない", async () => {
    await renderSwitcher(true);
    typeText("メ");
    const before = selected();
    press("ArrowDown", { isComposing: true });
    press("ArrowDown", { keyCode: 229 });
    expect(selected()).toBe(before);
    press("Escape", { isComposing: true });
    expect(dialog().open).toBe(true);
  });

  it("変換の開始から確定までの間、入力欄の値は打った文字のままで、候補だけを出し直す", async () => {
    await renderSwitcher(true);
    const compose = (text: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      act(() => {
        setter?.call(input(), text);
        input().dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            isComposing: true,
            inputType: "insertCompositionText",
          }),
        );
      });
    };
    act(() => {
      input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    compose("ほ");
    expect(input().value).toBe("ほ");
    compose("ほげ");
    expect(input().value).toBe("ほげ");
    expect(options()).toContain("「ほげ」を本文から検索");
    act(() => {
      input().dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "ほげ" }),
      );
    });
    expect(input().value).toBe("ほげ");
    expect(options()).toContain("「ほげ」を本文から検索");
  });

  it("変換が確定した後の Enter は行を実行する", async () => {
    await renderSwitcher(false);
    typeText("ほげふ");
    press("Enter");
    expect(new URLSearchParams(location.search).get("q")).toBe("ほげふ");
  });
});

describe("QuickSwitcher の候補の取得中", () => {
  let deliver: (value: ApiResult<{ pages: typeof RECENT; nextCursor: null }>) => void = () => {};
  const status = () =>
    [...(container?.querySelectorAll("[role='status']") ?? [])].map((e) => e.textContent);
  const pending = () => container?.querySelector<HTMLElement>(".switcher-pending");

  async function openPending(owner: boolean) {
    vi.mocked(listPageTitles).mockReturnValue(
      new Promise((resolve) => {
        deliver = resolve as never;
      }),
    );
    container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => mounted.render(<Harness owner={owner} />));
  }

  it("owner には、取得が済むまで「作成」を出さず、済んだら出す", async () => {
    await openPending(true);
    typeText("新しい語");
    expect(container?.querySelector("[data-row-kind='create']")).toBeNull();
    expect(status()).toEqual([expect.stringContaining("候補を読み込み中…")]);

    await act(async () => deliver(ok({ pages: RECENT, nextCursor: null })));
    expect(container?.querySelector("[data-row-kind='create']")).not.toBeNull();
    expect(pending()).toBeNull();
  });

  it("匿名には、取得が済むまで「一致するページはありません」を出さず、済んだら出す", async () => {
    await openPending(false);
    typeText("新しい語");
    expect(container?.textContent).not.toContain("タイトルが一致するページはありません。");

    await act(async () => deliver(ok({ pages: RECENT, nextCursor: null })));
    expect(container?.textContent).toContain("タイトルが一致するページはありません。");
  });

  it("匿名が取得中に 3 文字未満を打っても、案内の status は 1 つにまとまる", async () => {
    await openPending(false);
    typeText("ほげ");
    expect(status()).toEqual([expect.stringMatching(/候補を読み込み中…[\s\S]*3 文字以上/)]);
  });

  it("取得に失敗しても、済んだ扱いで「作成」を出す", async () => {
    await openPending(true);
    typeText("新しい語");
    await act(async () =>
      deliver({ ok: false, reason: "error", message: "失敗" } as unknown as ApiResult<never>),
    );
    expect(container?.querySelector("[data-row-kind='create']")).not.toBeNull();
  });

  it("「候補を読み込み中…」の文字は、遅れの後に見せる", async () => {
    const restore = setLoadingDelay(0);
    try {
      await openPending(true);
      expect(pending()?.classList.contains("skeleton-painted")).toBe(true);
      expect(pending()?.textContent).toBe("候補を読み込み中…");
    } finally {
      restore();
    }
  });

  it("遅れの間は、文字を隠したまま場所を取る", async () => {
    const restore = setLoadingDelay(60_000);
    try {
      await openPending(true);
      expect(pending()?.classList.contains("skeleton-painted")).toBe(false);
    } finally {
      restore();
    }
  });
});
