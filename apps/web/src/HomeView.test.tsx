import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeView } from "./HomeView";
import { setLoadingDelay } from "./Loading";
import { openNewPage } from "./new-page";
import { type ApiResult, listRecent, listTags, searchPages } from "./pages-api";
import type { VisibilityFilter } from "./route";
import { useEntryList } from "./useEntryList";

vi.mock("./pages-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pages-api")>();
  return {
    ...actual,
    listRecent: vi.fn(),
    listTags: vi.fn(),
    searchPages: vi.fn(),
  };
});

vi.mock("./new-page", () => ({ openNewPage: vi.fn() }));

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });

const summary = (id: string, title: string) => ({
  id,
  title,
  visibility: "public" as const,
  updatedAt: 0,
  tags: [],
});

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.mocked(listTags).mockResolvedValue(ok([]));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

async function mountHome(
  query: string,
  owner: boolean,
  tag = "",
  visibility: VisibilityFilter = "",
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(<HomeView query={query} tag={tag} visibility={visibility} owner={owner} />),
  );
}

async function renderHome(query: string, owner = true) {
  await mountHome(query, owner);
  await vi.waitFor(() => expect(container?.querySelector(".entries")).not.toBeNull());
}

const marks = (selector: string) =>
  [...(container?.querySelectorAll(`${selector} mark`) ?? [])].map((mark) => mark.textContent);

describe("HomeView の強調", () => {
  it("検索結果の title と抜粋で、検索語に当たった箇所を mark にする", async () => {
    vi.mocked(searchPages).mockResolvedValue(
      ok([
        {
          ...summary("AAAAAAAAAAAAAAAAAAAAAA", "Hono のメモ"),
          excerpt: "…サーバーは hono で書く。HONO の router…",
        },
        { ...summary("BBBBBBBBBBBBBBBBBBBBBB", "買い物"), excerpt: "牛乳と卵の hono ではない話" },
      ]),
    );
    await renderHome("hono");
    expect(searchPages).toHaveBeenCalledWith("hono");

    const rows = [...(container?.querySelectorAll(".entry") ?? [])];
    expect(rows).toHaveLength(2);
    expect(
      [...(rows[0]?.querySelectorAll(".entry-title mark") ?? [])].map((m) => m.textContent),
    ).toEqual(["Hono"]);
    expect(
      [...(rows[0]?.querySelectorAll(".entry-excerpt mark") ?? [])].map((m) => m.textContent),
    ).toEqual(["hono", "HONO"]);
    // title に当たらない行の title は強調しない
    expect(rows[1]?.querySelector(".entry-title mark")).toBeNull();
    expect(rows[1]?.querySelector(".entry-title")?.textContent).toBe("買い物");
  });

  it("空白を含む検索語は、API が照合する並びのまま当てる", async () => {
    vi.mocked(searchPages).mockResolvedValue(
      ok([{ ...summary("AAAAAAAAAAAAAAAAAAAAAA", "メモ"), excerpt: "foo bar と bar foo と foo" }]),
    );
    await renderHome("foo bar");
    expect(marks(".entry-excerpt")).toEqual(["foo bar"]);
  });

  it("検索結果の title と抜粋を HTML として解釈しない", async () => {
    vi.mocked(searchPages).mockResolvedValue(
      ok([
        {
          ...summary("AAAAAAAAAAAAAAAAAAAAAA", "<img src=x onerror=alert(1)>"),
          excerpt: "<script>alert(1)</script> img",
        },
      ]),
    );
    await renderHome("img");
    expect(container?.querySelector("img, script")).toBeNull();
    expect(container?.querySelector(".entry-title")?.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
    expect(marks(".entry-title")).toEqual(["img"]);
    expect(marks(".entry-excerpt")).toEqual(["img"]);
  });

  it("API が検索語を受け付けなかったときは、取得の失敗ではなく語を直す案内を出す", async () => {
    vi.mocked(searchPages).mockResolvedValue({
      ok: false,
      reason: "invalid_query",
      message: "検索語が長すぎます。短くしてください。",
    });
    await mountHome("長い語", true);
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("この検索語では検索できません"),
    );
    expect(container?.textContent).toContain("検索語が長すぎます。短くしてください。");
    expect(container?.textContent).not.toContain("一覧を取得できませんでした");
  });

  it("最近の更新（検索語が無い）では強調しない", async () => {
    vi.mocked(listRecent).mockResolvedValue(
      ok({
        pages: [{ ...summary("AAAAAAAAAAAAAAAAAAAAAA", "Hono のメモ"), excerpt: "hono の話" }],
        nextCursor: null,
      }),
    );
    await renderHome("");
    expect(container?.querySelector(".entry-title")?.textContent).toBe("Hono のメモ");
    expect(container?.querySelector("mark")).toBeNull();
  });
});

