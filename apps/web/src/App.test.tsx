import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { fetchMe, logout } from "./api";
import { linkRewrites } from "./link-rewrites";
import { stepLinkRewrites } from "./link-rewrites-api";
import { recallTitle, rememberTitle } from "./page-titles";
import {
  type ApiResult,
  createPage,
  findPageByTitle,
  getPage,
  listBacklinks,
  listBacklinksByTitle,
  listPageTitles,
  listRecent,
  listTags,
  type Page,
  resolvePages,
} from "./pages-api";
import { navigate } from "./route";
import { recordImageSrcs } from "./test-image-srcs";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, fetchMe: vi.fn(), logout: vi.fn() };
});

vi.mock("./link-rewrites-api", () => ({ stepLinkRewrites: vi.fn() }));

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
    listBacklinksByTitle: vi.fn(),
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
  vi.mocked(listBacklinksByTitle).mockResolvedValue(ok({ pages: [], nextCursor: null }));
  vi.mocked(listPageTitles).mockResolvedValue(ok({ pages: [], nextCursor: null }));
  vi.mocked(resolvePages).mockImplementation(async (titles) => ok(titles.map(() => null)));
  vi.mocked(stepLinkRewrites).mockResolvedValue({
    ok: true,
    value: { processed: null, conflict: false, failed: [], remaining: 0 },
  });
});

afterEach(() => {
  restoreUserAgent?.();
  restoreUserAgent = null;
  linkRewrites.stop();
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  // 閉じた作る前の画面の退避は、次の新規作成の画面が復元を尋ねるので、試験の間に持ち越さない
  localStorage.clear();
  history.replaceState(null, "", startUrl);
});

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";
let restoreUserAgent: (() => void) | null = null;

/** navigator.userAgent を差し替える（Header と shortcut.ts は呼ぶたびに読む）。afterEach で戻す。 */
function stubUserAgent(userAgent: string) {
  restoreUserAgent ??= () => {
    // 差し替えは navigator 自身の property なので、消せば prototype の実物に戻る
    Reflect.deleteProperty(navigator, "userAgent");
  };
  Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
}

const noticeDock = () => document.querySelector(".notice-dock");

const tagOf = (page: Page) => `${page.title}のタグ`;

/**
 * Worker の API と同じ範囲を返す。title、一覧、タグでは、匿名に draft を無いものとして返す。
 * `GET /api/pages/:id` は id を知っていれば draft も読めるので、principal で絞らない。
 * ログアウトすると、その後の要求は匿名として扱う。
 */
