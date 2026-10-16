import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLoadingDelay } from "./Loading";
import {
  type ApiResult,
  getRevision,
  listRevisions,
  type RevisionList,
  type RevisionSummary,
} from "./pages-api";
import { authorLabel, RevisionHistory } from "./RevisionHistory";
import { registerScrollAnchor } from "./scroll-restore";

vi.mock("./pages-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pages-api")>();
  return { ...actual, listRevisions: vi.fn(), getRevision: vi.fn() };
});

vi.mock("./scroll-restore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scroll-restore")>();
  return { ...actual, registerScrollAnchor: vi.fn(() => () => {}) };
});

const ID = "AAAAAAAAAAAAAAAAAAAAAA";
const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 17, 12, 0);

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });

const owner = { kind: "owner" } as const;
const agent = { kind: "token", tokenId: 3, name: "air-claude" } as const;

const REVISIONS: RevisionSummary[] = [
  { version: 5, title: "題", createdAt: NOW - 30 * MINUTE, author: owner },
  { version: 2, title: "旧題", createdAt: NOW - 120 * MINUTE, author: agent },
];

let root: Root | null = null;
let container: HTMLElement | null = null;
let restoreDelay: (() => void) | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  restoreDelay = setLoadingDelay(0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(listRevisions).mockResolvedValue(ok({ revisions: REVISIONS, nextCursor: null }));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  restoreDelay?.();
  vi.useRealTimers();
  vi.clearAllMocks();
});

interface Props {
  pageVersion?: number;
  updatedAt?: number;
  paused?: boolean;
}

async function mount({
  pageVersion = 5,
  updatedAt = NOW - 2 * MINUTE,
  paused = false,
}: Props = {}) {
  container ??= document.createElement("div");
  document.body.append(container);
  root ??= createRoot(container);
  await act(async () =>
    root?.render(
      <RevisionHistory
        pageId={ID}
        pageVersion={pageVersion}
        updatedAt={updatedAt}
        paused={paused}
      />,
    ),
  );
}

const entries = () =>
  [...(container?.querySelectorAll(".revision-entry") ?? [])].map((e) =>
    e.textContent?.replace(/ /g, " "),
  );

describe("authorLabel", () => {
  it("token と接続の名前には種類を前に付け、登録が消えた接続には決まった文を出す", () => {
    expect(authorLabel(owner)).toBe("オーナー");
    expect(authorLabel(agent)).toBe("token: air-claude");
    expect(authorLabel({ kind: "token", tokenId: null, name: "old" })).toBe("token: old");
    expect(authorLabel({ kind: "oauth", clientId: "c", name: "Claude" })).toBe("接続: Claude");
    expect(authorLabel({ kind: "oauth", clientId: "c", name: null })).toBe("登録が消えた接続");
    expect(authorLabel({ kind: "other", actor: "system" })).toBe("system");
  });

  it("「オーナー」と名乗る接続や token を、owner と同じ表示にしない", () => {
    const ownerLabel = authorLabel(owner);
    expect(authorLabel({ kind: "oauth", clientId: "c", name: "オーナー" })).not.toBe(ownerLabel);
    expect(authorLabel({ kind: "token", tokenId: 1, name: "オーナー" })).not.toBe(ownerLabel);
  });
});

