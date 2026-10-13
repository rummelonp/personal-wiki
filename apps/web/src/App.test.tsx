import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { fetchMe, logout } from "./api";
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
import { navigate } from "./route";

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

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // App は PageView を lazy で読む。開発サーバーの初回の変換が waitFor の待ち時間を超えないよう先に読む
  await import("./PageView");
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

const tagOf = (page: Page) => `${page.title}のタグ`;

/**
 * Worker の API と同じ範囲を返す。title、一覧、タグでは、匿名に draft を無いものとして返す。
 * `GET /api/pages/:id` は id を知っていれば draft も読めるので、principal で絞らない。
 * ログアウトすると、その後の要求は匿名として扱う。
 */
function serve(me: "owner" | "anonymous", pages: readonly Page[]) {
  let signedIn = me === "owner";
  vi.mocked(fetchMe).mockImplementation(async () => ({
    kind: signedIn ? "owner" : "anonymous",
  }));
  vi.mocked(logout).mockImplementation(async () => {
    signedIn = false;
  });
  const listed = () => pages.filter((page) => signedIn || page.visibility === "public");
  vi.mocked(getPage).mockImplementation(async (id) => {
    const page = pages.find((p) => p.id === id);
    return page ? ok(page) : notFound;
  });
  vi.mocked(findPageByTitle).mockImplementation(async (title) => {
    const page = listed().find((p) => p.title === title);
    return page ? ok(page) : notFound;
  });
  vi.mocked(listRecent).mockImplementation(async () =>
    ok({ pages: listed().map((page) => ({ ...page, tags: [tagOf(page)] })), nextCursor: null }),
  );
  vi.mocked(listTags).mockImplementation(async () =>
    ok(listed().map((page) => ({ tag: tagOf(page), count: 1 }))),
  );
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
    serve("anonymous", [PUBLIC, DRAFT]);
    await renderAt("/");
    await vi.waitFor(() =>
      expect(main()?.querySelector(`a[href='${titleUrl(PUBLIC.title)}']`)).not.toBeNull(),
    );
    expect(main()?.querySelector("input[type='search'], form input")).not.toBeNull();
    expect(main()?.textContent).toContain(tagOf(PUBLIC));
    expect(main()?.textContent).not.toContain(DRAFT.title);
    expect(main()?.querySelectorAll("button")).toHaveLength(0);
    expect(header()?.querySelectorAll("button")).toHaveLength(0);
    expect(header()?.querySelector("a[href^='/_auth/login']")?.textContent).toBe("ログイン");
  });

  it("/<title> で公開ページを読み取り専用で開き、ヘッダーにはログインだけを出す", async () => {
    serve("anonymous", [PUBLIC]);
    await renderAt(titleUrl(PUBLIC.title));
    await vi.waitFor(() => expect(main()?.querySelector("h1")?.textContent).toBe("公開の題"));
    expect(main()?.querySelector(".title-input")).toBeNull();
    await vi.waitFor(() => expect(main()?.querySelector(".cm-editor")).not.toBeNull());
    expect(header()?.querySelectorAll("button")).toHaveLength(0);
    expect(header()?.querySelector("a[href^='/_auth/login']")?.textContent).toBe("ログイン");
    expect(location.pathname).toBe(titleUrl(PUBLIC.title));
    expect(document.title).toBe("公開の題 - personal-wiki");
  });

  it("次のページを読み込む間は、前のページの title を document.title に残さない", async () => {
    serve("anonymous", [PUBLIC]);
    await renderAt(titleUrl(PUBLIC.title));
    await vi.waitFor(() => expect(document.title).toBe("公開の題 - personal-wiki"));
    vi.mocked(findPageByTitle).mockReturnValue(new Promise(() => {}));
    act(() => navigate(titleUrl("次の題")));
    await vi.waitFor(() => expect(main()?.textContent).toContain("読み込み中"));
    expect(document.title).toBe("personal-wiki");
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

  it("/p/<id> で開いた draft は読み取り専用で読め、URL は /p/<id> のまま", async () => {
    serve("anonymous", [PUBLIC, DRAFT]);
    await renderAt(`/p/${DRAFT.id}`);
    await vi.waitFor(() => expect(main()?.querySelector("h1")?.textContent).toBe("下書きの題"));
    expect(main()?.querySelector(".title-input")).toBeNull();
    expect(location.pathname).toBe(`/p/${DRAFT.id}`);
    expect(getPage).toHaveBeenCalledTimes(1);
  });

  it("title で引いた draft と存在しないページで同じ 404 を出す", async () => {
    serve("anonymous", [PUBLIC, DRAFT]);
    const shown: string[] = [];
    for (const path of [
      titleUrl(DRAFT.title),
      titleUrl("存在しない題"),
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
  it("トップでログアウトすると、一覧とタグを匿名として取り直し、draft を残さない", async () => {
    serve("owner", [PUBLIC, DRAFT]);
    await renderAt("/");
    await vi.waitFor(() =>
      expect(main()?.querySelector(`a[href='/p/${DRAFT.id}']`)).not.toBeNull(),
    );
    expect(main()?.textContent).toContain(tagOf(DRAFT));
    const recentCalls = vi.mocked(listRecent).mock.calls.length;
    const tagCalls = vi.mocked(listTags).mock.calls.length;

    const logoutButton = [...(header()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "ログアウト",
    );
    act(() => logoutButton?.click());
    await vi.waitFor(() =>
      expect(header()?.querySelector("a[href^='/_auth/login']")).not.toBeNull(),
    );
    await vi.waitFor(() =>
      expect(main()?.querySelector(`a[href='${titleUrl(PUBLIC.title)}']`)).not.toBeNull(),
    );
    expect(main()?.querySelector(`a[href='/p/${DRAFT.id}']`)).toBeNull();
    expect(main()?.textContent).not.toContain(DRAFT.title);
    expect(main()?.textContent).not.toContain("下書き");
    expect(vi.mocked(listRecent).mock.calls.length).toBeGreaterThan(recentCalls);
    expect(vi.mocked(listTags).mock.calls.length).toBeGreaterThan(tagCalls);
    expect(logout).toHaveBeenCalledTimes(1);
  });

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
