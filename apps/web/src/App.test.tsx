import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { fetchMe } from "./api";
import {
  type ApiResult,
  findPageByTitle,
  getPage,
  listBacklinks,
  listPageTitles,
  listRecent,
  listTags,
  type Page,
  resolvePages,
} from "./pages-api";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, fetchMe: vi.fn(), logout: vi.fn() };
});

vi.mock("./pages-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pages-api")>();
  return {
    ...actual,
    getPage: vi.fn(),
    updatePage: vi.fn(),
    setVisibility: vi.fn(),
    deletePage: vi.fn(),
    findPageByTitle: vi.fn(),
    listBacklinks: vi.fn(),
    listPageTitles: vi.fn(),
    resolvePages: vi.fn(),
    createPage: vi.fn(),
    listRecent: vi.fn(),
    listTags: vi.fn(),
    searchPages: vi.fn(),
  };
});

const PUBLIC: Page = {
  id: "AAAAAAAAAAAAAAAAAAAAAA",
  title: "公開の題",
  body: "本文",
  visibility: "public",
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};
const DRAFT: Page = {
  ...PUBLIC,
  id: "DDDDDDDDDDDDDDDDDDDDDD",
  title: "下書きの題",
  visibility: "draft",
};
const titleUrl = (title: string) => `/${encodeURIComponent(title)}`;

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const notFound = { ok: false, reason: "not_found" } as const;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const startUrl = location.href;

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.mocked(listBacklinks).mockResolvedValue(ok({ pages: [], nextCursor: null }));
  vi.mocked(listPageTitles).mockResolvedValue(ok({ pages: [], nextCursor: null }));
  vi.mocked(resolvePages).mockImplementation(async (titles) => ok(titles.map(() => null)));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  history.replaceState(null, "", startUrl);
});

/** API が返す内容を owner と匿名で分けて与える。匿名には draft が無いものとして返る */
function serve(me: "owner" | "anonymous", pages: readonly Page[]) {
  vi.mocked(fetchMe).mockResolvedValue({ kind: me });
  const visible = pages.filter((page) => me === "owner" || page.visibility === "public");
  vi.mocked(getPage).mockImplementation(async (id) => {
    const page = visible.find((p) => p.id === id);
    return page ? ok(page) : notFound;
  });
  vi.mocked(findPageByTitle).mockImplementation(async (title) => {
    const page = visible.find((p) => p.title === title);
    return page ? ok(page) : notFound;
  });
}

async function renderAt(path: string) {
  history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  act(() => mounted.render(<App />));
  await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
}

const main = () => container?.querySelector("main");
const header = () => container?.querySelector("header");

describe("App の匿名の画面", () => {
  it("トップで公開ページの一覧と検索とタグを出し、owner の操作を出さない", async () => {
    serve("anonymous", [PUBLIC]);
    vi.mocked(listRecent).mockResolvedValue(
      ok({ pages: [{ ...PUBLIC, tags: ["タグ"] }], nextCursor: null }),
    );
    vi.mocked(listTags).mockResolvedValue(ok([{ tag: "タグ", count: 1 }]));
    await renderAt("/");
    await vi.waitFor(() =>
      expect(main()?.querySelector(`a[href='${titleUrl(PUBLIC.title)}']`)).not.toBeNull(),
    );
    expect(main()?.querySelector("input[type='search'], form input")).not.toBeNull();
    expect(main()?.textContent).toContain("タグ");
    expect(main()?.querySelectorAll("button")).toHaveLength(0);
    expect(header()?.querySelectorAll("button")).toHaveLength(0);
    expect(header()?.querySelector("a[href^='/_auth/login']")?.textContent).toBe("ログイン");
  });

  it("/<title> で公開ページを読み取り専用で開き、ヘッダーにはログインだけを出す", async () => {
    serve("anonymous", [PUBLIC]);
    await renderAt(titleUrl(PUBLIC.title));
    await vi.waitFor(() => expect(main()?.querySelector("h1")?.textContent).toBe("公開の題"));
    expect(main()?.querySelector(".title-input")).toBeNull();
    expect(main()?.querySelector(".cm-editor")).not.toBeNull();
    expect(header()?.querySelectorAll("button")).toHaveLength(0);
    expect(header()?.querySelector("a[href^='/_auth/login']")?.textContent).toBe("ログイン");
    expect(location.pathname).toBe(titleUrl(PUBLIC.title));
    expect(document.title).toBe("公開の題 - personal-wiki");
  });

  it("/p/<id> で開いた公開ページは /<title> に置き換え、取り直さない", async () => {
    serve("anonymous", [PUBLIC]);
    await renderAt(`/p/${PUBLIC.id}#見出し`);
    await vi.waitFor(() => expect(location.pathname).toBe(titleUrl(PUBLIC.title)));
    expect(location.hash).toBe(`#${encodeURIComponent("見出し")}`);
    expect(main()?.querySelector("h1")?.textContent).toBe("公開の題");
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(findPageByTitle).not.toHaveBeenCalled();
  });

  it("draft と存在しないページで同じ 404 を出す", async () => {
    serve("anonymous", [PUBLIC, DRAFT]);
    const shown: string[] = [];
    for (const path of [
      titleUrl(DRAFT.title),
      titleUrl("存在しない題"),
      `/p/${DRAFT.id}`,
      "/p/ZZZZZZZZZZZZZZZZZZZZZZ",
    ]) {
      await renderAt(path);
      await vi.waitFor(() => expect(main()?.textContent).toContain("ページが見つかりません"));
      shown.push(main()?.innerHTML ?? "");
      expect(document.title).toBe("personal-wiki");
      act(() => root?.unmount());
      container?.remove();
      root = null;
    }
    expect(new Set(shown).size).toBe(1);
    expect(shown[0]).not.toContain("下書き");
  });

  it("予約語や形の合わないパスも同じ 404 を出す", async () => {
    serve("anonymous", [PUBLIC]);
    await renderAt("/p/short");
    await vi.waitFor(() => expect(main()?.textContent).toContain("ページが見つかりません"));
    expect(getPage).not.toHaveBeenCalled();
    expect(findPageByTitle).not.toHaveBeenCalled();
  });
});

describe("App の owner の画面", () => {
  it("ログイン中に /<title> を開くと編集の画面を出す", async () => {
    serve("owner", [PUBLIC]);
    await renderAt(titleUrl(PUBLIC.title));
    await vi.waitFor(() =>
      expect(main()?.querySelector<HTMLInputElement>(".title-input")?.value).toBe("公開の題"),
    );
    expect(header()?.textContent).toContain("新規作成");
    expect(location.pathname).toBe(titleUrl(PUBLIC.title));
  });

  it("/<title> で開いた draft は /p/<id> に置き換える", async () => {
    serve("owner", [DRAFT]);
    await renderAt(titleUrl(DRAFT.title));
    await vi.waitFor(() => expect(location.pathname).toBe(`/p/${DRAFT.id}`));
    expect(main()?.querySelector<HTMLInputElement>(".title-input")?.value).toBe("下書きの題");
    expect(findPageByTitle).toHaveBeenCalledTimes(1);
    expect(getPage).not.toHaveBeenCalled();
  });
});