describe("RevisionHistory の一覧", () => {
  it("版の番号を出さず、時刻と作成者を新しい順に並べる。先頭が今の版なら更新の時刻を出す", async () => {
    await mount();
    await vi.waitFor(() =>
      expect(entries()).toEqual(["2 分前オーナー", "約 2 時間前token: air-claude"]),
    );
    expect(container?.querySelector(".rail-label")?.textContent).toBe("履歴");
    expect(container?.textContent).not.toMatch(/[25]\s*版|v[25]/);
    expect(listRevisions).toHaveBeenCalledWith(ID, null);
  });

  it("先頭の版の後に公開範囲を切り替えていたら、先頭も編集を始めた時刻を出す", async () => {
    await mount({ pageVersion: 6 });
    await vi.waitFor(() => expect(entries()[0]).toBe("30 分前オーナー"));
  });

  it("版が進むと取り直し、その間も前の一覧と先頭の時刻を出したままにする", async () => {
    await mount();
    await vi.waitFor(() => expect(entries()).toHaveLength(2));
    const before = entries();
    let resolve: (value: ApiResult<RevisionList>) => void = () => {};
    vi.mocked(listRevisions).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await mount({ pageVersion: 7, updatedAt: NOW });
    expect(listRevisions).toHaveBeenCalledTimes(2);
    // 先頭の版の時刻は、一覧を取ったときのページの版と比べる。今の版と比べると、取り直しの間だけ
    // 編集を始めた時刻（30 分前）に変わって戻る
    expect(entries()).toEqual(before);
    expect(container?.querySelector(".skeleton-links")).toBeNull();
    const newest = { version: 7, title: "題", createdAt: NOW - MINUTE, author: owner };
    await act(async () => resolve(ok({ revisions: [newest, ...REVISIONS], nextCursor: null })));
    expect(entries()).toEqual([
      "1 分未満オーナー",
      "30 分前オーナー",
      "約 2 時間前token: air-claude",
    ]);
  });

  it("paused の間は取りに行かない", async () => {
    await mount({ paused: true });
    expect(listRevisions).not.toHaveBeenCalled();
  });

  it("続きがあれば「さらに表示」で cursor を渡して足す", async () => {
    vi.mocked(listRevisions).mockResolvedValueOnce(
      ok({ revisions: REVISIONS.slice(0, 1), nextCursor: "5" }),
    );
    vi.mocked(listRevisions).mockResolvedValueOnce(
      ok({ revisions: REVISIONS.slice(1), nextCursor: null }),
    );
    await mount();
    const more = await vi.waitFor(() => {
      const button = [...(container?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent === "さらに表示",
      );
      expect(button).toBeDefined();
      return button as HTMLButtonElement;
    });
    await act(async () => more.click());
    expect(listRevisions).toHaveBeenLastCalledWith(ID, "5");
    expect(entries()).toHaveLength(2);
    expect(container?.textContent).not.toContain("さらに表示");
  });

  async function loadedWithMore() {
    vi.mocked(listRevisions).mockResolvedValueOnce(
      ok({ revisions: REVISIONS.slice(0, 1), nextCursor: "5" }),
    );
    await mount();
    return vi.waitFor(() => {
      const button = [...(container?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent === "さらに表示",
      );
      expect(button).toBeDefined();
      return button as HTMLButtonElement;
    });
  }

  const newest = { version: 7, title: "題", createdAt: NOW - MINUTE, author: owner };

  it("「さらに表示」で足した行は、保存で取り直しても残る", async () => {
    const more = await loadedWithMore();
    vi.mocked(listRevisions).mockResolvedValueOnce(
      ok({ revisions: REVISIONS.slice(1), nextCursor: null }),
    );
    await act(async () => more.click());
    expect(entries()).toHaveLength(2);

    vi.mocked(listRevisions).mockResolvedValueOnce(
      ok({ revisions: [newest, REVISIONS[0] as RevisionSummary], nextCursor: "5" }),
    );
    await mount({ pageVersion: 7, updatedAt: NOW });
    await vi.waitFor(() => expect(entries()).toHaveLength(3));
    expect(entries()).toEqual([
      "1 分未満オーナー",
      "30 分前オーナー",
      "約 2 時間前token: air-claude",
    ]);
    expect(container?.textContent).not.toContain("さらに表示");
  });

  it("「さらに表示」を待つ間に取り直したら、続きの結果を捨てて新しい一覧を出す", async () => {
    const more = await loadedWithMore();
    let resolveMore: (value: ApiResult<RevisionList>) => void = () => {};
    vi.mocked(listRevisions).mockReturnValueOnce(
      new Promise((r) => {
        resolveMore = r;
      }),
    );
    await act(async () => more.click());

    vi.mocked(listRevisions).mockResolvedValueOnce(
      ok({ revisions: [newest, REVISIONS[0] as RevisionSummary], nextCursor: "5" }),
    );
    await mount({ pageVersion: 7, updatedAt: NOW });
    await vi.waitFor(() => expect(entries()[0]).toBe("1 分未満オーナー"));
    await act(async () => resolveMore(ok({ revisions: REVISIONS.slice(1), nextCursor: null })));
    expect(entries()).toEqual(["1 分未満オーナー", "30 分前オーナー"]);
    const again = [...(container?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "さらに表示",
    );
    expect(again?.disabled).toBe(false);
  });

  it("取得に失敗したら、その旨を出す", async () => {
    vi.mocked(listRevisions).mockResolvedValue({ ok: false, reason: "error", message: "x" });
    await mount();
    await vi.waitFor(() => expect(container?.textContent).toContain("取得できませんでした。"));
  });
});

describe("RevisionHistory の版の表示", () => {
  async function openEntry(index: number) {
    await mount();
    const entry = await vi.waitFor(() => {
      const found = container?.querySelectorAll<HTMLButtonElement>(".revision-entry")[index];
      expect(found).toBeDefined();
      return found as HTMLButtonElement;
    });
    await act(async () => entry.click());
    return container?.querySelector("dialog") as HTMLDialogElement;
  }

  it("押した版の title と本文を、読み取り専用のダイアログで出す", async () => {
    vi.mocked(getRevision).mockResolvedValue(
      ok({ ...(REVISIONS[1] as RevisionSummary), body: "# 見出し\n昔の本文" }),
    );
    const dialog = await openEntry(1);
    expect(getRevision).toHaveBeenCalledWith(ID, 2);
    expect(dialog.open).toBe(true);
    await vi.waitFor(() => expect(dialog.querySelector(".cm-content")).not.toBeNull());
    expect(dialog.querySelector("h2")?.textContent).toBe("旧題");
    expect(dialog.textContent).toContain("air-claude");
    expect(dialog.textContent).toContain("読み取り専用");
    const view = EditorView.findFromDOM(dialog.querySelector(".cm-editor") as HTMLElement);
    expect(view?.state.doc.toString()).toBe("# 見出し\n昔の本文");
    expect(view?.state.readOnly).toBe(true);
    // 画面の本文のスクロールの復元を、ダイアログの本文に奪わせない
    expect(registerScrollAnchor).not.toHaveBeenCalled();

    const close = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "閉じる");
    await act(async () => close?.click());
    expect(dialog.open).toBe(false);
    expect(dialog.querySelector(".cm-content")).toBeNull();
    const opener = container?.querySelectorAll(".revision-entry")[1];
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("版が無くなっていたら、その旨を出して一覧を取り直し、閉じると焦点を一覧の先頭に戻す", async () => {
    vi.mocked(getRevision).mockResolvedValue({ ok: false, reason: "revision_not_found" });
    // まとめで進むのは先頭の版だけなので、開いた版 5 は取り直した一覧では版 6 になっている
    const merged = { ...(REVISIONS[0] as RevisionSummary), version: 6 };
    vi.mocked(listRevisions)
      .mockResolvedValueOnce(ok({ revisions: REVISIONS, nextCursor: null }))
      .mockResolvedValue(
        ok({ revisions: [merged, REVISIONS[1] as RevisionSummary], nextCursor: null }),
      );
    const dialog = await openEntry(0);
    await vi.waitFor(() =>
      expect(dialog.querySelector("[role=status]")?.textContent).toContain(
        "この版は後の保存にまとめられたため、表示できません。",
      ),
    );
    expect(listRevisions).toHaveBeenCalledTimes(2);

    const close = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "閉じる");
    await act(async () => close?.click());
    const first = container?.querySelector(".revision-entry");
    await vi.waitFor(() => expect(document.activeElement).toBe(first));
  });

  it("ページが消えていたら、版がまとめられたとは言わず、一覧も取り直さない", async () => {
    vi.mocked(getRevision).mockResolvedValue({ ok: false, reason: "not_found" });
    const dialog = await openEntry(1);
    await vi.waitFor(() =>
      expect(dialog.querySelector("[role=status]")?.textContent).toBe(
        "このページは削除されたため、版を表示できません。",
      ),
    );
    expect(dialog.textContent).not.toContain("まとめられた");
    expect(listRevisions).toHaveBeenCalledTimes(1);
  });
});
