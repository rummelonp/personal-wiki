import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeView } from "./HomeView";
import {
  type ApiResult,
  createPage,
  listRecent,
  listTags,
  type Page,
  searchPages,
} from "./pages-api";
import { useEntryList } from "./useEntryList";

vi.mock("./pages-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pages-api")>();
  return {
    ...actual,
    createPage: vi.fn(),
    listRecent: vi.fn(),
    listTags: vi.fn(),
    searchPages: vi.fn(),
  };
});

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

async function mountHome(query: string, owner: boolean) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<HomeView query={query} tag="" owner={owner} />));
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
      seen.push({ tag, status: useEntryList({ query: "", tag, owner: true }).state.status });
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

describe("HomeView の短い検索語", () => {
  const guidance = () => container?.querySelector("[role='status']")?.textContent;

  it("匿名の 1〜2 文字（NFKC と前後の空白を畳んだ後）は検索を送らず、文字数を案内する", async () => {
    for (const query of ["a", "ab", " ab　", "ｶﾞｷ"]) {
      await mountHome(query, false);
      expect(guidance(), query).toBe("3 文字以上で検索してください");
      expect(container?.querySelector(".message-error"), query).toBeNull();
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

  it("owner には検索語の title で作る導線を出し、押すと作ってそのページへ移る", async () => {
    vi.mocked(searchPages).mockResolvedValue(ok([]));
    vi.mocked(createPage).mockResolvedValue(
      ok({ id: "NNNNNNNNNNNNNNNNNNNNNN", title: "無い語" } as Page),
    );
    await mountHome(" 無い語 ", true);
    await vi.waitFor(() => expect(createButton()).toBeDefined());
    expect(createButton()?.textContent).toBe("「無い語」を作成");
    // 押すまでは作らない
    expect(createPage).not.toHaveBeenCalled();
    await act(async () => createButton()?.click());
    expect(createPage).toHaveBeenCalledWith({ title: "無い語", body: "" });
    await vi.waitFor(() => expect(location.pathname).toBe("/p/NNNNNNNNNNNNNNNNNNNNNN"));
    history.replaceState(null, "", "/");
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
