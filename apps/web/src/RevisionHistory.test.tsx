import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RestoreOutcome } from "./editor-session";
import { formatTime } from "./format";
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
const HOUR = 60 * MINUTE;
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
  onRestore?: (version: number) => Promise<RestoreOutcome>;
  canRestore?: boolean;
}

async function mount({
  pageVersion = 5,
  updatedAt = NOW - 2 * MINUTE,
  paused = false,
  onRestore,
  canRestore,
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
        {...(onRestore === undefined ? {} : { onRestore })}
        {...(canRestore === undefined ? {} : { canRestore })}
      />,
    ),
  );
}

/**
 * 一覧の各行の本文。絶対の時刻が本文に混ざるとコピーとページ内検索に出るので、
 * 読み上げにだけ届く絶対の時刻は stamps で確かめる
 */
const entries = () =>
  [...(container?.querySelectorAll(".revision-entry") ?? [])].map((e) =>
    (e.textContent ?? "").replace(/\u00a0/g, " "),
  );

const stamps = () =>
  [...(container?.querySelectorAll(".revision-time") ?? [])].map((time) =>
    time.getAttribute("data-absolute"),
  );

describe("authorLabel", () => {
  it("owner は「Web」、token と接続は名前だけを出し、登録が消えた接続には決まった文を出す", () => {
    expect(authorLabel(owner)).toBe("Web");
    expect(authorLabel(agent)).toBe("air-claude");
    expect(authorLabel({ kind: "token", tokenId: null, name: "old" })).toBe("old");
    expect(authorLabel({ kind: "oauth", clientId: "c", name: "Claude" })).toBe("Claude");
    expect(authorLabel({ kind: "oauth", clientId: "c", name: null })).toBe("登録が消えた接続");
    expect(authorLabel({ kind: "other", actor: "system" })).toBe("system");
  });
});