describe("useEntryList の条件の切り替え", () => {
  it("タグを変えた最初の描画で、前の条件の一覧を ready のまま返さない", async () => {
    vi.mocked(listRecent).mockResolvedValueOnce(
      ok({ pages: [summary("AAAAAAAAAAAAAAAAAAAAAA", "前の一覧")], nextCursor: null }),
    );
    vi.mocked(listRecent).mockReturnValueOnce(new Promise(() => {}));
    const seen: { tag: string; status: string }[] = [];
    function Probe({ tag }: { tag: string }) {
      seen.push({
        tag,
        status: useEntryList({ query: "", tag, visibility: "", owner: true }).state.status,
      });
      return null;
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Probe tag="" />));
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ tag: "", status: "ready" }));
    await act(async () => root?.render(<Probe tag="x" />));
    expect(seen.filter((s) => s.tag === "x").map((s) => s.status)).not.toContain("ready");
  });
});

describe("条件を変えて取り直している間の一覧", () => {
  const prev = [summary("AAAAAAAAAAAAAAAAAAAAAA", "前の一覧")];

  async function mountProbe() {
    const seen: { tag: string; status: string; previous: string[] | undefined }[] = [];
    function Probe({ tag }: { tag: string }) {
      const { state } = useEntryList({ query: "", tag, visibility: "", owner: true });
      seen.push({
        tag,
        status: state.status,
        previous:
          state.status === "loading" ? state.previous?.entries.map((e) => e.title) : undefined,
      });
      return null;
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Probe tag="" />));
    await vi.waitFor(() => expect(seen.at(-1)?.status).toBe("ready"));
    await act(async () => root?.render(<Probe tag="x" />));
    return seen;
  }

  it("status は loading のまま、前の一覧を previous に持つ", async () => {
    vi.mocked(listRecent).mockResolvedValueOnce(ok({ pages: prev, nextCursor: null }));
    vi.mocked(listRecent).mockReturnValueOnce(new Promise(() => {}));
    const seen = await mountProbe();
    const afterChange = seen.filter((s) => s.tag === "x");
    // 条件が変わった描画と、取り直しを始めた描画の両方で、前の一覧が残る
    expect(afterChange.length).toBeGreaterThan(0);
    for (const s of afterChange) {
      expect(s.status).toBe("loading");
      expect(s.previous).toEqual(["前の一覧"]);
    }
  });

  it("前の一覧が空なら previous は持たず、スケルトンを出す", async () => {
    vi.mocked(listRecent).mockResolvedValueOnce(ok({ pages: [], nextCursor: null }));
    vi.mocked(listRecent).mockReturnValueOnce(new Promise(() => {}));
    const seen = await mountProbe();
    expect(seen.filter((s) => s.tag === "x").every((s) => s.previous === undefined)).toBe(true);
  });

  it("HomeView は前の行を残して aria-busy にし、届いたら新しい行に替える", async () => {
    const restore = setLoadingDelay(0);
    try {
      let deliver: (v: ApiResult<{ pages: never[]; nextCursor: null }>) => void = () => {};
      vi.mocked(listRecent).mockResolvedValueOnce(ok({ pages: prev, nextCursor: null }));
      vi.mocked(listRecent).mockReturnValueOnce(
        new Promise((resolve) => {
          deliver = resolve as never;
        }),
      );
      await mountHome("", true);
      await vi.waitFor(() => expect(container?.querySelector(".entries .entry")).not.toBeNull());
      await act(async () => root?.render(<HomeView query="" tag="x" visibility="" owner={true} />));
      expect(container?.querySelector(".home")?.getAttribute("aria-busy")).toBe("true");
      expect(container?.querySelector(".entries-stale .entry-title")?.textContent).toBe("前の一覧");
      expect(container?.querySelector(".entries-stale.skeleton-painted")).not.toBeNull();
      expect(container?.querySelector(".skeleton-entries")).toBeNull();
      await vi.waitFor(() =>
        expect(container?.querySelector("[role='status']")?.textContent).toBe("一覧を読み込み中…"),
      );

      await act(async () =>
        deliver(
          ok({
            pages: [summary("BBBBBBBBBBBBBBBBBBBBBB", "新しい一覧")] as never,
            nextCursor: null,
          }),
        ),
      );
      expect(container?.querySelector(".entries-stale")).toBeNull();
      expect(container?.querySelector(".entries .entry-title")?.textContent).toBe("新しい一覧");
      expect(container?.querySelector(".home")?.getAttribute("aria-busy")).toBeNull();
    } finally {
      restore();
    }
  });

  it("「さらに表示」は読み込み中も同じ文字で disabled のまま、末尾にスケルトンの行を足す", async () => {
    const restore = setLoadingDelay(0);
    try {
      vi.mocked(listRecent).mockResolvedValueOnce(ok({ pages: prev, nextCursor: "c1" }));
      vi.mocked(listRecent).mockReturnValueOnce(new Promise(() => {}));
      await mountHome("", true);
      await vi.waitFor(() => expect(container?.querySelector(".entries .entry")).not.toBeNull());
      const button = () => container?.querySelector<HTMLButtonElement>("button.button");
      expect(button()?.textContent).toBe("さらに表示");
      await act(async () => button()?.click());
      expect(button()?.textContent).toBe("さらに表示");
      expect(button()?.disabled).toBe(true);
      expect(container?.querySelectorAll(".entries .skeleton-entry").length).toBeGreaterThanOrEqual(
        2,
      );
      expect(container?.querySelectorAll(".entries .entry").length).toBe(1);
      // 一覧の取り直しと区別できるよう、読み足していることを伝える
      await vi.waitFor(() =>
        expect(container?.querySelector("[role='status']")?.textContent).toBe("続きを読み込み中…"),
      );
    } finally {
      restore();
    }
  });
});

