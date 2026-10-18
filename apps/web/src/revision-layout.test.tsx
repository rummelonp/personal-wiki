import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { setLoadingDelay } from "./Loading";
import { type ApiResult, getRevision, listRevisions, type RevisionSummary } from "./pages-api";
import { RevisionHistory } from "./RevisionHistory";
import { titleBaselineGaps } from "./test-baseline";
import "./theme.css";
import "./styles.css";

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
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 17, 12, 0);

const LONG_NAME = "Claude Code (personal-wiki) with a very long connection name";

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });

// 時刻の文字数が行ごとに違い（30分前、約2時間前、12日前、1年以上前）、名前の長さも違う
const REVISIONS: RevisionSummary[] = [
  { version: 4, title: "題", createdAt: NOW - 30 * MINUTE, author: { kind: "owner" } },
  {
    version: 3,
    title: "題",
    createdAt: NOW - 2 * HOUR,
    author: { kind: "oauth", clientId: "c", name: LONG_NAME },
  },
  {
    version: 2,
    title: "題",
    createdAt: NOW - 12 * DAY,
    author: { kind: "token", tokenId: 3, name: "air-claude" },
  },
  {
    version: 1,
    title: "題",
    createdAt: NOW - 400 * DAY,
    author: { kind: "oauth", clientId: "c", name: LONG_NAME },
  },
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

/** 右の列（.rail > .rail-inner）に入れて、実際の幅と overflow で測る */
async function mount(width: string, first: RevisionSummary[], nextCursor: string | null = null) {
  vi.mocked(listRevisions).mockResolvedValue(ok({ revisions: first, nextCursor }));
  container = document.createElement("div");
  container.className = "rail";
  container.style.width = width;
  const inner = document.createElement("div");
  inner.className = "rail-inner";
  container.append(inner);
  document.body.append(container);
  root = createRoot(inner);
  await act(async () =>
    root?.render(
      <RevisionHistory pageId={ID} pageVersion={4} updatedAt={NOW - 2 * MINUTE} paused={false} />,
    ),
  );
  await vi.waitFor(() =>
    expect(container?.querySelectorAll(".revision-entry")).toHaveLength(first.length),
  );
}

const all = (selector: string) => [...(container?.querySelectorAll(selector) ?? [])];
const rounded = (values: number[]) => new Set(values.map((v) => Math.round(v)));
const heights = () => all(".revision-entry").map((e) => e.getBoundingClientRect().height);
const authorLefts = () => all(".revision-author").map((e) => e.getBoundingClientRect().left);

describe("履歴の行の並び", () => {
  it("名前が長くても行は 1 行のままで、行の高さと作成者の左端がどの行でもそろう", async () => {
    await mount("var(--rail-width)", REVISIONS);
    expect(rounded(heights()).size).toBe(1);

    // 時刻の文字数が行ごとに違っても、作成者は同じ位置から始まる
    expect(new Set(all(".revision-time").map((e) => e.textContent?.length)).size).toBeGreaterThan(
      1,
    );
    expect(rounded(authorLefts()).size).toBe(1);
  });

  it("時刻の列は最も広い時刻に合わせ、収まらない作成者は省略して、元の名前を title に残す", async () => {
    await mount("var(--rail-width)", REVISIONS);
    const list = container?.querySelector(".revision-list")?.getBoundingClientRect();
    if (!list) throw new Error("一覧が無い");
    const widest = Math.max(
      ...all(".revision-time").map((e) => {
        const range = document.createRange();
        range.selectNodeContents(e);
        return range.getBoundingClientRect().width;
      }),
    );
    // 時刻の列は縮まない。最も広い時刻の分だけ作成者が右にずれる
    expect((authorLefts()[0] ?? 0) - list.left).toBeGreaterThanOrEqual(widest);

    const long = all(".revision-author")[1] as HTMLElement;
    expect(long.scrollWidth).toBeGreaterThan(long.clientWidth);
    expect(getComputedStyle(long).textOverflow).toBe("ellipsis");
    expect(long.getBoundingClientRect().right).toBeLessThanOrEqual(list.right);
    expect(long.getAttribute("title")).toBe(LONG_NAME);
    expect(long.textContent).toBe(LONG_NAME);
  });

  it("列に横のスクロールが出ず、行は列の幅に収まる。焦点の輪は内側に引いて列に切られない", async () => {
    await mount("var(--rail-width)", REVISIONS);
    const inner = container?.querySelector<HTMLElement>(".rail-inner");
    if (!inner) throw new Error("列が無い");
    expect(inner.scrollWidth).toBeLessThanOrEqual(inner.clientWidth);
    const entry = all(".revision-entry")[0] as HTMLElement;
    const box = entry.getBoundingClientRect();
    const rail = inner.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(rail.left);
    expect(box.right).toBeLessThanOrEqual(rail.right);
    // キーボードの焦点だけが :focus-visible の輪を出す
    await userEvent.tab();
    expect(document.activeElement).toBe(entry);
    expect(entry.matches(":focus-visible")).toBe(true);
    expect(Number.parseFloat(getComputedStyle(entry).outlineOffset)).toBeLessThan(0);
  });

  it("「さらに表示」で足した行も、同じ 1 行で列にそろう", async () => {
    await mount("var(--rail-width)", REVISIONS.slice(0, 2), "2");
    vi.mocked(listRevisions).mockResolvedValueOnce(
      ok({ revisions: REVISIONS.slice(2), nextCursor: null }),
    );
    const more = all("button").find((b) => b.textContent?.includes("さらに表示"));
    await act(async () => (more as HTMLButtonElement | undefined)?.click());
    await vi.waitFor(() => expect(all(".revision-entry")).toHaveLength(REVISIONS.length));
    expect(rounded(heights()).size).toBe(1);
    expect(rounded(authorLefts()).size).toBe(1);
  });

  it("列が狭い画面で本文の下に回り、幅いっぱいに広がっても崩れない", async () => {
    await mount("20rem", REVISIONS);
    expect(rounded(heights()).size).toBe(1);
    expect(rounded(authorLefts()).size).toBe(1);
    const long = all(".revision-author")[1] as HTMLElement;
    expect(long.scrollWidth).toBeGreaterThan(long.clientWidth);
  });
});

describe("版の差分の並び", () => {
  const LONG_WORD = `https://example.com/${"a".repeat(200)}`;
  const LONG_TEXT = "長い日本語の行がダイアログの幅を超えても折り返して全部を読めること。".repeat(
    8,
  );

  async function openDiff(width: string) {
    const body = (text: string) => `共通\n${text}\n末尾`;
    vi.mocked(getRevision).mockImplementation(async (_id, version) => ({
      ok: true,
      value: {
        ...(REVISIONS.find((r) => r.version === version) as RevisionSummary),
        body: version === 4 ? body(`${LONG_WORD} ${LONG_TEXT}`) : body(LONG_TEXT),
      },
    }));
    await mount(width, REVISIONS);
    await act(async () => (all(".revision-entry")[0] as HTMLElement).click());
    await vi.waitFor(() => expect(all(".revision-viewer .diff-row").length).toBeGreaterThan(0));
    const dialog = document.querySelector<HTMLElement>(".revision-viewer");
    if (!dialog) throw new Error("ダイアログが無い");
    return dialog;
  }

  it("長い行は折り返し、横のスクロールを出さずダイアログの幅に収まる", async () => {
    const dialog = await openDiff("var(--rail-width)");
    const body = dialog.querySelector<HTMLElement>(".revision-viewer-body");
    if (!body) throw new Error("本文が無い");
    expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth);
    const frame = dialog.getBoundingClientRect();
    for (const row of dialog.querySelectorAll(".diff-row")) {
      const box = row.getBoundingClientRect();
      expect(box.right).toBeLessThanOrEqual(frame.right);
      expect(box.left).toBeGreaterThanOrEqual(frame.left);
    }
    // 折り返して 1 行より高くなる
    const changed = dialog.querySelector<HTMLElement>(".diff-insert");
    const line = Number.parseFloat(getComputedStyle(changed as HTMLElement).lineHeight);
    expect((changed as HTMLElement).getBoundingClientRect().height).toBeGreaterThan(line * 2);
  });

  type Fixture = { title: string; body: string };

  /** 版の番号ごとの内容で一覧の index 行を開く。返す内容が無い版は取得の失敗にする */
  async function openEntry(index: number, versions: Record<number, Fixture>) {
    vi.mocked(getRevision).mockImplementation(async (_id, version) => {
      const found = versions[version];
      if (found === undefined) return { ok: false, reason: "error", message: "失敗" };
      const summary = REVISIONS.find((r) => r.version === version) as RevisionSummary;
      return { ok: true, value: { ...summary, ...found } };
    });
    await mount("var(--rail-width)", REVISIONS);
    await act(async () => (all(".revision-entry")[index] as HTMLElement).click());
    const dialog = document.querySelector<HTMLElement>(".revision-viewer");
    if (!dialog) throw new Error("ダイアログが無い");
    return dialog;
  }

  /** 切り替えの下端から、その下の最初の内容の上端までの距離 */
  function gapBelowSwitch(dialog: HTMLElement) {
    const switcher = dialog.querySelector<HTMLElement>(".segmented");
    const body = dialog.querySelector<HTMLElement>(".revision-viewer-body");
    if (!switcher || !body) throw new Error("切り替えか本文が無い");
    const first = [...body.children].find((c) => c.getBoundingClientRect().height > 0);
    if (!first) throw new Error("本文に内容が無い");
    return first.getBoundingClientRect().top - switcher.getBoundingClientRect().bottom;
  }

  function space3() {
    const probe = document.createElement("div");
    probe.style.height = "var(--space-3)";
    document.body.append(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return height;
  }

  const SAME = { title: "題", body: "共通\n末尾" };
  const CHANGED = { title: "題", body: "共通\n変更後\n末尾" };

  it("切り替えと本文の間は、どの表示でも同じ余白になる", async () => {
    const cases: [string, number, Record<number, Fixture>, () => string][] = [
      ["差分だけ", 0, { 4: CHANGED, 3: SAME }, () => ".diff-row"],
      [
        "title の違いも出す",
        0,
        { 4: { ...CHANGED, title: "新題" }, 3: SAME },
        () => ".conflict-titles",
      ],
      ["title だけ違う", 0, { 4: { ...SAME, title: "新題" }, 3: SAME }, () => ".diff-legend"],
      ["最初の版", 3, { 1: CHANGED }, () => ".diff-legend"],
      ["前の版の取得に失敗", 0, { 4: CHANGED }, () => ".revision-diff-error"],
    ];
    const expected = space3();
    for (const [name, index, versions, ready] of cases) {
      const dialog = await openEntry(index, versions);
      await vi.waitFor(() => expect(dialog.querySelector(ready())).not.toBeNull());
      expect(gapBelowSwitch(dialog), name).toBeCloseTo(expected, 1);
      act(() => root?.unmount());
      container?.remove();
      root = null;
      container = null;
    }

    const dialog = await openEntry(0, { 4: CHANGED, 3: SAME });
    await vi.waitFor(() => expect(dialog.querySelector(".diff-row")).not.toBeNull());
    const full = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "全文");
    await act(async () => (full as HTMLButtonElement).click());
    await vi.waitFor(() => expect(dialog.querySelector(".revision-viewer-prose")).not.toBeNull());
    expect(gapBelowSwitch(dialog), "全文").toBeCloseTo(expected, 1);
  });

  it.each([
    ["1 行の title", "新題"],
    ["折り返す title", "とても長い題名が欄の幅で折り返して複数の行になる場合の例".repeat(3)],
  ])("title の違いの見出しは、%sでも名前と title の文字の下端がそろう", async (_, title) => {
    const dialog = await openEntry(0, { 4: { ...SAME, title }, 3: SAME });
    await vi.waitFor(() => expect(dialog.querySelector(".revision-diff-titles")).not.toBeNull());
    const titles = dialog.querySelector(".revision-diff-titles") as Element;
    const gaps = titleBaselineGaps(titles);
    expect(gaps).toHaveLength(2);
    for (const gap of gaps) expect(gap).toBeLessThanOrEqual(1);
  });

  it("差分が無いと伝える文は、凡例と同じ大きさで出す", async () => {
    const dialog = await openEntry(0, { 4: { ...SAME, title: "新題" }, 3: SAME });
    await vi.waitFor(() => expect(dialog.textContent).toContain("本文は前の版と同じです。"));
    const note = [...dialog.querySelectorAll<HTMLElement>(".revision-diff p")].find((p) =>
      p.textContent?.includes("本文は前の版と同じです。"),
    );
    const probe = document.createElement("p");
    probe.style.fontSize = "var(--font-size-sm)";
    dialog.append(probe);
    const small = getComputedStyle(probe).fontSize;
    probe.remove();
    expect(getComputedStyle(note as HTMLElement).fontSize).toBe(small);
  });

  it("切り替えはスクロールする欄の外にあり、本文をスクロールしても動かない", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `行${i}`).join("\n");
    const dialog = await openEntry(0, { 4: { title: "題", body: lines }, 3: SAME });
    await vi.waitFor(() => expect(dialog.querySelector(".diff-row")).not.toBeNull());
    const body = dialog.querySelector<HTMLElement>(".revision-viewer-body");
    const switcher = dialog.querySelector<HTMLElement>(".segmented");
    if (!body || !switcher) throw new Error("切り替えか本文が無い");
    expect(body.contains(switcher)).toBe(false);
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    const before = switcher.getBoundingClientRect().top;
    body.scrollTop = body.scrollHeight;
    expect(switcher.getBoundingClientRect().top).toBe(before);
    // 本文の欄の余白はスクロールで流れるので、見えている欄の上端との距離で間が残ることを確かめる
    expect(body.getBoundingClientRect().top - switcher.getBoundingClientRect().bottom).toBeCloseTo(
      space3(),
      1,
    );
  });
});