describe("RevisionHistory の一覧", () => {
  it("版の番号を出さず、時刻と作成者を新しい順に並べる。先頭が今の版なら更新の時刻を出す", async () => {
    await mount();
    await vi.waitFor(() => expect(entries()).toEqual(["2分前Web", "約2時間前air-claude"]));
    expect(container?.querySelector(".rail-label")?.textContent).toBe("履歴");
    expect(container?.textContent).not.toMatch(/[25]\s*版|v[25]/);
    expect(listRevisions).toHaveBeenCalledWith(ID, null);
  });

  it("先頭の版の後に公開範囲を切り替えていたら、先頭も編集を始めた時刻を出す", async () => {
    await mount({ pageVersion: 6 });
    await vi.waitFor(() => expect(entries()[0]).toBe("30分前Web"));
  });

  it("時刻の意味を、読み上げにだけ届く絶対の時刻と title に添える。先頭だけが最後の保存の時刻", async () => {
    await mount();
    await vi.waitFor(() => expect(entries()).toHaveLength(2));
    expect(stamps()).toEqual([
      `（最後に保存した時刻 ${formatTime(NOW - 2 * MINUTE)}）`,
      `（編集を始めた時刻 ${formatTime(NOW - 120 * MINUTE)}）`,
    ]);
    const titles = [...(container?.querySelectorAll(".revision-time") ?? [])].map((t) =>
      t.getAttribute("title"),
    );
    expect(titles).toEqual([
      `最後に保存した時刻 ${formatTime(NOW - 2 * MINUTE)}`,
      `編集を始めた時刻 ${formatTime(NOW - 120 * MINUTE)}`,
    ]);
  });

  it("先頭の版の後に公開範囲を切り替えていたら、先頭の絶対の時刻も編集を始めた時刻と伝える", async () => {
    await mount({ pageVersion: 6 });
    await vi.waitFor(() => expect(entries()).toHaveLength(2));
    expect(stamps()[0]).toBe(`（編集を始めた時刻 ${formatTime(NOW - 30 * MINUTE)}）`);
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
    expect(entries()).toEqual(["1分未満Web", "30分前Web", "約2時間前air-claude"]);
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
  const moreButton = () =>
    [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "さらに表示");

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
    expect(entries()).toEqual(["1分未満Web", "30分前Web", "約2時間前air-claude"]);
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
    await vi.waitFor(() => expect(entries()[0]).toBe("1分未満Web"));
    await act(async () => resolveMore(ok({ revisions: REVISIONS.slice(1), nextCursor: null })));
    expect(entries()).toEqual(["1分未満Web", "30分前Web"]);
    const again = [...(container?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "さらに表示",
    );
    expect(again?.disabled).toBe(false);
  });

  it("「さらに表示」を待つ間に取り直しが終わっても、続きが戻るまで重ねて押せない", async () => {
    const more = await loadedWithMore();
    let resolveMore: (value: ApiResult<RevisionList>) => void = () => {};
    vi.mocked(listRevisions).mockReturnValueOnce(
      new Promise((r) => {
        resolveMore = r;
      }),
    );
    await act(async () => more.click());
    expect(more.disabled).toBe(true);

    vi.mocked(listRevisions).mockResolvedValueOnce(
      ok({ revisions: [newest, REVISIONS[0] as RevisionSummary], nextCursor: "5" }),
    );
    await mount({ pageVersion: 7, updatedAt: NOW });
    await vi.waitFor(() => expect(entries()[0]).toBe("1分未満Web"));
    const calls = vi.mocked(listRevisions).mock.calls.length;
    expect(moreButton()?.disabled).toBe(true);
    await act(async () => moreButton()?.click());
    expect(listRevisions).toHaveBeenCalledTimes(calls);

    await act(async () => resolveMore(ok({ revisions: REVISIONS.slice(1), nextCursor: null })));
    expect(moreButton()?.disabled).toBe(false);
  });

  it("版がまとめられたと分かった後の取り直しが遅れて届いても、先に届いた新しい一覧に戻さない", async () => {
    vi.mocked(getRevision).mockResolvedValue({ ok: false, reason: "revision_not_found" });
    await mount();
    const entry = await vi.waitFor(() => {
      const found = container?.querySelector<HTMLButtonElement>(".revision-entry");
      expect(found).not.toBeNull();
      return found as HTMLButtonElement;
    });
    let resolveStale: (value: ApiResult<RevisionList>) => void = () => {};
    vi.mocked(listRevisions).mockReturnValueOnce(
      new Promise((r) => {
        resolveStale = r;
      }),
    );
    await act(async () => entry.click());
    expect(listRevisions).toHaveBeenCalledTimes(2);

    // 開いた版の取り直しが終わる前に保存が進み、保存の取り直しが先に終わる
    vi.mocked(listRevisions).mockResolvedValueOnce(
      ok({ revisions: [newest, ...REVISIONS], nextCursor: null }),
    );
    await mount({ pageVersion: 7, updatedAt: NOW });
    await vi.waitFor(() => expect(entries()).toHaveLength(3));

    await act(async () => resolveStale(ok({ revisions: REVISIONS, nextCursor: null })));
    expect(entries()).toEqual(["1分未満Web", "30分前Web", "約2時間前air-claude"]);
  });

  it("取得に失敗したら、その旨を出す", async () => {
    vi.mocked(listRevisions).mockResolvedValue({ ok: false, reason: "error", message: "x" });
    await mount();
    await vi.waitFor(() => expect(container?.textContent).toContain("取得できませんでした。"));
  });
});

describe("RevisionHistory の取り直しの間引き", () => {
  const newest = { version: 7, title: "題", createdAt: NOW - MINUTE, author: owner };

  /** 画面の外に出す。IntersectionObserver の結果が届くまで、描画を 2 回待つ */
  async function moveOffscreen(offscreen: boolean) {
    if (container === null) throw new Error("mount していない");
    container.style.cssText = offscreen ? "position: fixed; top: -10000px; left: 0" : "";
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 50));
  }

  async function mounted() {
    await mount();
    await vi.waitFor(() => expect(entries()).toHaveLength(2));
  }

  it("列が画面の外にある間は保存で取り直さず、見えたとき、取った後に進んでいれば追いつく", async () => {
    await mounted();
    await moveOffscreen(true);
    vi.mocked(listRevisions).mockResolvedValue(
      ok({ revisions: [newest, ...REVISIONS], nextCursor: null }),
    );
    await mount({ pageVersion: 7, updatedAt: NOW });
    await mount({ pageVersion: 8, updatedAt: NOW + MINUTE });
    expect(listRevisions).toHaveBeenCalledTimes(1);
    expect(entries()).toHaveLength(2);

    await moveOffscreen(false);
    await vi.waitFor(() => expect(entries()).toHaveLength(3));
    // 追いつくのは 1 回でよく、見えている間の取り直しは保存のたびに戻る
    expect(listRevisions).toHaveBeenCalledTimes(2);
  });

  it("画面の外へ出入りしただけでは、版が進んでいなければ取り直さない", async () => {
    await mounted();
    await moveOffscreen(true);
    await moveOffscreen(false);
    expect(listRevisions).toHaveBeenCalledTimes(1);
  });

  it("画面の外にいる間に取得が失敗していたら、見えたときにもう一度取る", async () => {
    vi.mocked(listRevisions).mockResolvedValueOnce({ ok: false, reason: "error", message: "x" });
    await mount();
    await vi.waitFor(() => expect(container?.textContent).toContain("取得できませんでした。"));
    await moveOffscreen(true);
    await moveOffscreen(false);
    await vi.waitFor(() => expect(entries()).toHaveLength(2));
    expect(listRevisions).toHaveBeenCalledTimes(2);
  });

  it("版を開いている間は、列が画面の外でも取り直す", async () => {
    vi.mocked(getRevision).mockResolvedValue(
      ok({ ...(REVISIONS[1] as RevisionSummary), body: "昔の本文" }),
    );
    await mounted();
    await moveOffscreen(true);
    const entry = container?.querySelectorAll<HTMLButtonElement>(".revision-entry")[1];
    await act(async () => entry?.click());
    vi.mocked(listRevisions).mockResolvedValue(
      ok({ revisions: [newest, ...REVISIONS], nextCursor: null }),
    );
    await mount({ pageVersion: 7, updatedAt: NOW });
    await vi.waitFor(() => expect(entries()).toHaveLength(3));
  });
});

