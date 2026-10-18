import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ListSkeleton, setLoadingDelay } from "./Loading";
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

function Harness({
  owner,
  initialQuery = "",
  openPageId = null,
}: {
  owner: boolean;
  initialQuery?: string;
  openPageId?: string | null;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <QuickSwitcher
        open={open}
        onOpenChange={setOpen}
        owner={owner}
        initialQuery={initialQuery}
        openPageId={openPageId}
      />
    </>
  );
}

async function renderSwitcher(owner: boolean, initialQuery = "", openPageId: string | null = null) {
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  act(() =>
    mounted.render(<Harness owner={owner} initialQuery={initialQuery} openPageId={openPageId} />),
  );
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

/**
 * Escape で閉じ、dialog の close イベントが届くまで待つ。イベントはタスクで遅れて届き、
 * onClose が開閉の state を閉じた側に戻すので、待たずに開き直すと開いた直後に閉じてしまう。
 */
async function closeWithEscape() {
  const closed = new Promise((resolve) =>
    dialog().addEventListener("close", resolve, { once: true }),
  );
  press("Escape");
  await act(async () => {
    await closed;
  });
}

describe("QuickSwitcher を検索結果の画面から開く", () => {
  it("いまの検索語を入れて全選択し、Enter で同じ語の検索結果へ移る", async () => {
    history.replaceState(null, "", "/?q=%E3%81%BB%E3%81%92");
    await renderSwitcher(true, "ほげ");
    expect(input().value).toBe("ほげ");
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, 2]);
    expect(document.activeElement).toBe(input());
    expect(selected()).toBe("「ほげ」を本文から検索");
    expect(container?.querySelector("[data-row-kind='clear-search']")).toBeNull();
    press("Enter");
    expect(new URLSearchParams(location.search).get("q")).toBe("ほげ");
    expect(dialog().open).toBe(false);
  });

  it("同じ語のまま Enter しても、履歴を積まない", async () => {
    history.replaceState(null, "", "/?q=%E3%81%BB%E3%81%92");
    await renderSwitcher(true, "ほげ");
    const before = history.length;
    press("Enter");
    expect(location.search).toBe("?q=%E3%81%BB%E3%81%92");
    expect(history.length).toBe(before);
  });

  it("tag で絞った検索結果から同じ語を選んでも、tag を外さず履歴を積まない", async () => {
    history.replaceState(null, "", "/?q=%E3%81%BB%E3%81%92&tag=x");
    await renderSwitcher(true, "ほげ");
    const before = history.length;
    press("Enter");
    expect(location.search).toBe("?q=%E3%81%BB%E3%81%92&tag=x");
    expect(history.length).toBe(before);
    expect(dialog().open).toBe(false);
  });

  it("別の語を選ぶと、検索結果へ移って履歴を積む", async () => {
    history.replaceState(null, "", "/?q=%E3%81%BB%E3%81%92&tag=x");
    await renderSwitcher(true, "ほげ");
    const before = history.length;
    typeText("ふが");
    press("Enter");
    expect(location.search).toBe("?q=%E3%81%B5%E3%81%8C");
    expect(history.length).toBe(before + 1);
  });

  it("語を消すと先頭に検索を解除する行が出て、Enter で検索語の無いトップへ戻る", async () => {
    history.replaceState(null, "", "/?q=%E3%81%BB%E3%81%92");
    await renderSwitcher(true, "ほげ");
    typeText("");
    await vi.waitFor(() => expect(options()[0]).toBe("検索を解除して一覧へ戻る"));
    expect(selected()).toBe("検索を解除して一覧へ戻る");
    // 最近のページの行と取り違えないよう、操作の行と同じく、アイコンを付ける
    expect(container?.querySelector("[data-row-kind='clear-search'] svg.icon")).not.toBeNull();
    expect(container?.querySelector("[role='listbox']")?.getAttribute("aria-label")).toBe(
      "候補と操作",
    );
    expect(container?.querySelector("p.switcher-heading[aria-hidden='true']")).toBeNull();
    press("Enter");
    expect(location.pathname).toBe("/");
    expect(location.search).toBe("");
    expect(dialog().open).toBe(false);
  });

  it("検索結果の画面で開いていなければ、語が空でも検索を解除する行は出さない", async () => {
    await renderSwitcher(true);
    expect(container?.querySelector("[data-row-kind='clear-search']")).toBeNull();
  });

  it("匿名が本文を検索できない短い語は、本文から検索する行を出さずに案内する", async () => {
    await renderSwitcher(false, "メモ");
    expect(container?.querySelector("[data-row-kind='content-search']")).toBeNull();
    // 開いた描画の案内は、frame を空けてから status に入る
    await vi.waitFor(() =>
      expect(container?.querySelector("[role='status']")?.textContent).toBe(
        "3文字以上で、本文からも検索できます。",
      ),
    );
  });

  it("開いた描画では案内を status の外に見せるだけにし、frame を空けてから status へ入れる", async () => {
    container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    act(() => mounted.render(<Harness owner={false} initialQuery="メモ" />));
    const live = container.querySelector("[role='status']");
    const guidance = "3文字以上で、本文からも検索できます。";
    expect(live?.textContent).not.toContain("文字以上");
    // 場所は先に取り、候補の行が後から押し下げられないようにする
    expect(container.querySelector("[aria-hidden='true'] p")?.textContent).toBe(guidance);

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    expect(container.querySelector("[role='status']")).toBe(live);
    expect(live?.textContent).toBe(guidance);
    expect(container.querySelector("[aria-hidden='true'] p")).toBeNull();
  });

  it("開いた後に語を打って出た案内は、待たずに status へ入れる", async () => {
    container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    act(() => mounted.render(<Harness owner={false} />));
    typeText("ほげ");
    expect(container.querySelector("[role='status']")?.textContent).toContain("3文字以上");
    expect(container.querySelector("[aria-hidden='true'] p")).toBeNull();
  });
});

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

  it("dialog はページを検索する場所、入力欄は検索語の欄として名付け、title で絞ることを欄の中で示す", async () => {
    await renderSwitcher(true);
    expect(dialog().getAttribute("aria-label")).toBe("ページを検索");
    expect(input().getAttribute("aria-label")).toBe("検索語");
    expect(input().placeholder).toBe("タイトルで検索");
  });

  it("打つと title で絞って一致した箇所を強調し、完全一致が無ければ「本文から検索」を先頭に出す", async () => {
    await renderSwitcher(true);
    typeText("買");
    expect(options()).toEqual(["「買」を本文から検索", "買い物", "「買」を作成"]);
    expect(optionElements()[1]?.querySelector("mark")?.textContent).toBe("買");
  });

  it("`_` と空白の違いを越えて一致した箇所も強調する", async () => {
    vi.mocked(listPageTitles).mockResolvedValue(
      ok({
        pages: [
          summary("EEEEEEEEEEEEEEEEEEEEEE", "週次 ふりかえり"),
          summary("FFFFFFFFFFFFFFFFFFFFFF", "snake_case"),
        ],
        nextCursor: null,
      }),
    );
    await renderSwitcher(true);
    const markedText = (title: string) => {
      const option = optionElements().find((el) => el.textContent === title);
      return option?.querySelector("mark")?.textContent;
    };
    typeText("週次_ふり");
    expect(markedText("週次 ふりかえり")).toBe("週次 ふり");
    typeText("snake_case");
    expect(markedText("snake_case")).toBe("snake_case");
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

  it("匿名には「作成」を出さず、候補が無くても「本文から検索」の行があれば案内の文は出さない", async () => {
    await renderSwitcher(false);
    typeText("ほげふ");
    expect(options()).toEqual(["「ほげふ」を本文から検索"]);
    expect(container?.querySelector("[role='status']")?.textContent).toBe("");
  });

  it("匿名が本文を検索できない 3 文字未満では「本文から検索」を出さず、何文字から検索できるかを案内する", async () => {
    await renderSwitcher(false);
    typeText("ほげ");
    expect(options()).toEqual([]);
    expect(container?.querySelector("[role='status']")?.textContent).toBe(
      "一致するタイトルはありません。3文字以上で、本文からも検索できます。",
    );
    // 候補があっても本文検索の行は出さない
    typeText("買");
    expect(options()).toEqual(["買い物"]);
    expect(container?.querySelector("[role='status']")?.textContent).toBe(
      "3文字以上で、本文からも検索できます。",
    );
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
    // 案内が無い間も status は置いたままで、中身だけが空になる
    expect(container?.querySelector("[role='status']")?.textContent).toBe("");
  });

  it("前後の空白は無視して、語として扱う", async () => {
    await renderSwitcher(true);
    typeText("  ほげ  ");
    expect(options()).toEqual(["「ほげ」を本文から検索", "「ほげ」を作成"]);
  });

  it("title の一覧は、匿名には続きがあっても 1 回だけ読み、owner には上限の回数まで読む", async () => {
    vi.mocked(listPageTitles).mockResolvedValue(ok({ pages: RECENT, nextCursor: "next" }));
    // 候補は refresh が終わってから描き直すので、renderSwitcher が候補を待った時点でリクエストの回数は確定している
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

  it.each([
    ["title の URL", `/${encodeURIComponent("Hono_のメモ")}`],
    ["id の URL", `/p/${RECENT[1]?.id}`],
  ])("いま開いているページを選んでも、%s のまま履歴を積まない", async (_name, path) => {
    history.replaceState(null, "", path);
    await renderSwitcher(true);
    const before = history.length;
    typeText("Hono のメモ");
    expect(selected()).toBe("Hono のメモ");
    press("Enter");
    expect(location.pathname + location.search).toBe(path);
    expect(history.length).toBe(before);
    expect(dialog().open).toBe(false);
  });

  it("URL が旧 title のままでも、開いているページの id と同じ候補なら履歴を積まない", async () => {
    const path = `/${encodeURIComponent("旧い題")}`;
    history.replaceState(null, "", path);
    await renderSwitcher(true, "", RECENT[1]?.id);
    const before = history.length;
    typeText("Hono のメモ");
    expect(selected()).toBe("Hono のメモ");
    press("Enter");
    expect(location.pathname).toBe(path);
    expect(history.length).toBe(before);
    expect(dialog().open).toBe(false);
  });

  it("URL の title が別のページの title と同じでも、開いているページの id と違う候補へは移る", async () => {
    history.replaceState(null, "", `/${encodeURIComponent("メモ")}`);
    await renderSwitcher(true, "", RECENT[1]?.id);
    const before = history.length;
    typeText("メモ");
    expect(selected()).toBe("メモ");
    press("Enter");
    expect(location.pathname).toBe(`/p/${RECENT[2]?.id}`);
    expect(history.length).toBe(before + 1);
  });

  it("別のページを開いている間は、選んだページへ移って履歴を積む", async () => {
    history.replaceState(null, "", `/${encodeURIComponent("メモ")}`);
    await renderSwitcher(true);
    const before = history.length;
    typeText("Hono のメモ");
    press("Enter");
    expect(location.pathname).toBe(`/p/${RECENT[1]?.id}`);
    expect(history.length).toBe(before + 1);
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

  it("匿名には、取得が済むまで「一致するタイトルはありません」を出さず、済んだら出す", async () => {
    await openPending(false);
    typeText("ほげ");
    expect(container?.textContent).not.toContain("一致するタイトルはありません。");

    await act(async () => deliver(ok({ pages: RECENT, nextCursor: null })));
    expect(container?.textContent).toContain("一致するタイトルはありません。");
  });

  it("匿名が取得中に 3 文字未満を打っても、案内の status は 1 つにまとまる", async () => {
    await openPending(false);
    typeText("ほげ");
    expect(status()).toEqual([expect.stringMatching(/候補を読み込み中…[\s\S]*3文字以上/)]);
  });

  const failure = { ok: false, reason: "error", message: "失敗" } as unknown as ApiResult<never>;
  const CANDIDATES_FAILED = "候補を取得できません。";

  it("owner には、取得に失敗して候補が無いとき、「作成」を出さず失敗を案内する", async () => {
    await openPending(true);
    typeText("新しい語");
    await act(async () => deliver(failure));
    expect(container?.querySelector("[data-row-kind='create']")).toBeNull();
    expect(pending()).toBeNull();
    expect(status()).toEqual([expect.stringContaining(CANDIDATES_FAILED)]);
    // インデックスに依らない「本文から検索」は残り、既定の行になる
    expect(options()).toEqual(["「新しい語」を本文から検索"]);
    expect(selected()).toBe("「新しい語」を本文から検索");
  });

  it("匿名には、取得に失敗して候補が無いとき、「一致するタイトルはありません」を出さず失敗を案内する", async () => {
    await openPending(false);
    typeText("ほげ");
    await act(async () => deliver(failure));
    expect(container?.textContent).not.toContain("一致するタイトルはありません。");
    expect(status()).toEqual([expect.stringContaining(CANDIDATES_FAILED)]);
  });

  it("未入力でも、取得に失敗して候補が無いことを案内する", async () => {
    await openPending(true);
    await act(async () => deliver(failure));
    expect(status()).toEqual([expect.stringContaining(CANDIDATES_FAILED)]);
  });

  it("開き直したときの取得が失敗しても、前に取れた候補があれば失敗を見せず、「作成」も出す", async () => {
    await renderSwitcher(true);
    await closeWithEscape();
    vi.mocked(listPageTitles).mockResolvedValue(failure);
    act(() => container?.querySelector("button")?.click());
    await vi.waitFor(() => expect(vi.mocked(listPageTitles)).toHaveBeenCalledTimes(2));
    // 失敗のレスポンスを描き終えてから確かめる。「作成」は前の取得の結果で最初から出ているので、
    // 出たことを待つだけでは失敗が反映される前に通ってしまう
    await act(async () => {});
    typeText("新しい語");
    expect(container?.querySelector("[data-row-kind='create']")).not.toBeNull();
    expect(container?.textContent).not.toContain(CANDIDATES_FAILED);
    typeText("読書");
    expect(options()).toContain("読書メモ");
  });

  it("失敗のあとに取得が成功したら、失敗の案内は消えて「作成」が出る", async () => {
    vi.mocked(listPageTitles).mockResolvedValue(failure);
    container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => mounted.render(<Harness owner={true} />));
    typeText("新しい語");
    expect(status()).toEqual([expect.stringContaining(CANDIDATES_FAILED)]);

    await closeWithEscape();
    vi.mocked(listPageTitles).mockResolvedValue(ok({ pages: RECENT, nextCursor: null }));
    await act(async () => container?.querySelector("button")?.click());
    typeText("新しい語");
    await vi.waitFor(() =>
      expect(container?.querySelector("[data-row-kind='create']")).not.toBeNull(),
    );
    expect(container?.textContent).not.toContain(CANDIDATES_FAILED);
  });

  it("失敗のあとに開き直して取り直している間は、失敗の案内でなく「候補を読み込み中…」を出す", async () => {
    vi.mocked(listPageTitles).mockResolvedValue(failure);
    container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => mounted.render(<Harness owner={true} />));
    expect(status()).toEqual([expect.stringContaining(CANDIDATES_FAILED)]);

    await closeWithEscape();
    vi.mocked(listPageTitles).mockReturnValue(
      new Promise((resolve) => {
        deliver = resolve as never;
      }),
    );
    await act(async () => container?.querySelector("button")?.click());
    expect(container?.textContent).not.toContain(CANDIDATES_FAILED);
    expect(status()).toEqual([expect.stringContaining("候補を読み込み中…")]);
    expect(pending()).not.toBeNull();

    // 取り直しがまた失敗したら、失敗の案内に戻る
    await act(async () => deliver(failure));
    expect(pending()).toBeNull();
    expect(status()).toEqual([expect.stringContaining(CANDIDATES_FAILED)]);
  });

  it("失敗の案内は、見出しと見分けがつくよう失敗の印の class を持ち、短い文言で出す", async () => {
    await openPending(true);
    await act(async () => deliver(failure));
    const note = container?.querySelector("[role='status'] p");
    expect(note?.classList).toContain("switcher-alert");
    expect(note?.textContent).toBe("候補を取得できません。開き直してください。");
  });

  it("案内の status は、取得中から失敗へ変わる間も同じ要素のまま中身だけが変わる", async () => {
    await openPending(true);
    const region = container?.querySelector("[role='status']");
    expect(region).not.toBeNull();
    await act(async () => deliver(failure));
    expect(container?.querySelector("[role='status']")).toBe(region);
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

  it("開いた描画では status を空にし、frame を空けてから支援技術向けの「候補を読み込み中…」を入れる", async () => {
    await openPending(true);
    const live = container?.querySelector("[role='status']");
    const announced = () => live?.querySelector(".visually-hidden")?.textContent;
    expect(live).not.toBeNull();
    expect(announced()).toBeUndefined();

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    expect(container?.querySelector("[role='status']")).toBe(live);
    expect(announced()).toBe("候補を読み込み中…");
  });

  it("一覧のスケルトンを描いている最中に開いても、「候補を読み込み中…」の文字は遅れの後に見せる", async () => {
    const restore = setLoadingDelay(1_000);
    vi.useFakeTimers();
    const board = document.createElement("div");
    document.body.append(board);
    const boardRoot = createRoot(board);
    try {
      // スケルトンを描いた記録は、描く側が遅れの後に立てる。立ったままの画面で開いた状況を作る
      await act(async () => boardRoot.render(<ListSkeleton />));
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(board.querySelector(".skeleton-painted")).not.toBeNull();

      await openPending(true);
      expect(pending()?.classList.contains("skeleton-painted")).toBe(false);
    } finally {
      act(() => boardRoot.unmount());
      board.remove();
      vi.useRealTimers();
      restore();
    }
  });
});
