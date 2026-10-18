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
    await vi.waitFor(() => expect(dialog.querySelector(".cm-content")).not.toBeNull());
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
    await vi.waitFor(() => expect(dialog.querySelector(".cm-content")).not.toBeNull());
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
    await vi.waitFor(() => expect(dialog.querySelector(".cm-content")).not.toBeNull());
    expect(note(dialog)).toBe("");
  });
});