const buttonNamed = (root: ParentNode, name: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === name);

/** 版のダイアログは差分から始まる。全文（読み取り専用のエディタ）は切り替えて見る */
async function showFull(dialog: HTMLDialogElement) {
  await vi.waitFor(() => expect(buttonNamed(dialog, "全文")).toBeDefined());
  await act(async () => buttonNamed(dialog, "全文")?.click());
}

const diffRows = (dialog: HTMLDialogElement) =>
  [...dialog.querySelectorAll(".revision-diff .diff-row")].map(
    (row) =>
      `${row.querySelector(".diff-mark")?.textContent}${row.querySelector(".diff-text")?.textContent}`,
  );

const bodyStatus = (dialog: HTMLDialogElement) =>
  dialog.querySelector(".revision-viewer-body [role=status]")?.textContent;

describe("RevisionHistory の版の表示", () => {
  async function openEntry(index: number, props: Props = {}) {
    await mount(props);
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
    await showFull(dialog);
    await vi.waitFor(() => expect(dialog.querySelector(".cm-content")).not.toBeNull());
    expect(dialog.querySelector("h2")?.textContent).toBe("旧題");
    expect(dialog.textContent).toContain("air-claude");
    expect(dialog.querySelector(".revision-viewer-meta")?.firstElementChild?.textContent).toBe(
      `編集を始めた時刻 ${formatTime(NOW - 120 * MINUTE)}`,
    );
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
      expect(bodyStatus(dialog)).toContain("この版は後の保存にまとめられたため、表示できません。"),
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
      expect(bodyStatus(dialog)).toBe("このページは削除されたため、版を表示できません。"),
    );
    expect(dialog.textContent).not.toContain("まとめられた");
    expect(listRevisions).toHaveBeenCalledTimes(1);
  });
});