describe("HomeView の公開範囲の印", () => {
  const rows = () => [...(container?.querySelectorAll(".entry") ?? [])];
  const pages = [
    summary("AAAAAAAAAAAAAAAAAAAAAA", "公開の行"),
    { ...summary("BBBBBBBBBBBBBBBBBBBBBB", "まだ書きかけの行"), visibility: "draft" as const },
  ];

  const mark = (index: number) => rows()[index]?.querySelector(".entry-visibility");

  it("owner の一覧では公開の行に「公開」、draft の行に「下書き」の印を付ける", async () => {
    vi.mocked(listRecent).mockResolvedValue(ok({ pages, nextCursor: null }));
    await renderHome("", true);
    expect(mark(0)?.textContent).toBe("●公開");
    expect(mark(0)?.classList.contains("entry-visibility-public")).toBe(true);
    expect(mark(1)?.textContent).toBe("○下書き");
    expect(mark(1)?.classList.contains("entry-visibility-draft")).toBe(true);
  });

  it("点は読み上げから外し、語だけを読ませる", async () => {
    vi.mocked(listRecent).mockResolvedValue(ok({ pages, nextCursor: null }));
    await renderHome("", true);
    for (const index of [0, 1]) {
      expect(mark(index)?.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("公開範囲で絞り込んでいる間も印を出す", async () => {
    vi.mocked(listRecent).mockResolvedValue(ok({ pages: [pages[1] as never], nextCursor: null }));
    await mountHome("", true, "", "draft");
    await vi.waitFor(() => expect(container?.querySelector(".entries .entry")).not.toBeNull());
    expect(mark(0)?.textContent).toBe("○下書き");
  });

  it("匿名の一覧は全行が公開なので、印を付けない", async () => {
    vi.mocked(listRecent).mockResolvedValue(ok({ pages: [pages[0] as never], nextCursor: null }));
    await renderHome("", false);
    expect(container?.querySelector(".entry-visibility")).toBeNull();
  });

  it("行のタグは、公開範囲の絞り込みを保つリンクにする", async () => {
    const tagged = { ...pages[1], tags: ["x"] } as never;
    vi.mocked(listRecent).mockResolvedValue(ok({ pages: [tagged], nextCursor: null }));
    vi.mocked(searchPages).mockResolvedValue(ok([{ ...(tagged as object), excerpt: "" } as never]));
    for (const [query, owner, visibility, href] of [
      ["", true, "draft", "/?tag=x&visibility=draft"],
      ["", true, "public", "/?tag=x&visibility=public"],
      ["", true, "", "/?tag=x"],
      // 検索中と匿名は絞り込みが効いていないので、URL に残っていても渡さない
      ["x", true, "draft", "/?tag=x"],
      ["", false, "draft", "/?tag=x"],
    ] as const) {
      await mountHome(query, owner, "", visibility);
      await vi.waitFor(() => expect(container?.querySelector(".entries .entry")).not.toBeNull());
      expect(
        container?.querySelector(".entries .chip-link")?.getAttribute("href"),
        `${query}/${owner}/${visibility}`,
      ).toBe(href);
      act(() => root?.unmount());
      container?.remove();
    }
  });
});

describe("HomeView の空の状態", () => {
  const empty = () => container?.querySelector(".empty");
  const title = () => empty()?.querySelector(".empty-title")?.textContent;
  const backLink = () => empty()?.querySelector<HTMLAnchorElement>("a.button");

  it("検索 0 件は見出しと一覧へ戻る導線を出し、補足は出さない", async () => {
    vi.mocked(searchPages).mockResolvedValue(ok([]));
    await mountHome("無い語", false);
    await vi.waitFor(() => expect(empty()).not.toBeNull());
    expect(title()).toBe("一致するページがありません");
    expect(empty()?.querySelector(".empty-text")).toBeNull();
    expect(backLink()?.getAttribute("href")).toBe("/");
  });

  it("匿名の短い検索語は、文字数の案内と一覧へ戻る導線を出し、補足は出さない", async () => {
    await mountHome("ab", false);
    expect(empty()?.getAttribute("role")).toBe("status");
    expect(title()).toBe("3\u00a0文字以上で検索してください");
    expect(empty()?.querySelector(".empty-text")).toBeNull();
    expect(backLink()?.getAttribute("href")).toBe("/");
  });

  it("ページが 1 件も無いときと、タグに当たるページが無いときで見出しを分ける", async () => {
    vi.mocked(listRecent).mockResolvedValue(ok({ pages: [], nextCursor: null }));
    await mountHome("", true);
    await vi.waitFor(() => expect(empty()).not.toBeNull());
    expect(title()).toBe("ページがまだありません");
    act(() => root?.unmount());
    container?.remove();

    await mountHome("", true, "x");
    await vi.waitFor(() => expect(empty()).not.toBeNull());
    expect(title()).toBe("このタグのページがありません");
    expect(empty()?.querySelector(".empty-text")).toBeNull();
    expect(backLink()?.getAttribute("href")).toBe("/");
  });

  it("匿名で公開ページが無いときは、見出しだけを出して補足の段落を描かない", async () => {
    vi.mocked(listRecent).mockResolvedValue(ok({ pages: [], nextCursor: null }));
    await mountHome("", false);
    await vi.waitFor(() => expect(empty()).not.toBeNull());
    expect(title()).toBe("公開されているページはまだありません");
    expect(empty()?.querySelector(".empty-text")).toBeNull();
  });
});

describe("HomeView の更新日", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("更新を相対の表記で出し、絶対の日時は datetime と title に残す", async () => {
    const now = Date.now();
    vi.mocked(listRecent).mockResolvedValue(
      ok({
        pages: [
          { ...summary("AAAAAAAAAAAAAAAAAAAAAA", "今"), updatedAt: now },
          { ...summary("BBBBBBBBBBBBBBBBBBBBBB", "5 日前"), updatedAt: now - 5 * DAY },
          { ...summary("CCCCCCCCCCCCCCCCCCCCCC", "去年以前"), updatedAt: now - 800 * DAY },
        ],
        nextCursor: null,
      }),
    );
    await renderHome("");
    const rows = [...(container?.querySelectorAll(".entry-time") ?? [])];
    expect(rows.map((t) => t.firstChild?.textContent)).toEqual([
      "1 分未満",
      "5 日前",
      expect.stringMatching(/年.*前$/),
    ]);
    // 読み上げには絶対の日時も届ける（hover の title はタッチ端末と読み上げに届かない）。
    // 本文に置くとコピーとページ内検索に混ざるので、CSS が data-absolute を ::after に出す
    expect(rows[1]?.getAttribute("data-absolute")).toMatch(/^（\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}）$/);
    expect(rows[1]?.textContent).not.toMatch(/\d{4}\/\d{2}/);
    expect(rows[1]?.getAttribute("datetime")).toBe(new Date(now - 5 * DAY).toISOString());
    expect(rows[1]?.getAttribute("title")).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
  });
});

describe("HomeView の短い検索語", () => {
  const guidance = () => container?.querySelector("[role='status'] .empty-title")?.textContent;

  it("匿名の 1〜2 文字（NFKC と前後の空白を畳んだ後）は検索を送らず、文字数を案内する", async () => {
    for (const query of ["a", "ab", " ab　", "ｶﾞｷ"]) {
      await mountHome(query, false);
      expect(guidance(), query).toBe("3\u00a0文字以上で検索してください");
      expect(container?.querySelector(".notice-error"), query).toBeNull();
      act(() => root?.unmount());
      container?.remove();
    }
    expect(searchPages).not.toHaveBeenCalled();
  });

  it("匿名でも 3 文字からは検索する", async () => {
    vi.mocked(searchPages).mockResolvedValue(
      ok([{ ...summary("AAAAAAAAAAAAAAAAAAAAAA", "abc"), excerpt: "abc" }]),
    );
    await renderHome("abc", false);
    expect(searchPages).toHaveBeenCalledWith("abc");
    expect(guidance()).toBeUndefined();
  });

  it("owner は 2 文字でも検索する", async () => {
    vi.mocked(searchPages).mockResolvedValue(
      ok([{ ...summary("AAAAAAAAAAAAAAAAAAAAAA", "ab"), excerpt: "ab" }]),
    );
    await renderHome("ab", true);
    expect(searchPages).toHaveBeenCalledWith("ab");
    expect(guidance()).toBeUndefined();
  });
});

describe("HomeView の 0 件の検索", () => {
  const createButton = () =>
    [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("作成"));

  it("owner には検索語の title で作る導線を出し、押すとその title で新規作成の画面を開く", async () => {
    vi.mocked(searchPages).mockResolvedValue(ok([]));
    await mountHome(" 無い語 ", true);
    await vi.waitFor(() => expect(createButton()).toBeDefined());
    expect(createButton()?.textContent).toBe("「無い語」を作成");
    expect(openNewPage).not.toHaveBeenCalled();
    act(() => createButton()?.click());
    expect(openNewPage).toHaveBeenCalledWith({ title: "無い語" });
  });

  it("匿名には出さない", async () => {
    vi.mocked(searchPages).mockResolvedValue(ok([]));
    await mountHome("無い語", false);
    await vi.waitFor(() => expect(container?.textContent).toContain("一致するページがありません"));
    expect(createButton()).toBeUndefined();
  });

  it("結果があるときは出さない", async () => {
    vi.mocked(searchPages).mockResolvedValue(
      ok([{ ...summary("AAAAAAAAAAAAAAAAAAAAAA", "無い語"), excerpt: "x" }]),
    );
    await renderHome("無い語", true);
    expect(createButton()).toBeUndefined();
  });
});

describe("HomeView の検索中のタグ", () => {
  it("タグで絞り込めないことと、そのタグの一覧への入口を出す", async () => {
    vi.mocked(searchPages).mockResolvedValue(
      ok([{ ...summary("AAAAAAAAAAAAAAAAAAAAAA", "語"), excerpt: "語" }]),
    );
    await mountHome("語", true, "メモ");
    await vi.waitFor(() => expect(container?.querySelector(".entries")).not.toBeNull());
    const hint = container?.querySelector(".home > p.muted");
    expect(hint?.textContent).toBe(
      "検索はタグで絞り込めないので、全ページから探しています。 タグ「メモ」のページを見る",
    );
    const links = [...(hint?.querySelectorAll("a") ?? [])];
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe(`/?tag=${encodeURIComponent("メモ")}`);
  });
});

describe("HomeView の取得の失敗", () => {
  it("再読み込みで同じ条件を取り直し、届いたら一覧を出す", async () => {
    vi.mocked(listRecent).mockResolvedValueOnce({
      ok: false,
      reason: "error",
      message: "時間をおいて、もう一度試してください。",
    });
    vi.mocked(listRecent).mockResolvedValueOnce(
      ok({ pages: [summary("AAAAAAAAAAAAAAAAAAAAAA", "取り直した行")], nextCursor: null }),
    );
    await mountHome("", true, "x");
    const reload = () =>
      [...(container?.querySelectorAll<HTMLButtonElement>(".notice button") ?? [])].find(
        (b) => b.textContent === "再読み込み",
      );
    await vi.waitFor(() => expect(reload()).toBeDefined());
    expect(container?.textContent).toContain("一覧を取得できませんでした");
    await act(async () => reload()?.click());
    await vi.waitFor(() =>
      expect(container?.querySelector(".entries .entry-title")?.textContent).toBe("取り直した行"),
    );
    expect(listRecent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(listRecent).mock.calls[1]?.[1]).toMatchObject({ tag: "x" });
    expect(container?.textContent).not.toContain("一覧を取得できませんでした");
  });
});

describe("HomeView の公開範囲の絞り込み", () => {
  const filter = () =>
    container?.querySelector<HTMLElement>("nav[aria-label='公開範囲で絞り込む']");
  const options = () =>
    [...(filter()?.querySelectorAll<HTMLAnchorElement>("a") ?? [])].map((a) => ({
      label: a.textContent,
      href: a.getAttribute("href"),
      current: a.getAttribute("aria-current"),
    }));

  it("owner にはタグの下に欄を出し、選択中のタグを保ったリンクにする", async () => {
    vi.mocked(listTags).mockResolvedValue(
      ok([
        { tag: "x", count: 1 },
        { tag: "y", count: 1 },
      ]),
    );
    vi.mocked(listRecent).mockResolvedValue(
      ok({ pages: [summary("AAAAAAAAAAAAAAAAAAAAAA", "行")], nextCursor: null }),
    );
    await mountHome("", true, "x", "draft");
    await vi.waitFor(() => expect(filter()).not.toBeNull());
    expect(vi.mocked(listRecent).mock.calls[0]?.[1]).toMatchObject({
      tag: "x",
      visibility: "draft",
    });
    expect(container?.querySelector("h1")?.textContent).toBe("タグ「x」の下書き");
    expect(options()).toEqual([
      { label: "すべて", href: "/?tag=x", current: null },
      { label: "公開", href: "/?tag=x&visibility=public", current: null },
      { label: "下書き", href: "/?tag=x&visibility=draft", current: "page" },
    ]);
    const sections = [...(container?.querySelectorAll(".rail .rail-label") ?? [])];
    expect(sections.map((label) => label.textContent)).toEqual(["タグ", "公開範囲"]);
    // タグを外しても別のタグに移っても、公開範囲の絞り込みは残す
    const tagHrefs = [...(container?.querySelectorAll(".rail .chip-link") ?? [])].map((chip) =>
      chip.getAttribute("href"),
    );
    expect(tagHrefs).toEqual(["/?visibility=draft", "/?tag=y&visibility=draft"]);
  });

  it("「さらに表示」も同じ公開範囲で読み足す", async () => {
    vi.mocked(listRecent).mockResolvedValueOnce(
      ok({ pages: [summary("AAAAAAAAAAAAAAAAAAAAAA", "行")], nextCursor: "c1" }),
    );
    vi.mocked(listRecent).mockReturnValueOnce(new Promise(() => {}));
    await mountHome("", true, "", "public");
    await vi.waitFor(() => expect(container?.querySelector(".entries .entry")).not.toBeNull());
    await act(async () => container?.querySelector<HTMLButtonElement>("button.button")?.click());
    expect(vi.mocked(listRecent).mock.calls[1]).toMatchObject(["c1", { visibility: "public" }]);
  });

  it("絞り込んだ一覧が空なら、公開範囲とタグに合わせた見出しを出す", async () => {
    vi.mocked(listRecent).mockResolvedValue(ok({ pages: [], nextCursor: null }));
    for (const [tag, visibility, expected] of [
      ["", "draft", "下書きがありません"],
      ["", "public", "公開ページがありません"],
      ["x", "draft", "このタグの下書きがありません"],
    ] as const) {
      await mountHome("", true, tag, visibility);
      await vi.waitFor(() => expect(container?.querySelector(".empty")).not.toBeNull());
      expect(container?.querySelector(".empty-title")?.textContent, expected).toBe(expected);
      act(() => root?.unmount());
      container?.remove();
    }
  });

  it("匿名には欄を出さず、URL に残った公開範囲で絞り込まない", async () => {
    vi.mocked(listTags).mockResolvedValue(ok([{ tag: "x", count: 1 }]));
    vi.mocked(listRecent).mockResolvedValue(
      ok({ pages: [summary("AAAAAAAAAAAAAAAAAAAAAA", "行")], nextCursor: null }),
    );
    await mountHome("", false, "", "draft");
    await vi.waitFor(() => expect(container?.querySelector(".rail .chip-link")).not.toBeNull());
    expect(filter()).toBeNull();
    expect(vi.mocked(listRecent).mock.calls[0]?.[1]).toMatchObject({ visibility: "" });
    expect(vi.mocked(listTags).mock.calls).toEqual([[{ visibility: "" }]]);
    expect(container?.querySelector("h1")?.textContent).toBe("最近の更新");
    expect(container?.querySelector(".rail .chip-link")?.getAttribute("href")).toBe("/?tag=x");
  });

  it("検索中は公開範囲で絞り込まず、欄も出さない", async () => {
    vi.mocked(listTags).mockResolvedValue(ok([{ tag: "x", count: 1 }]));
    vi.mocked(searchPages).mockResolvedValue(
      ok([{ ...summary("AAAAAAAAAAAAAAAAAAAAAA", "行"), excerpt: "語" }]),
    );
    await mountHome("語", true, "", "draft");
    await vi.waitFor(() => {
      expect(container?.querySelector(".entries .entry")).not.toBeNull();
      expect(container?.querySelector(".rail .chip-link")).not.toBeNull();
    });
    expect(filter()).toBeNull();
    expect(listRecent).not.toHaveBeenCalled();
    expect(vi.mocked(listTags).mock.calls).toEqual([[{ visibility: "" }]]);
  });

  it("タグの取得が済むまでは欄を出さない", async () => {
    vi.mocked(listTags).mockReturnValue(new Promise(() => {}));
    vi.mocked(listRecent).mockResolvedValue(
      ok({ pages: [summary("AAAAAAAAAAAAAAAAAAAAAA", "行")], nextCursor: null }),
    );
    await mountHome("", true, "", "draft");
    await vi.waitFor(() => expect(container?.querySelector(".entries .entry")).not.toBeNull());
    expect(filter()).toBeNull();
  });

  it("タグの取得に失敗しても、owner には公開範囲の欄を出す", async () => {
    vi.mocked(listTags).mockResolvedValue({ ok: false, reason: "error", message: "失敗" });
    vi.mocked(listRecent).mockResolvedValue(ok({ pages: [], nextCursor: null }));
    await mountHome("", true);
    await vi.waitFor(() => expect(filter()).not.toBeNull());
    expect(container?.querySelector(".rail .chip-link")).toBeNull();
    expect(options().find((o) => o.current === "page")?.label).toBe("すべて");
  });

  it("タグの件数を公開範囲で数え直し、取り直す間は前の件数と欄を残す", async () => {
    vi.mocked(listTags).mockResolvedValueOnce(
      ok([
        { tag: "x", count: 3 },
        { tag: "y", count: 1 },
      ]),
    );
    vi.mocked(listRecent).mockResolvedValue(
      ok({ pages: [summary("AAAAAAAAAAAAAAAAAAAAAA", "行")], nextCursor: null }),
    );
    await mountHome("", true);
    await vi.waitFor(() => expect(filter()).not.toBeNull());
    expect(vi.mocked(listTags).mock.calls).toEqual([[{ visibility: "" }]]);
    const chips = () =>
      [...(container?.querySelectorAll(".rail .chip-link") ?? [])].map((c) => c.textContent);
    expect(chips()).toEqual(["x3", "y1"]);

    let resolve: (value: ApiResult<{ tag: string; count: number }[]>) => void = () => {};
    vi.mocked(listTags).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await act(async () =>
      root?.render(<HomeView query="" tag="" visibility="draft" owner={true} />),
    );
    expect(vi.mocked(listTags).mock.calls[1]).toEqual([{ visibility: "draft" }]);
    expect(chips()).toEqual(["x3", "y1"]);
    expect(filter()).not.toBeNull();

    await act(async () => resolve(ok([{ tag: "x", count: 1 }])));
    expect(chips()).toEqual(["x1"]);
    expect(filter()).not.toBeNull();
  });

  it("選んだタグが範囲の中に 0 件でも、件数 0 のチップを残して外せるようにする", async () => {
    vi.mocked(listRecent).mockResolvedValue(ok({ pages: [], nextCursor: null }));
    const chips = () =>
      [...(container?.querySelectorAll(".rail .chip-link") ?? [])].map((c) => ({
        text: c.textContent,
        href: c.getAttribute("href"),
        current: c.getAttribute("aria-current"),
      }));
    // 範囲に別のタグはある場合と、1 つも無い場合
    for (const [tags, expected] of [
      [
        [{ tag: "y", count: 2 }],
        [
          { text: "y2", href: "/?tag=y&visibility=draft", current: null },
          { text: "x0", href: "/?visibility=draft", current: "page" },
        ],
      ],
      [[], [{ text: "x0", href: "/?visibility=draft", current: "page" }]],
    ] as const) {
      vi.mocked(listTags).mockResolvedValue(ok([...tags]));
      await mountHome("", true, "x", "draft");
      await vi.waitFor(() => expect(filter()).not.toBeNull());
      expect(chips()).toEqual(expected);
      expect(container?.querySelector(".rail .muted")).toBeNull();
      act(() => root?.unmount());
      container?.remove();
    }
  });

  it("選んだタグが子のタグしか結果に無いときは、件数 0 と出さず件数を付けずにチップを補う", async () => {
    vi.mocked(listRecent).mockResolvedValue(
      ok({ pages: [summary("AAAAAAAAAAAAAAAAAAAAAA", "行")], nextCursor: null }),
    );
    // 「A」は畳んだ値で `a` に当たり、`ab/c` は前置きが同じだけの別のタグなので子に数えない
    vi.mocked(listTags).mockResolvedValue(
      ok([
        { tag: "a/b", count: 1 },
        { tag: "ab/c", count: 1 },
      ]),
    );
    await mountHome("", true, "A");
    await vi.waitFor(() => expect(container?.querySelector(".entries .entry")).not.toBeNull());
    const chips = [...(container?.querySelectorAll(".rail .chip-link") ?? [])];
    expect(chips.map((c) => [c.textContent, c.getAttribute("aria-current")])).toEqual([
      ["a/b1", null],
      ["ab/c1", null],
      ["A", "page"],
    ]);

    act(() => root?.unmount());
    container?.remove();
    vi.mocked(listTags).mockResolvedValue(ok([{ tag: "ab/c", count: 1 }]));
    await mountHome("", true, "A");
    await vi.waitFor(() => expect(container?.querySelector(".entries .entry")).not.toBeNull());
    expect(
      [...(container?.querySelectorAll(".rail .chip-link") ?? [])].map((c) => c.textContent),
    ).toEqual(["ab/c1", "A0"]);
  });

  it("選んだタグと表記が違うだけのタグは、0 件のチップを足さずにそのチップを選択中にする", async () => {
    vi.mocked(listRecent).mockResolvedValue(ok({ pages: [], nextCursor: null }));
    vi.mocked(listTags).mockResolvedValue(ok([{ tag: "Beta", count: 2 }]));
    await mountHome("", true, "beta");
    await vi.waitFor(() => expect(filter()).not.toBeNull());
    const chips = [...(container?.querySelectorAll(".rail .chip-link") ?? [])];
    expect(chips.map((c) => [c.textContent, c.getAttribute("aria-current")])).toEqual([
      ["Beta2", "page"],
    ]);
  });

  it("絞り込んだ公開範囲にタグが無ければ、その範囲に無いことを出す", async () => {
    vi.mocked(listRecent).mockResolvedValue(ok({ pages: [], nextCursor: null }));
    for (const [visibility, expected] of [
      ["", "タグはまだありません。"],
      ["draft", "下書きにタグはありません。"],
      ["public", "公開ページにタグはありません。"],
    ] as const) {
      await mountHome("", true, "", visibility);
      await vi.waitFor(() => expect(container?.querySelector(".rail .muted")).not.toBeNull());
      expect(container?.querySelector(".rail .muted")?.textContent, visibility).toBe(expected);
      act(() => root?.unmount());
      container?.remove();
    }
  });
});