function serve(
  me: "owner" | "anonymous",
  pages: readonly Page[],
  attachments = false,
  linkRewrites = true,
) {
  let signedIn = me === "owner";
  vi.mocked(fetchMe).mockImplementation(async () => ({
    kind: signedIn ? "owner" : "anonymous",
    features: { attachments, linkRewrites },
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
  vi.mocked(listPageTitles).mockImplementation(async () =>
    ok({
      pages: listed().map(({ id, title, visibility, updatedAt }) => ({
        id,
        title,
        visibility,
        updatedAt,
      })),
      nextCursor: null,
    }),
  );
  vi.mocked(listRecent).mockImplementation(async () =>
    ok({ pages: listed().map((page) => ({ ...page, tags: [tagOf(page)] })), nextCursor: null }),
  );
  vi.mocked(listTags).mockImplementation(async () =>
    ok(listed().map((page) => ({ tag: tagOf(page), count: 1 }))),
  );
  // リンク先の有無を見ず、読めるリンク元だけを返す
  vi.mocked(listBacklinksByTitle).mockImplementation(async (title) =>
    ok({
      pages: listed()
        .filter((page) => page.body.includes(`[[${title}]]`))
        .map(({ id, title, visibility, updatedAt }) => ({ id, title, visibility, updatedAt })),
      nextCursor: null,
    }),
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

const cursorOf = () => {
  const editor = container?.querySelector<HTMLElement>(".body-editor .cm-editor");
  const view = editor ? EditorView.findFromDOM(editor) : null;
  return view?.state.selection.main.head;
};

const main = () => container?.querySelector("main");
// 通知は main の外の台に出るので、通知の文言は画面全体から探す
const screenText = () => container?.textContent ?? "";
const titleText = () => main()?.querySelector(".title-input .cm-content")?.textContent;
const header = () => container?.querySelector("header");
/** ヘッダーのボタンの名前。匿名には検索だけが出る。 */
const headerButtons = () =>
  [...(header()?.querySelectorAll("button") ?? [])].map(
    (b) => b.getAttribute("aria-label") ?? b.textContent,
  );

const switcher = () => container?.querySelector<HTMLDialogElement>("dialog.switcher");
const switcherOptions = () =>
  [...(switcher()?.querySelectorAll("[role='option']") ?? [])].map((o) => o.textContent);

const BODY_CONTENT = ".cm-content[aria-label='本文']";

function editorContent(): HTMLElement {
  const content = main()?.querySelector<HTMLElement>(BODY_CONTENT);
  if (!content) throw new Error("エディタが無い");
  return content;
}

/** quick switcher のキーを window へ（target を渡せばそこから bubble させて）送る。preventDefault されたら false。 */
function pressShortcut(init: KeyboardEventInit, target: EventTarget = window): boolean {
  let notPrevented = true;
  act(() => {
    notPrevented = target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true, ...init }),
    );
  });
  return notPrevented;
}

/** 制御された input に値を入れる。React は native の value setter を通した input イベントだけを拾う。 */
function typeInSwitcher(text: string) {
  const input = switcher()?.querySelector<HTMLInputElement>("input[role='combobox']");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, text);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("App の匿名の画面", () => {
  it("トップで公開ページの一覧と検索とタグを出し、owner の操作を出さない", async () => {
    serve("anonymous", [PUBLIC, DRAFT]);
    await renderAt("/");
    await vi.waitFor(() =>
      expect(main()?.querySelector(`a[href='${titleUrl(PUBLIC.title)}']`)).not.toBeNull(),
    );
    expect(main()?.textContent).toContain(tagOf(PUBLIC));
    expect(main()?.textContent).not.toContain(DRAFT.title);
    expect(main()?.querySelectorAll("button")).toHaveLength(0);
    expect(headerButtons()).toEqual(["ページを検索"]);
    expect(header()?.textContent).not.toContain("新規作成");
    expect(header()?.querySelector("a[href^='/_auth/login']")?.textContent).toBe("ログイン");
  });

  it("/<title> で公開ページを読み取り専用で開き、ヘッダーにはログインだけを出す", async () => {
    serve("anonymous", [PUBLIC]);
    await renderAt(titleUrl(PUBLIC.title));
    await vi.waitFor(() => expect(main()?.querySelector("h1")?.textContent).toBe("公開の題"));
    expect(main()?.querySelector(".title-input")).toBeNull();
    await vi.waitFor(() => expect(main()?.querySelector(".cm-editor")).not.toBeNull());
    expect(headerButtons()).toEqual(["ページを検索"]);
    expect(header()?.querySelector("a[href^='/_auth/login']")?.textContent).toBe("ログイン");
    expect(location.pathname).toBe(titleUrl(PUBLIC.title));
    // エディタは layout effect で、document.title は後の passive effect で決まる
    await vi.waitFor(() => expect(document.title).toBe("公開の題 - personal-wiki"));
  });

  it("次のページを読み込む間は、前のページの title を document.title に残さない", async () => {
    serve("anonymous", [PUBLIC]);
    await renderAt(titleUrl(PUBLIC.title));
    await vi.waitFor(() => expect(document.title).toBe("公開の題 - personal-wiki"));
    vi.mocked(findPageByTitle).mockReturnValue(new Promise(() => {}));
    act(() => navigate(titleUrl("次の題")));
    await vi.waitFor(() => expect(main()?.querySelector("[aria-busy='true']")).not.toBeNull());
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

  it("見出しの fragment 付きの URL を開くと、置き換えた URL にも fragment を残して見出しへ移る", async () => {
    const page = { ...PUBLIC, body: "前文\n\n# 節A\n\n本文\n\n## 節B\n\n末尾" };
    serve("anonymous", [page]);
    await renderAt(`/p/${page.id}#${encodeURIComponent("節B")}`);
    await vi.waitFor(() => expect(location.pathname).toBe(titleUrl(page.title)));
    expect(location.hash).toBe(`#${encodeURIComponent("節B")}`);
    expect(cursorOf()).toBe(page.body.indexOf("## 節B"));
  });

  it("別のページから fragment 付きで移ると、読み込んだ後にその見出しへ移る", async () => {
    const other = {
      ...PUBLIC,
      id: "EEEEEEEEEEEEEEEEEEEEEE",
      title: "別の題",
      body: "# 節A\n\n## 節B",
    };
    serve("anonymous", [PUBLIC, other]);
    await renderAt(titleUrl(PUBLIC.title));
    await vi.waitFor(() => expect(main()?.querySelector("h1")?.textContent).toBe("公開の題"));
    act(() => navigate(`${titleUrl(other.title)}#${encodeURIComponent("節B")}`));
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    await vi.waitFor(() => expect(main()?.querySelector("h1")?.textContent).toBe("別の題"));
    expect(cursorOf()).toBe(other.body.indexOf("## 節B"));
  });

  it("/p/<id> で開いた draft は読み取り専用で読め、URL は /p/<id> のまま", async () => {
    serve("anonymous", [PUBLIC, DRAFT]);
    await renderAt(`/p/${DRAFT.id}`);
    await vi.waitFor(() => expect(main()?.querySelector("h1")?.textContent).toBe("下書きの題"));
    expect(main()?.querySelector(".title-input")).toBeNull();
    expect(location.pathname).toBe(`/p/${DRAFT.id}`);
    expect(getPage).toHaveBeenCalledTimes(1);
  });

  it("title で引いた draft と存在しないページで同じ空のページを出し、public の被リンクだけを出す", async () => {
    const linker: Page = {
      ...PUBLIC,
      id: "LLLLLLLLLLLLLLLLLLLLLL",
      title: "リンク元",
      body: `[[${DRAFT.title}]] [[存在しない題]]`,
    };
    const hiddenLinker: Page = {
      ...DRAFT,
      id: "HHHHHHHHHHHHHHHHHHHHHH",
      title: "隠れたリンク元",
      body: linker.body,
    };
    serve("anonymous", [PUBLIC, DRAFT, linker, hiddenLinker]);
    const shown: string[] = [];
    for (const title of [DRAFT.title, "存在しない題"]) {
      await renderAt(titleUrl(title));
      await vi.waitFor(() =>
        expect(main()?.querySelector(".rail-list")?.textContent).toBe(linker.title),
      );
      expect(main()?.querySelector("h1")?.textContent).toBe(title);
      expect(main()?.querySelectorAll("button")).toHaveLength(0);
      expect(document.title).toBe(`${title} - personal-wiki`);
      // useId の連番は何回目の描画かで変わるだけで、画面の内容ではない
      shown.push(
        (main()?.innerHTML ?? "").replaceAll(title, "<title>").replace(/_r_[0-9a-z]+_/g, "<id>"),
      );
      act(() => root?.unmount());
      container?.remove();
      root = null;
    }
    expect(new Set(shown).size).toBe(1);
    expect(shown[0]).not.toContain("下書き");
    expect(shown[0]).not.toContain(hiddenLinker.title);
  });

  it("id の URL で見つからないページは「ページが見つかりません」を出す", async () => {
    serve("anonymous", [PUBLIC, DRAFT]);
    await renderAt("/p/ZZZZZZZZZZZZZZZZZZZZZZ");
    await vi.waitFor(() => expect(main()?.textContent).toContain("ページが見つかりません"));
    expect(document.title).toBe("personal-wiki");
    expect(listBacklinksByTitle).not.toHaveBeenCalled();
  });

  it("無いページへの link を押すと空のページへ移り、そのリンク元から戻れる", async () => {
    const linker: Page = { ...PUBLIC, body: "[[まだ無い題]]" };
    serve("anonymous", [linker]);
    await renderAt(titleUrl(linker.title));
    const link = await vi.waitFor(() => {
      const found = main()?.querySelector(".cm-wikilink");
      expect(found?.textContent).toBe("まだ無い題");
      return found as Element;
    });
    act(() => {
      link.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    await vi.waitFor(() => expect(location.pathname).toBe(titleUrl("まだ無い題")));
    await vi.waitFor(() =>
      expect(main()?.querySelector(".rail-list")?.textContent).toBe(linker.title),
    );
    expect(main()?.querySelector("h1")?.textContent).toBe("まだ無い題");
  });

  it("quick switcher には公開ページの title だけが出て、打った title の「作成」の行は出ない", async () => {
    stubUserAgent(LINUX_UA);
    serve("anonymous", [PUBLIC, DRAFT]);
    await renderAt("/");
    pressShortcut({ ctrlKey: true });
    await vi.waitFor(() => expect(switcherOptions()).toContain(PUBLIC.title));
    expect(switcherOptions()).not.toContain(DRAFT.title);
    typeInSwitcher("新しい題");
    await vi.waitFor(() =>
      expect(switcher()?.querySelector("[data-row-kind='content-search']")).not.toBeNull(),
    );
    expect(switcher()?.querySelector("[data-row-kind='create']")).toBeNull();
    expect(switcher()?.textContent).not.toContain("を作成");
  });

  it("予約語や形の合わないパスも同じ 404 を出す", async () => {
    serve("anonymous", [PUBLIC]);
    await renderAt("/p/short");
    await vi.waitFor(() => expect(main()?.textContent).toContain("ページが見つかりません"));
    expect(getPage).not.toHaveBeenCalled();
    expect(findPageByTitle).not.toHaveBeenCalled();
  });
});

describe("App の添付", () => {
  const NAME = `${"A".repeat(21)}b.png`;
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it.each([
    ["owner", true],
    ["owner", false],
    ["anonymous", true],
    ["anonymous", false],
  ] as const)(
    "%s で /api/me の features.attachments が %s のとき、画像の要求は features に従う",
    async (me, attachments) => {
      const recorder = recordImageSrcs();
      restore = recorder.restore;
      const page = { ...PUBLIC, body: `![[${NAME}]]` };
      serve(me, [page], attachments);
      await renderAt(titleUrl(page.title));
      await vi.waitFor(() =>
        expect(main()?.querySelector(".body-editor .cm-editor")).not.toBeNull(),
      );
      await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
      expect(recorder.srcs).toEqual(
        attachments ? [`/api/pages/${page.id}/attachments/${NAME}`] : [],
      );
    },
  );

  it("owner が draft の画像を埋め込んだページを開いてログアウトすると、その後は draft の id の画像を要求しない", async () => {
    const recorder = recordImageSrcs();
    restore = recorder.restore;
    const draft = { ...DRAFT, body: `![[${NAME}]]` };
    const page = { ...PUBLIC, body: `前文\n\n![[${draft.title}]]\n\n末尾` };
    serve("owner", [page, draft], true);
    await renderAt(titleUrl(page.title));
    const draftSrc = `/api/pages/${draft.id}/attachments/${NAME}`;
    await vi.waitFor(() => expect(recorder.srcs).toContain(draftSrc));

    const requestedBefore = recorder.srcs.length;
    const logoutButton = [...(header()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "ログアウト",
    );
    act(() => logoutButton?.click());
    await vi.waitFor(() =>
      expect(header()?.querySelector("a[href^='/_auth/login']")).not.toBeNull(),
    );
    await vi.waitFor(() => expect(main()?.querySelector("h1")?.textContent).toBe(page.title));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(recorder.srcs.slice(requestedBefore).filter((src) => src.includes(draft.id))).toEqual(
      [],
    );
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

  it("ログアウトに失敗してログイン状態が続くなら、止めた書き換えを再開し、画面はそのままにする", async () => {
    serve("owner", [PUBLIC]);
    let release: () => void = () => {};
    vi.mocked(stepLinkRewrites).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              value: { processed: null, conflict: false, failed: [], remaining: 1 },
            });
        }),
    );
    await renderAt("/");
    await vi.waitFor(() => expect(stepLinkRewrites).toHaveBeenCalledTimes(1));
    vi.mocked(logout).mockRejectedValueOnce(new Error("POST /_auth/logout が 500 を返した"));

    const logoutButton = [...(header()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "ログアウト",
    );
    act(() => logoutButton?.click());
    const logoutAgain = () =>
      [...(header()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "ログアウト");
    await vi.waitFor(() => expect(logoutAgain()?.disabled).toBe(false));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(main()?.querySelector("[role='alert']")).toBeNull();
    // 通信中の step の応答を待たずに 2 本目を送らない
    expect(stepLinkRewrites).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(stepLinkRewrites).toHaveBeenCalledTimes(2));
  });

  it("ログアウトに失敗してログイン状態が続くなら、書き換えられなかったページの通知を残す", async () => {
    serve("owner", [PUBLIC]);
    vi.mocked(stepLinkRewrites).mockResolvedValueOnce({
      ok: true,
      value: { processed: null, conflict: false, failed: ["failed-page"], remaining: 0 },
    });
    await renderAt("/");
    await vi.waitFor(() => expect(noticeDock()?.textContent).toContain("failed-page"));
    vi.mocked(logout).mockRejectedValueOnce(new Error("POST /_auth/logout が 500 を返した"));

    const logoutButton = [...(header()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "ログアウト",
    );
    act(() => logoutButton?.click());
    await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(logoutButton?.disabled).toBe(false));
    expect(noticeDock()?.textContent).toContain("failed-page");
  });

  it("ログアウトに失敗して状態も取得できなかったあと、ログイン中と分かっても、書き換えられなかったページの通知を残す", async () => {
    serve("owner", [PUBLIC]);
    vi.mocked(stepLinkRewrites).mockResolvedValueOnce({
      ok: true,
      value: { processed: null, conflict: false, failed: ["failed-page"], remaining: 0 },
    });
    await renderAt("/");
    await vi.waitFor(() => expect(noticeDock()?.textContent).toContain("failed-page"));
    vi.mocked(logout).mockRejectedValueOnce(new Error("落ちた"));
    vi.mocked(fetchMe).mockRejectedValueOnce(new Error("落ちた"));
    const logoutButton = [...(header()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "ログアウト",
    );
    act(() => logoutButton?.click());
    await vi.waitFor(() => expect(main()?.querySelector("[role='alert']")).not.toBeNull());

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await vi.waitFor(() => expect(main()?.querySelector("[role='alert']")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(noticeDock()?.textContent).toContain("failed-page");
    expect(stepLinkRewrites).toHaveBeenCalledTimes(1);
  });

  it("ログアウトの後に届いた保存の応答では、書き換えの step を送らない", async () => {
    serve("owner", [PUBLIC]);
    await renderAt("/");
    await vi.waitFor(() => expect(stepLinkRewrites).toHaveBeenCalledTimes(1));
    const logoutButton = [...(header()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "ログアウト",
    );
    act(() => logoutButton?.click());
    await vi.waitFor(() =>
      expect(header()?.querySelector("a[href^='/_auth/login']")).not.toBeNull(),
    );

    act(() => linkRewrites.start(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stepLinkRewrites).toHaveBeenCalledTimes(1);
  });

  it("ログアウトの応答が失敗しても匿名に移ったなら、覚えた draft の title を忘れる", async () => {
    serve("owner", [PUBLIC, DRAFT]);
    await renderAt("/");
    rememberTitle(DRAFT.id, DRAFT.title);
    vi.mocked(logout).mockRejectedValueOnce(new Error("応答が途中で切れた"));
    vi.mocked(fetchMe).mockResolvedValue({
      kind: "anonymous",
      features: { attachments: false, linkRewrites: true },
    });
    const logoutButton = [...(header()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "ログアウト",
    );
    act(() => logoutButton?.click());
    await vi.waitFor(() =>
      expect(header()?.querySelector("a[href^='/_auth/login']")).not.toBeNull(),
    );
    expect(recallTitle(DRAFT.id)).toBeUndefined();
  });

  it("ログアウトに失敗して状態も取得できなければ、エラーの画面にする", async () => {
    serve("owner", [PUBLIC]);
    await renderAt("/");
    vi.mocked(logout).mockRejectedValueOnce(new Error("落ちた"));
    vi.mocked(fetchMe).mockRejectedValue(new Error("落ちた"));
    const logoutButton = [...(header()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "ログアウト",
    );
    act(() => logoutButton?.click());
    await vi.waitFor(() => expect(main()?.querySelector("[role='alert']")).not.toBeNull());
  });

  it("ログアウトに失敗して状態も取得できなかったあと、通信が戻ってログイン中と分かれば、画面を戻して書き換えを続ける", async () => {
    serve("owner", [PUBLIC]);
    let release: () => void = () => {};
    vi.mocked(stepLinkRewrites).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              value: { processed: null, conflict: false, failed: [], remaining: 1 },
            });
        }),
    );
    await renderAt("/");
    await vi.waitFor(() => expect(stepLinkRewrites).toHaveBeenCalledTimes(1));
    vi.mocked(logout).mockRejectedValueOnce(new Error("落ちた"));
    vi.mocked(fetchMe).mockRejectedValueOnce(new Error("落ちた"));
    const logoutButton = [...(header()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "ログアウト",
    );
    act(() => logoutButton?.click());
    await vi.waitFor(() => expect(main()?.querySelector("[role='alert']")).not.toBeNull());
    release();
    expect(stepLinkRewrites).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await vi.waitFor(() => expect(main()?.querySelector("[role='alert']")).toBeNull());
    await vi.waitFor(() => expect(stepLinkRewrites).toHaveBeenCalledTimes(2));
  });

  it("ログアウトに失敗して状態も取得できなかったあと、通信が戻って匿名と分かれば、書き換えを送らずに匿名の画面にする", async () => {
    serve("owner", [PUBLIC]);
    await renderAt("/");
    await vi.waitFor(() => expect(stepLinkRewrites).toHaveBeenCalledTimes(1));
    vi.mocked(logout).mockRejectedValueOnce(new Error("落ちた"));
    vi.mocked(fetchMe).mockRejectedValueOnce(new Error("落ちた"));
    const logoutButton = [...(header()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "ログアウト",
    );
    act(() => logoutButton?.click());
    await vi.waitFor(() => expect(main()?.querySelector("[role='alert']")).not.toBeNull());
    vi.mocked(fetchMe).mockResolvedValue({
      kind: "anonymous",
      features: { attachments: false, linkRewrites: true },
    });

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await vi.waitFor(() =>
      expect(header()?.querySelector("a[href^='/_auth/login']")).not.toBeNull(),
    );
    expect(stepLinkRewrites).toHaveBeenCalledTimes(1);
  });

  it("ログイン中に /<title> を開くと編集の画面を出す", async () => {
    serve("owner", [PUBLIC]);
    await renderAt(titleUrl(PUBLIC.title));
    await vi.waitFor(() => expect(titleText()).toBe("公開の題"));
    expect(header()?.textContent).toContain("新規作成");
    expect(location.pathname).toBe(titleUrl(PUBLIC.title));
  });

  it("ヘッダーに検索と新規作成とログアウトを 1 行で並べ、ログイン中の表示は出さない", async () => {
    serve("owner", [PUBLIC]);
    await renderAt("/");
    await vi.waitFor(() =>
      expect(headerButtons()).toEqual(["ページを検索", "新規作成", "ログアウト"]),
    );
    expect(header()?.textContent).not.toContain("ログイン中");
  });

  describe("新規作成の画面", () => {
    const created: Page = { ...DRAFT, id: "NNNNNNNNNNNNNNNNNNNNNN", title: "ほげ", body: "" };
    const titleContent = () => main()?.querySelector<HTMLElement>(".title-input .cm-content");
    const bodyContent = () => main()?.querySelector<HTMLElement>(BODY_CONTENT);
    const plus = () => header()?.querySelector<HTMLButtonElement>("button[aria-label='新規作成']");
    const here = () => `${location.pathname}${location.search}`;
    const serveCreating = () => {
      serve("owner", [PUBLIC, DRAFT]);
      vi.mocked(createPage).mockImplementation(async (input) => ok({ ...created, ...input }));
    };
    const createdShown = () => vi.waitFor(() => expect(location.pathname).toBe(`/p/${created.id}`));
    const clickCreateOnNotFound = () => {
      const button = [...(main()?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent === "このタイトルで作成",
      );
      act(() => button?.click());
    };
    function commitTitle(text: string) {
      const editor = main()?.querySelector<HTMLElement>(".title-input .cm-editor");
      const view = editor ? EditorView.findFromDOM(editor) : null;
      if (!view) throw new Error("title の欄が無い");
      act(() => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: text.length },
          userEvent: "input.type",
        });
      });
      act(() => {
        view.contentDOM.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            keyCode: 13,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    }

    it("+ を押すと、その操作の中で /?new を開いて title 欄にフォーカスし、title を決めるまで作らない", async () => {
      serveCreating();
      await renderAt("/");
      act(() => plus()?.click());
      expect(here()).toBe("/?new");
      expect(document.activeElement).toBe(titleContent());
      await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
      expect(createPage).not.toHaveBeenCalled();
      expect(main()?.textContent).toContain("タイトルを決めると保存します");
    });

    it("title で Enter を押すと作って本文へ移り、/p/<id> に置き換えても編集の画面を作り直さない", async () => {
      serveCreating();
      await renderAt("/");
      act(() => plus()?.click());
      const body = bodyContent();
      commitTitle(created.title);
      expect(document.activeElement).toBe(body);
      await createdShown();
      expect(createPage).toHaveBeenCalledWith({ title: created.title, body: "" });
      expect(bodyContent()).toBe(body);
      expect(titleText()).toBe(created.title);
      expect(getPage).not.toHaveBeenCalled();
    });

    it("存在しない title の画面で作成すると、その操作の中で本文にフォーカスして作る", async () => {
      serveCreating();
      await renderAt(titleUrl(created.title));
      await vi.waitFor(() => expect(main()?.querySelector("h1")?.textContent).toBe(created.title));
      expect(main()?.textContent).toContain("まだありません");
      clickCreateOnNotFound();
      expect(here()).toBe("/?new");
      expect(document.activeElement).toBe(bodyContent());
      expect(titleText()).toBe(created.title);
      await createdShown();
      expect(createPage).toHaveBeenCalledWith({ title: created.title, body: "" });
      expect(document.activeElement).toBe(bodyContent());
    });

    it("空のページで作った後に戻ると、空のページを経ずにその前の画面へ戻る", async () => {
      serveCreating();
      await renderAt(`/p/${DRAFT.id}`);
      await vi.waitFor(() => expect(titleText()).toBe(DRAFT.title));
      act(() => navigate(titleUrl(created.title)));
      await vi.waitFor(() => expect(main()?.querySelector("h1")?.textContent).toBe(created.title));
      clickCreateOnNotFound();
      await createdShown();
      act(() => history.back());
      await vi.waitFor(() => expect(here()).toBe(`/p/${DRAFT.id}`));
      await vi.waitFor(() => expect(titleText()).toBe(DRAFT.title));
    });

    it("quick switcher の「作成」で作ると、閉じた後の本文にフォーカスがある", async () => {
      stubUserAgent(LINUX_UA);
      serveCreating();
      await renderAt("/");
      pressShortcut({ ctrlKey: true });
      await vi.waitFor(() => expect(switcher()?.open).toBe(true));
      typeInSwitcher(created.title);
      await vi.waitFor(() =>
        expect(switcher()?.querySelector("[data-row-kind='create']")).not.toBeNull(),
      );
      const input = switcher()?.querySelector<HTMLInputElement>("input[role='combobox']");
      // 既定は「本文から検索」なので、↓ で「作成」を選ぶ
      act(() => {
        input?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
        );
      });
      act(() => {
        input?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      });
      expect(switcher()?.open).toBe(false);
      expect(document.activeElement).toBe(bodyContent());
      await createdShown();
      expect(document.activeElement).toBe(bodyContent());
    });

    it("既存のページを開いたときは、本文にフォーカスしない", async () => {
      serveCreating();
      await renderAt(`/p/${DRAFT.id}`);
      await vi.waitFor(() => expect(bodyContent()).not.toBeNull());
      await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
      expect(document.activeElement).not.toBe(bodyContent());
    });

    it("作ったページを、別のページを挟んで開き直すと、本文にフォーカスしない", async () => {
      serveCreating();
      await renderAt(titleUrl(created.title));
      await vi.waitFor(() => expect(main()?.textContent).toContain("まだありません"));
      clickCreateOnNotFound();
      await createdShown();
      vi.mocked(getPage).mockImplementation(async (id) =>
        id === created.id ? ok(created) : id === DRAFT.id ? ok(DRAFT) : notFound,
      );
      act(() => navigate(`/p/${DRAFT.id}`));
      await vi.waitFor(() => expect(titleText()).toBe(DRAFT.title));
      act(() => navigate(`/p/${created.id}`));
      await vi.waitFor(() => expect(titleText()).toBe(created.title));
      await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
      expect(document.activeElement).not.toBe(bodyContent());
    });

    it("title が重複して作れなかったら、打った内容を残して直し方と既存のページへのリンクを出す", async () => {
      serve("owner", [PUBLIC]);
      vi.mocked(createPage).mockResolvedValue({
        ok: false,
        reason: "title_conflict",
        message: "同じ title のページがすでにあります。",
      });
      await renderAt(titleUrl("まだ無い題"));
      await vi.waitFor(() => expect(main()?.textContent).toContain("まだ無い題"));
      vi.mocked(findPageByTitle).mockResolvedValue(ok(PUBLIC));
      clickCreateOnNotFound();
      await vi.waitFor(() =>
        expect(container?.querySelector("[role='alert'] a")?.getAttribute("href")).toBe(
          titleUrl(PUBLIC.title),
        ),
      );
      expect(screenText()).toContain("タイトルを変えて Enter を押すと、もう一度作ります。");
      expect(here()).toBe("/?new");
      expect(titleText()).toBe("まだ無い題");
    });

    const typeBody = (text: string) => {
      const editor = main()?.querySelector<HTMLElement>(".body-editor .cm-editor");
      const view = editor ? EditorView.findFromDOM(editor) : null;
      if (!view) throw new Error("本文の欄が無い");
      act(() => {
        view.dispatch({
          changes: { from: view.state.doc.length, insert: text },
          userEvent: "input.type",
        });
      });
    };
    const statusText = () => main()?.querySelector(".save-state")?.textContent;
    const newBackupKeys = () =>
      Object.keys(localStorage).filter((key) => key.startsWith("personal-wiki:draft:new:"));

    it("内容のある /?new で + を押すと、URL も画面も変えず、title 欄にフォーカスを移す", async () => {
      serveCreating();
      await renderAt("/");
      act(() => plus()?.click());
      const length = history.length;
      const body = bodyContent();
      typeBody("打ちかけ");
      act(() => body?.focus());
      act(() => plus()?.click());
      expect(here()).toBe("/?new");
      expect(history.length).toBe(length);
      expect(bodyContent()).toBe(body);
      expect(body?.textContent).toBe("打ちかけ");
      expect(document.activeElement).toBe(titleContent());
      expect(screenText()).not.toContain("この端末に退避されています");
      await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
      expect(createPage).not.toHaveBeenCalled();
    });

    it("空の /?new で + を押すと、履歴を置き換えて新しい空の画面を開く", async () => {
      serveCreating();
      await renderAt("/");
      act(() => plus()?.click());
      const length = history.length;
      const body = bodyContent();
      act(() => plus()?.click());
      expect(here()).toBe("/?new");
      expect(history.length).toBe(length);
      expect(bodyContent()).not.toBe(body);
      expect(document.activeElement).toBe(titleContent());
      expect(screenText()).not.toContain("この端末に退避されています");
    });

    it("内容のある作る前の画面からアプリ内のリンクで離れると、+ で開いた次の画面が復元を尋ねる", async () => {
      serveCreating();
      await renderAt("/");
      act(() => plus()?.click());
      typeBody("打ちかけ");
      act(() => navigate("/"));
      await vi.waitFor(() => expect(main()?.querySelector(".title-input")).toBeNull());
      act(() => plus()?.click());
      expect(here()).toBe("/?new");
      await vi.waitFor(() => expect(screenText()).toContain("この端末に退避されています"));
      expect(createPage).not.toHaveBeenCalled();
    });

    it("作る応答を待つ間に + を押すと、作れた後も新しい空の画面のまま", async () => {
      serve("owner", [PUBLIC, DRAFT]);
      let resolve: (value: Awaited<ReturnType<typeof createPage>>) => void = () => {};
      vi.mocked(createPage).mockReturnValue(
        new Promise((r) => {
          resolve = r;
        }),
      );
      await renderAt("/");
      act(() => plus()?.click());
      commitTitle(created.title);
      await vi.waitFor(() => expect(createPage).toHaveBeenCalledTimes(1));
      act(() => plus()?.click());
      await act(async () => resolve(ok(created)));
      await act(() => new Promise((r) => setTimeout(r, 30)));
      expect(here()).toBe("/?new");
      expect(titleText()).toBe("");
      expect(statusText()).toBe("タイトルを決めると保存します");
      expect(screenText()).not.toContain("この端末に退避されています");
      expect(newBackupKeys()).toEqual([]);
    });

    it("作った後に戻るで /?new に来ると、作ったページではなく新しい空の画面を開く", async () => {
      serveCreating();
      await renderAt("/");
      act(() => plus()?.click());
      act(() => navigate("/?new#a"));
      commitTitle(created.title);
      await vi.waitFor(() => expect(here()).toBe(`/p/${created.id}`));
      expect(location.hash).toBe("#a");
      act(() => history.back());
      await vi.waitFor(() => expect(here()).toBe("/?new"));
      await vi.waitFor(() => expect(titleText()).toBe(""));
      expect(statusText()).toBe("タイトルを決めると保存します");
      expect(createPage).toHaveBeenCalledTimes(1);
    });

    it("作る前に hash だけ戻っても、打ちかけの画面を作り直さない", async () => {
      serveCreating();
      await renderAt("/");
      act(() => plus()?.click());
      act(() => navigate("/?new#a"));
      const body = bodyContent();
      typeBody("打ちかけ");
      act(() => history.back());
      await vi.waitFor(() => expect(location.hash).toBe(""));
      await act(() => new Promise((r) => setTimeout(r, 30)));
      expect(bodyContent()).toBe(body);
      expect(bodyContent()?.textContent).toBe("打ちかけ");
    });

    it("匿名で /?new を開くと、作成の画面を出さずにログインを案内する", async () => {
      serve("anonymous", [PUBLIC]);
      await renderAt("/?new");
      await vi.waitFor(() =>
        expect(main()?.querySelector("h1")?.textContent).toBe("ログインが必要です"),
      );
      expect(main()?.querySelector(".cm-editor")).toBeNull();
      expect(createPage).not.toHaveBeenCalled();
    });
  });

  it("owner の空のページは、draft を含むリンク元と作成の導線を出す", async () => {
    const linker: Page = { ...PUBLIC, id: "LLLLLLLLLLLLLLLLLLLLLL", body: "[[まだ無い題]]" };
    const draftLinker: Page = {
      ...DRAFT,
      id: "HHHHHHHHHHHHHHHHHHHHHH",
      title: "下書きのリンク元",
      body: "[[まだ無い題]]",
    };
    serve("owner", [linker, draftLinker]);
    await renderAt(titleUrl("まだ無い題"));
    await vi.waitFor(() =>
      expect(
        [...(main()?.querySelectorAll(".rail-list a") ?? [])].map((a) => a.textContent).sort(),
      ).toEqual([draftLinker.title, linker.title].sort()),
    );
    expect(main()?.querySelector("h1")?.textContent).toBe("まだ無い題");
    expect(main()?.textContent).toContain("作成すると下書きのページができます");
    expect([...(main()?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
      "このタイトルで作成",
    ]);
  });

  it("id の URL で見つからないときは、作成の導線を出さない", async () => {
    serve("owner", [PUBLIC]);
    await renderAt("/p/ZZZZZZZZZZZZZZZZZZZZZZ");
    await vi.waitFor(() => expect(main()?.textContent).toContain("ページが見つかりません"));
    expect(main()?.querySelectorAll("button")).toHaveLength(0);
  });

  it("検索のボタンと Ctrl+K で quick switcher を開き、Ctrl+K でもう一度押すと閉じる", async () => {
    stubUserAgent(LINUX_UA);
    serve("owner", [PUBLIC]);
    await renderAt("/");
    expect(switcher()?.open).toBe(false);
    const search = header()?.querySelector<HTMLButtonElement>("button[aria-label='ページを検索']");
    expect(search?.getAttribute("aria-keyshortcuts")).toBe("Control+K");
    expect(search?.querySelector("kbd")?.textContent).toBe("Ctrl K");
    act(() => search?.click());
    await vi.waitFor(() => expect(switcher()?.open).toBe(true));
    pressShortcut({ ctrlKey: true });
    await vi.waitFor(() => expect(switcher()?.open).toBe(false));
    pressShortcut({ ctrlKey: true });
    await vi.waitFor(() => expect(switcher()?.open).toBe(true));
  });

  it("Mac では ⌘K だけで開き、Ctrl+K はエディタの行末削除に任せて開かない", async () => {
    stubUserAgent(MAC_UA);
    // 本文が空なら、Mac で Ctrl+K を CodeMirror が処理しても本文は変わらない（保存が走らない）
    serve("owner", [{ ...DRAFT, body: "" }]);
    await renderAt(titleUrl(DRAFT.title));
    await vi.waitFor(() => expect(main()?.querySelector(BODY_CONTENT)).not.toBeNull());
    const search = header()?.querySelector<HTMLButtonElement>("button[aria-label='ページを検索']");
    expect(search?.getAttribute("aria-keyshortcuts")).toBe("Meta+K");
    expect(search?.querySelector("kbd")?.textContent).toBe("⌘K");

    const content = editorContent();
    content.focus();
    pressShortcut({ ctrlKey: true }, content);
    expect(switcher()?.open).toBe(false);

    pressShortcut({ metaKey: true }, content);
    await vi.waitFor(() => expect(switcher()?.open).toBe(true));
  });

  it("Mac 以外では Ctrl+K を編集部品の中からも受け、⌘K は受けない", async () => {
    stubUserAgent(LINUX_UA);
    // 本文が空なら、Mac で Ctrl+K を CodeMirror が処理しても本文は変わらない（保存が走らない）。
    // CodeMirror は UA でなく navigator.platform で Mac を見分けるので、Mac で走らせると UA を
    // 差し替えても行末削除が先に動く。空でない title の欄から送ると title を消して preventDefault する
    serve("owner", [{ ...DRAFT, body: "" }]);
    await renderAt(titleUrl(DRAFT.title));
    await vi.waitFor(() => expect(main()?.querySelector(BODY_CONTENT)).not.toBeNull());
    const content = editorContent();
    content.focus();
    pressShortcut({ metaKey: true }, content);
    expect(switcher()?.open).toBe(false);
    pressShortcut({ ctrlKey: true }, content);
    await vi.waitFor(() => expect(switcher()?.open).toBe(true));
  });

  it("先に処理されたキーと、押しっぱなしの繰り返しでは開閉しない", async () => {
    stubUserAgent(LINUX_UA);
    serve("owner", [PUBLIC]);
    await renderAt("/");
    pressShortcut({ ctrlKey: true, repeat: true });
    expect(switcher()?.open).toBe(false);

    const claim = (event: Event) => event.preventDefault();
    document.addEventListener("keydown", claim);
    try {
      pressShortcut({ ctrlKey: true }, document.body);
    } finally {
      document.removeEventListener("keydown", claim);
    }
    expect(switcher()?.open).toBe(false);
  });

  it("owner が開いた quick switcher には draft の title が出て、ログアウトして開き直すと出ない", async () => {
    stubUserAgent(LINUX_UA);
    serve("owner", [PUBLIC, DRAFT]);
    await renderAt("/");
    const openSwitcher = () =>
      act(() =>
        header()?.querySelector<HTMLButtonElement>("button[aria-label='ページを検索']")?.click(),
      );
    openSwitcher();
    await vi.waitFor(() => expect(switcherOptions()).toContain(DRAFT.title));
    pressShortcut({ ctrlKey: true });
    await vi.waitFor(() => expect(switcher()?.open).toBe(false));

    const logoutButton = [...(header()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "ログアウト",
    );
    act(() => logoutButton?.click());
    await vi.waitFor(() =>
      expect(header()?.querySelector("a[href^='/_auth/login']")).not.toBeNull(),
    );
    openSwitcher();
    await vi.waitFor(() => expect(switcherOptions()).toContain(PUBLIC.title));
    expect(switcherOptions()).not.toContain(DRAFT.title);
    expect(switcher()?.textContent).not.toContain(DRAFT.title);
  });

  it("quick switcher で新しい title を打つと「作成」の行を出す", async () => {
    stubUserAgent(LINUX_UA);
    serve("owner", [PUBLIC]);
    await renderAt("/");
    pressShortcut({ ctrlKey: true });
    await vi.waitFor(() => expect(switcher()?.open).toBe(true));
    typeInSwitcher("新しい題");
    await vi.waitFor(() =>
      expect(switcher()?.querySelector("[data-row-kind='create']")?.textContent).toBe(
        "「新しい題」を作成",
      ),
    );
  });

  it("見出しの fragment 付きの URL を開くと、編集の画面でも見出しにカーソルを置く", async () => {
    const page = { ...DRAFT, body: "前文\n\n# 節A\n\n本文\n\n## 節B\n\n末尾" };
    serve("owner", [page]);
    await renderAt(`${titleUrl(page.title)}#${encodeURIComponent("節A")}`);
    await vi.waitFor(() => expect(location.pathname).toBe(`/p/${page.id}`));
    expect(location.hash).toBe(`#${encodeURIComponent("節A")}`);
    expect(cursorOf()).toBe(page.body.indexOf("# 節A"));
  });

  it("/<title> で開いた draft は /p/<id> に置き換える", async () => {
    serve("owner", [DRAFT]);
    await renderAt(titleUrl(DRAFT.title));
    await vi.waitFor(() => expect(location.pathname).toBe(`/p/${DRAFT.id}`));
    expect(titleText()).toBe("下書きの題");
    expect(findPageByTitle).toHaveBeenCalledTimes(1);
    expect(getPage).not.toHaveBeenCalled();
  });
});

describe("App のリンクの書き換えの再開", () => {
  it("owner が開いたら、残っている書き換えを 1 回確かめ、残りがあれば最後まで進めて結果を出す", async () => {
    vi.mocked(stepLinkRewrites)
      .mockResolvedValueOnce({
        ok: true,
        value: {
          processed: {
            sourcePageId: PUBLIC.id,
            title: PUBLIC.title,
            visibility: "public",
            version: 2,
            rewritten: 1,
          },
          conflict: false,
          failed: [],
          remaining: 1,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { processed: null, conflict: false, failed: [], remaining: 0 },
      });
    serve("owner", [PUBLIC, DRAFT]);
    await renderAt("/");
    await vi.waitFor(() =>
      expect(screenText()).toContain("1 ページのリンクを新しいタイトルに書き換えました"),
    );
    expect(stepLinkRewrites).toHaveBeenCalledTimes(2);
    expect(screenText()).toContain("うち公開 1 ページ");
  });

  it("残りが無ければ 1 回だけ呼び、何も出さない", async () => {
    serve("owner", [PUBLIC]);
    await renderAt("/");
    await vi.waitFor(() => expect(stepLinkRewrites).toHaveBeenCalledTimes(1));
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(stepLinkRewrites).toHaveBeenCalledTimes(1);
    expect(main()?.textContent).not.toContain("書き換え");
  });

  it("匿名と、features の無い Worker では呼ばない", async () => {
    serve("anonymous", [PUBLIC]);
    await renderAt("/");
    await vi.waitFor(() =>
      expect(main()?.querySelector(`a[href='${titleUrl(PUBLIC.title)}']`)).not.toBeNull(),
    );
    act(() => root?.unmount());
    container?.remove();

    serve("owner", [PUBLIC], false, false);
    await renderAt("/");
    await vi.waitFor(() =>
      expect(main()?.querySelector(`a[href='${titleUrl(PUBLIC.title)}']`)).not.toBeNull(),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(stepLinkRewrites).not.toHaveBeenCalled();
  });
});
