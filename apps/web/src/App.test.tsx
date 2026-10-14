import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { fetchMe, logout } from "./api";
import { linkRewrites } from "./link-rewrites";
import { stepLinkRewrites } from "./link-rewrites-api";
import {
  type ApiResult,
  createPage,
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
const titleText = () => main()?.querySelector(".title-input .cm-content")?.textContent;
const header = () => container?.querySelector("header");
/** ヘッダーのボタンの名前（新規作成のダイアログの中は除く）。匿名には検索だけが出る。 */
const headerButtons = () =>
  [...(header()?.querySelectorAll("button") ?? [])]
    .filter((b) => b.closest("dialog") === null)
    .map((b) => b.getAttribute("aria-label") ?? b.textContent);

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
    await renderAt("/");
    await vi.waitFor(() => expect(stepLinkRewrites).toHaveBeenCalledTimes(1));
    vi.mocked(logout).mockRejectedValueOnce(new Error("POST /_auth/logout が 500 を返した"));

    const logoutButton = [...(header()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "ログアウト",
    );
    act(() => logoutButton?.click());
    await vi.waitFor(() => expect(stepLinkRewrites).toHaveBeenCalledTimes(2));
    const logoutAgain = () =>
      [...(header()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "ログアウト");
    await vi.waitFor(() => expect(logoutAgain()?.disabled).toBe(false));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(main()?.querySelector("[role='alert']")).toBeNull();
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

  it("存在しない title を開くと、「まだありません」と作成の導線を出し、作ると編集の画面へ移る", async () => {
    serve("owner", [PUBLIC]);
    const created: Page = { ...DRAFT, id: "NNNNNNNNNNNNNNNNNNNNNN", title: "まだ無い題" };
    vi.mocked(createPage).mockResolvedValue(ok(created));
    vi.mocked(getPage).mockImplementation(async (id) =>
      id === created.id ? ok(created) : notFound,
    );
    await renderAt(titleUrl("まだ無い題"));
    await vi.waitFor(() =>
      expect(main()?.querySelector("h1")?.textContent).toBe("「まだ無い題」はまだありません"),
    );
    const create = [...(main()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "このタイトルで作成",
    );
    act(() => create?.click());
    await vi.waitFor(() => expect(location.pathname).toBe(`/p/${created.id}`));
    expect(createPage).toHaveBeenCalledWith({ title: "まだ無い題", body: "" });
    await vi.waitFor(() => expect(main()?.querySelector(".cm-editor")).not.toBeNull());
    expect(titleText()).toBe("まだ無い題");
  });

  describe("作ったページの本文にカーソルを置く", () => {
    const created: Page = { ...DRAFT, id: "NNNNNNNNNNNNNNNNNNNNNN", title: "ほげ", body: "" };
    const bodyHasFocus = () => document.activeElement === editorContent();
    const serveCreating = () => {
      serve("owner", [PUBLIC, DRAFT]);
      vi.mocked(createPage).mockResolvedValue(ok(created));
      vi.mocked(getPage).mockImplementation(async (id) =>
        id === created.id ? ok(created) : id === DRAFT.id ? ok(DRAFT) : notFound,
      );
    };
    const settledEditor = () =>
      vi.waitFor(() => {
        expect(location.pathname).toBe(`/p/${created.id}`);
        expect(main()?.querySelector(BODY_CONTENT)).not.toBeNull();
      });

    it("存在しない title の画面で作成すると、移った先の本文にフォーカスする", async () => {
      serveCreating();
      await renderAt(titleUrl(created.title));
      await vi.waitFor(() => expect(main()?.textContent).toContain("まだありません"));
      const create = [...(main()?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent === "このタイトルで作成",
      );
      act(() => create?.click());
      await settledEditor();
      await vi.waitFor(() => expect(bodyHasFocus()).toBe(true));
    });

    it("新規作成のダイアログで作成すると、ダイアログが閉じた後も本文にフォーカスがある", async () => {
      serveCreating();
      await renderAt("/");
      const open = header()?.querySelector<HTMLButtonElement>("button[aria-label='新規作成']");
      act(() => open?.click());
      const dialog = header()?.querySelector<HTMLDialogElement>("dialog.dialog");
      const input = dialog?.querySelector<HTMLInputElement>("input.text-input");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      act(() => {
        setter?.call(input, created.title);
        input?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const submit = [...(dialog?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent === "作成",
      );
      act(() => submit?.click());
      await settledEditor();
      await vi.waitFor(() => expect(dialog?.open).toBe(false));
      expect(bodyHasFocus()).toBe(true);
    });

    it("quick switcher の「作成」で作ると、移った先の本文にフォーカスする", async () => {
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
      act(() => {
        input?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      });
      await settledEditor();
      await vi.waitFor(() => expect(switcher()?.open).toBe(false));
      expect(bodyHasFocus()).toBe(true);
    });

    it("既存のページを開いたときは、本文にフォーカスしない", async () => {
      serveCreating();
      await renderAt(`/p/${DRAFT.id}`);
      await vi.waitFor(() => expect(main()?.querySelector(BODY_CONTENT)).not.toBeNull());
      await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
      expect(bodyHasFocus()).toBe(false);
    });

    it("作った直後のページを開き直すと、2 回目は本文にフォーカスしない", async () => {
      serveCreating();
      await renderAt(titleUrl(created.title));
      await vi.waitFor(() => expect(main()?.textContent).toContain("まだありません"));
      const create = [...(main()?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent === "このタイトルで作成",
      );
      act(() => create?.click());
      await settledEditor();
      await vi.waitFor(() => expect(bodyHasFocus()).toBe(true));
      act(() => navigate(`/p/${DRAFT.id}`));
      await vi.waitFor(() => expect(titleText()).toBe(DRAFT.title));
      act(() => navigate(`/p/${created.id}`));
      await vi.waitFor(() => expect(titleText()).toBe(created.title));
      await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
      expect(bodyHasFocus()).toBe(false);
    });
  });

  it("title が重複して作れなかったら、理由を出して既存のページを開ける", async () => {
    serve("owner", [PUBLIC]);
    vi.mocked(createPage).mockResolvedValue({
      ok: false,
      reason: "title_conflict",
      message: "同じ title のページがすでにある",
    });
    await renderAt(titleUrl("まだ無い題"));
    await vi.waitFor(() => expect(main()?.textContent).toContain("まだ無い題"));
    vi.mocked(findPageByTitle).mockResolvedValue(ok(PUBLIC));
    const create = [...(main()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "このタイトルで作成",
    );
    act(() => create?.click());
    await vi.waitFor(() =>
      expect(main()?.querySelector("[role='alert'] a")?.getAttribute("href")).toBe(
        `/p/${PUBLIC.id}`,
      ),
    );
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
      expect(main()?.textContent).toContain("1 ページのリンクを新しい title に書き換えました"),
    );
    expect(stepLinkRewrites).toHaveBeenCalledTimes(2);
    expect(main()?.textContent).toContain("うち公開 1 ページ");
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