describe("RevisionHistory の版の差分", () => {
  const rev = (version: number, title: string, body: string) => ({
    version,
    title,
    createdAt: NOW - version * MINUTE,
    author: owner,
    body,
  });
  const NEW = rev(5, "題", "共通\n新しい行\n末尾");
  const OLD = rev(2, "題", "共通\n古い行\n末尾");

  /** 版の番号で引く。取り違えると本文が合わず落ちる */
  function serve(...revisions: ReturnType<typeof rev>[]) {
    vi.mocked(getRevision).mockImplementation(async (_id, version) => {
      const found = revisions.find((r) => r.version === version);
      return found === undefined ? { ok: false, reason: "revision_not_found" } : ok(found);
    });
  }

  async function open(index: number) {
    await mount();
    const entry = await vi.waitFor(() => {
      const found = container?.querySelectorAll<HTMLButtonElement>(".revision-entry")[index];
      expect(found).toBeDefined();
      return found as HTMLButtonElement;
    });
    await act(async () => entry.click());
    return container?.querySelector("dialog") as HTMLDialogElement;
  }

  const close = async (dialog: HTMLDialogElement) => {
    await act(async () => buttonNamed(dialog, "閉じる")?.click());
  };

  it("既定は 1 つ古い版との差分で、番号から 1 を引かず一覧の次の行の版を取る", async () => {
    serve(NEW, OLD);
    const dialog = await open(0);
    await vi.waitFor(() => expect(diffRows(dialog)).toHaveLength(4));
    expect(getRevision).toHaveBeenCalledWith(ID, 5);
    expect(getRevision).toHaveBeenCalledWith(ID, 2);
    expect(diffRows(dialog)).toEqual([" 共通", "−古い行", "＋新しい行", " 末尾"]);
    expect(dialog.querySelector(".diff-legend")?.textContent).toContain("前の版だけにある行");
    expect(dialog.querySelector(".cm-content")).toBeNull();
    expect(buttonNamed(dialog, "差分")?.getAttribute("aria-pressed")).toBe("true");
    expect(buttonNamed(dialog, "全文")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("離れた同じ行は件数に畳む", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `行${i}`);
    serve(
      rev(5, "題", [...lines, "変更後"].join("\n")),
      rev(2, "題", [...lines, "変更前"].join("\n")),
    );
    const dialog = await open(0);
    await vi.waitFor(() => expect(diffRows(dialog).length).toBeGreaterThan(0));
    expect(dialog.querySelector(".diff-skip")?.textContent).toContain("10行は同じ");
    expect(diffRows(dialog)).toEqual([" 行10", " 行11", "−変更前", "＋変更後"]);
  });

  it("全文に切り替えるとエディタを出し、差分へ戻しても前の版を取り直さない", async () => {
    serve(NEW, OLD);
    const dialog = await open(0);
    await vi.waitFor(() => expect(diffRows(dialog)).toHaveLength(4));
    expect(getRevision).toHaveBeenCalledTimes(2);

    await act(async () => buttonNamed(dialog, "全文")?.click());
    await vi.waitFor(() => expect(dialog.querySelector(".cm-content")).not.toBeNull());
    expect(dialog.querySelector(".revision-diff")?.hasAttribute("hidden")).toBe(true);
    expect(buttonNamed(dialog, "全文")?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => buttonNamed(dialog, "差分")?.click());
    expect(dialog.querySelector(".cm-content")).toBeNull();
    expect(dialog.querySelector(".revision-diff")?.hasAttribute("hidden")).toBe(false);
    expect(diffRows(dialog)).toHaveLength(4);
    expect(getRevision).toHaveBeenCalledTimes(2);
  });

  it("開き直すと、全文を見ていても差分から始める", async () => {
    serve(NEW, OLD);
    const dialog = await open(0);
    await showFull(dialog);
    await close(dialog);
    const entry = container?.querySelectorAll<HTMLButtonElement>(".revision-entry")[0];
    await vi.waitFor(() => expect(document.activeElement).toBe(entry));
    await act(async () => entry?.click());
    await vi.waitFor(() => expect(diffRows(dialog)).toHaveLength(4));
    expect(dialog.querySelector(".cm-content")).toBeNull();
  });

  it("title が前の版と違えば、差分の上に両方を出す", async () => {
    serve(rev(5, "新題", "本文"), rev(2, "旧題", "本文"));
    const dialog = await open(0);
    await vi.waitFor(() => expect(dialog.querySelector(".revision-diff-titles")).not.toBeNull());
    expect(dialog.querySelector(".revision-diff-titles")?.textContent).toBe(
      "前の版のタイトル旧題この版のタイトル新題",
    );
    expect(dialog.querySelector(".revision-diff")?.textContent).toContain(
      "本文は前の版と同じです。",
    );
    expect(diffRows(dialog)).toEqual([]);
  });

  it("title も本文も同じなら、差分が無いと伝える", async () => {
    serve(rev(5, "題", "本文"), rev(2, "題", "本文"));
    const dialog = await open(0);
    await vi.waitFor(() =>
      expect(dialog.querySelector(".revision-diff")?.textContent).toContain(
        "前の版との差分はありません。",
      ),
    );
    expect(dialog.querySelector(".revision-diff-titles")).toBeNull();
  });

  it("最初の版は前が無いので、通信せずに本文の全行を足した行として出す", async () => {
    serve(NEW, rev(2, "旧題", "一行目\n\n三行目"));
    const dialog = await open(1);
    await vi.waitFor(() => expect(diffRows(dialog)).toHaveLength(3));
    expect(diffRows(dialog)).toEqual(["＋一行目", "＋ ", "＋三行目"]);
    expect(dialog.querySelector(".diff-legend")?.textContent).toContain("最初の版です");
    expect(getRevision).toHaveBeenCalledTimes(1);
    expect(listRevisions).toHaveBeenCalledTimes(1);
  });

  it("一覧の末尾の版は、続きの cursor で 1 つ古い版を探す", async () => {
    vi.mocked(listRevisions)
      .mockResolvedValueOnce(ok({ revisions: REVISIONS, nextCursor: "2" }))
      .mockResolvedValueOnce(
        ok({
          revisions: [{ version: 1, title: "題", createdAt: NOW - 3 * HOUR, author: owner }],
          nextCursor: null,
        }),
      );
    serve(NEW, OLD, rev(1, "題", "共通\n古い行\n最初"));
    const dialog = await open(1);
    await vi.waitFor(() => expect(diffRows(dialog)).toHaveLength(4));
    expect(listRevisions).toHaveBeenLastCalledWith(ID, "2");
    expect(getRevision).toHaveBeenLastCalledWith(ID, 1);
    expect(diffRows(dialog)).toEqual([" 共通", " 古い行", "−最初", "＋末尾"]);
  });

  it("続きの先が空なら最初の版として扱う", async () => {
    vi.mocked(listRevisions)
      .mockResolvedValueOnce(ok({ revisions: REVISIONS, nextCursor: "2" }))
      .mockResolvedValueOnce(ok({ revisions: [], nextCursor: null }));
    serve(NEW, OLD);
    const dialog = await open(1);
    await vi.waitFor(() =>
      expect(dialog.querySelector(".diff-legend")?.textContent).toContain("最初の版"),
    );
  });

  it("前の版が無くなっていたら、その旨を出して一覧を取り直す。全文は読める", async () => {
    serve(NEW);
    const dialog = await open(0);
    await vi.waitFor(() =>
      expect(dialog.querySelector(".revision-diff")?.textContent).toContain(
        "前の版が後の保存にまとめられたため、差分を表示できません。",
      ),
    );
    await vi.waitFor(() => expect(listRevisions).toHaveBeenCalledTimes(2));
    await showFull(dialog);
    await vi.waitFor(() => expect(dialog.querySelector(".cm-content")).not.toBeNull());
  });

  it("前の版の取得に失敗したら、理由を出して再試行できる", async () => {
    let attempts = 0;
    vi.mocked(getRevision).mockImplementation(async (_id, version) => {
      if (version === 5) return ok(NEW);
      attempts++;
      return attempts === 1
        ? { ok: false, reason: "error", message: "通信に失敗しました。" }
        : ok(OLD);
    });
    const dialog = await open(0);
    await vi.waitFor(() =>
      expect(dialog.querySelector(".revision-diff")?.textContent).toContain(
        "前の版を取得できませんでした。通信に失敗しました。",
      ),
    );
    await act(async () => buttonNamed(dialog, "再試行")?.click());
    await vi.waitFor(() => expect(diffRows(dialog)).toHaveLength(4));
    expect(dialog.querySelector(".revision-diff")?.textContent).not.toContain(
      "取得できませんでした",
    );
  });

  it("ページが消えていたら、版がまとめられたとは言わず、一覧も取り直さない", async () => {
    vi.mocked(getRevision).mockImplementation(async (_id, version) =>
      version === 5 ? ok(NEW) : { ok: false, reason: "not_found" },
    );
    const dialog = await open(0);
    await vi.waitFor(() =>
      expect(dialog.querySelector(".revision-diff")?.textContent).toContain(
        "このページは削除されたため、前の版を表示できません。",
      ),
    );
    expect(listRevisions).toHaveBeenCalledTimes(1);
  });

  it("閉じた後に届いた前の版は捨て、別の版を開いていれば、その版の差分だけを出す", async () => {
    let resolvePrevious: (value: ApiResult<typeof OLD>) => void = () => {};
    vi.mocked(getRevision).mockImplementation((_id, version) =>
      version === 2
        ? new Promise((r) => {
            resolvePrevious = r;
          })
        : Promise.resolve(ok(NEW)),
    );
    const dialog = await open(0);
    await vi.waitFor(() => expect(getRevision).toHaveBeenCalledWith(ID, 2));
    await close(dialog);
    const entries = container?.querySelectorAll<HTMLButtonElement>(".revision-entry");
    await vi.waitFor(() => expect(document.activeElement).toBe(entries?.[0]));
    vi.mocked(getRevision).mockImplementation(async () => ok(OLD));
    await act(async () => entries?.[1]?.click());
    await vi.waitFor(() =>
      expect(dialog.querySelector(".diff-legend")?.textContent).toContain("最初の版"),
    );
    const rows = diffRows(dialog);

    await act(async () => resolvePrevious(ok(OLD)));
    expect(diffRows(dialog)).toEqual(rows);
    expect(dialog.querySelector(".diff-legend")?.textContent).toContain("最初の版");
  });

  it("一覧を開いただけでは、版も前の版も取らない", async () => {
    serve(NEW, OLD);
    await mount();
    await vi.waitFor(() => expect(entries()).toHaveLength(2));
    expect(getRevision).not.toHaveBeenCalled();
  });
});

describe("RevisionHistory の版を戻す操作", () => {
  const OLD = { ...(REVISIONS[1] as RevisionSummary), body: "昔の本文" };

  async function openOld(props: Props) {
    vi.mocked(getRevision).mockResolvedValue(ok(OLD));
    await mount(props);
    const entry = await vi.waitFor(() => {
      const found = container?.querySelectorAll<HTMLButtonElement>(".revision-entry")[1];
      expect(found).toBeDefined();
      return found as HTMLButtonElement;
    });
    await act(async () => entry.click());
    const dialog = container?.querySelector("dialog") as HTMLDialogElement;
    await vi.waitFor(() => expect(buttonNamed(dialog, "全文")).toBeDefined());
    return dialog;
  }

  const restoreButton = (dialog: HTMLDialogElement) =>
    [...dialog.querySelectorAll("button")].find((b) => b.textContent === "この版の本文に戻す");
  const note = (dialog: HTMLDialogElement) =>
    dialog.querySelector(".revision-viewer-status")?.textContent;

  it("先頭の版と、onRestore を渡さないときは出さない", async () => {
    vi.mocked(getRevision).mockResolvedValue(
      ok({ ...(REVISIONS[0] as RevisionSummary), body: "今" }),
    );
    await mount({ onRestore: vi.fn() });
    const head = await vi.waitFor(() => {
      const found = container?.querySelector<HTMLButtonElement>(".revision-entry");
      expect(found).not.toBeNull();
      return found as HTMLButtonElement;
    });
    await act(async () => head.click());
    const dialog = container?.querySelector("dialog") as HTMLDialogElement;
    await vi.waitFor(() => expect(buttonNamed(dialog, "全文")).toBeDefined());
    expect(restoreButton(dialog)).toBeUndefined();
    act(() => root?.unmount());
    root = null;

    const plain = await openOld({});
    expect(restoreButton(plain)).toBeUndefined();
  });

  it("古い版で押すと、その版の番号で戻し、結果を伝えてボタンを下げる", async () => {
    let finish: (outcome: RestoreOutcome) => void = () => {};
    const onRestore = vi.fn(
      () =>
        new Promise<RestoreOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const dialog = await openOld({ onRestore });
    restoreButton(dialog)?.focus();
    expect(document.activeElement?.textContent).toBe("この版の本文に戻す");
    await act(async () => restoreButton(dialog)?.click());
    expect(onRestore).toHaveBeenCalledWith(2);
    const pending = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "戻し中…");
    expect(pending?.disabled).toBe(true);

    await act(async () => finish({ ok: true, changed: true }));
    expect(note(dialog)).toBe(
      "この版の本文に戻しました。戻す前の本文は履歴に残っているので、そこから戻し直せます。",
    );
    expect(restoreButton(dialog)).toBeUndefined();
    expect(dialog.open).toBe(true);
    // 押したボタンが消えても、焦点をダイアログの中に残す
    expect(document.activeElement?.textContent).toBe("閉じる");
  });

  it("本文が今と同じなら、そう伝えてボタンを下げる", async () => {
    const dialog = await openOld({
      onRestore: vi.fn(async () => ({ ok: true, changed: false }) as const),
    });
    await act(async () => restoreButton(dialog)?.click());
    expect(note(dialog)).toBe("今の本文はこの版と同じです。");
    expect(restoreButton(dialog)).toBeUndefined();
  });

  it("canRestore が false の間は押せない", async () => {
    const dialog = await openOld({ onRestore: vi.fn(), canRestore: false });
    expect(restoreButton(dialog)?.disabled).toBe(true);
  });

  it.each([
    [{ ok: false, reason: "unsaved" }, "未保存の変更を保存できなかったため、戻していません。"],
    [
      { ok: false, reason: "conflict" },
      "別の場所で更新されていたため、戻していません。最新の内容を読み込んだので、もう一度試してください。",
    ],
    [{ ok: false, reason: "unauthorized" }, "ログインの期限が切れたため、戻せませんでした。"],
    [
      { ok: false, reason: "error", message: "通信に失敗しました。" },
      "戻せませんでした。通信に失敗しました。",
    ],
  ] satisfies Array<[RestoreOutcome, string]>)(
    "%o は文で伝え、もう一度押せる",
    async (outcome, text) => {
      const dialog = await openOld({ onRestore: vi.fn(async () => outcome) });
      await act(async () => restoreButton(dialog)?.click());
      expect(note(dialog)).toBe(text);
      expect(restoreButton(dialog)?.disabled).toBe(false);
    },
  );

  it("版がまとめられていたら、その旨を出して一覧を取り直す", async () => {
    const dialog = await openOld({
      onRestore: vi.fn(async () => ({ ok: false, reason: "revision_not_found" }) as const),
    });
    await act(async () => restoreButton(dialog)?.click());
    expect(note(dialog)).toBe("戻せませんでした。");
    expect(bodyStatus(dialog)).toContain("この版は後の保存にまとめられたため");
    expect(restoreButton(dialog)).toBeUndefined();
    await vi.waitFor(() => expect(listRevisions).toHaveBeenCalledTimes(2));
  });

  it("ページが消えていたら、その旨を出す", async () => {
    const dialog = await openOld({
      onRestore: vi.fn(async () => ({ ok: false, reason: "gone" }) as const),
    });
    await act(async () => restoreButton(dialog)?.click());
    expect(bodyStatus(dialog)).toBe("このページは削除されたため、版を表示できません。");
    expect(listRevisions).toHaveBeenCalledTimes(1);
  });

  it("閉じて開き直すと、前の結果の文を残さない", async () => {
    const dialog = await openOld({
      onRestore: vi.fn(async () => ({ ok: false, reason: "unsaved" }) as const),
    });
    await act(async () => restoreButton(dialog)?.click());
    expect(note(dialog)).not.toBe("");
    const close = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "閉じる");
    await act(async () => close?.click());
    const entry = container?.querySelectorAll<HTMLButtonElement>(".revision-entry")[1];
    // dialog の close イベントは閉じた後の別タスクで届く。焦点が戻るまでにそのイベントを処理済みになる。
    // 待たずに開き直すと、遅れて届いたイベントが開き直したばかりの版を閉じてしまう
    await vi.waitFor(() => expect(document.activeElement).toBe(entry));
    await act(async () => entry?.click());
    await vi.waitFor(() => expect(buttonNamed(dialog, "全文")).toBeDefined());
    expect(note(dialog)).toBe("");
  });
});
