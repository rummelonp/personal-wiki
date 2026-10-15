import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page as screen } from "vitest/browser";
import { setLoadingDelay } from "./Loading";
import { PageReader } from "./PageReader";
import { forgetTitles, recallTitle } from "./page-titles";
import {
  type ApiResult,
  createPage,
  findPageByTitle,
  listBacklinks,
  type Page,
  resolvePages,
} from "./pages-api";
import { navigate } from "./route";
import { recordImageSrcs } from "./test-image-srcs";

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
  };
});

const PAGE: Page = {
  id: "AAAAAAAAAAAAAAAAAAAAAA",
  title: "公開の題",
  body: "本文 #タグ\n\n[[有る]] [[無い]]",
  visibility: "public",
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const startUrl = location.href;

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.mocked(listBacklinks).mockResolvedValue(ok({ pages: [], nextCursor: null }));
  // 匿名には draft が null で届くので、「無い」は存在しないページと draft のどちらでもありうる
  vi.mocked(resolvePages).mockImplementation(async (titles) =>
    ok(
      titles.map((title) =>
        title === "有る"
          ? { id: "BBBBBBBBBBBBBBBBBBBBBB", title, visibility: "public" as const }
          : null,
      ),
    ),
  );
  vi.mocked(findPageByTitle).mockResolvedValue({ ok: false, reason: "not_found" });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  history.replaceState(null, "", startUrl);
});

function renderReader(
  page: Page = PAGE,
  onShown: (page: Pick<Page, "id" | "title" | "visibility">) => void = () => {},
  attachments = false,
) {
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  act(() => mounted.render(<PageReader page={page} onShown={onShown} attachments={attachments} />));
  const view = () => {
    const editor = container?.querySelector<HTMLElement>(".cm-editor");
    const found = editor ? EditorView.findFromDOM(editor) : null;
    if (!found) throw new Error("エディタが無い");
    return found;
  };
  return { view };
}

const buttonTexts = () =>
  [...(container?.querySelectorAll("button") ?? [])].map((b) => b.textContent ?? "");

const clickLink = (text: string) => {
  const link = [...(container?.querySelectorAll(".cm-wikilink") ?? [])].find(
    (e) => e.textContent === text,
  );
  if (!link) throw new Error(`${text} の link が無い`);
  act(() => {
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  });
};

const flushAsync = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

describe("PageReader", () => {
  it("本文を読み取り専用で出し、owner の操作を出さない", async () => {
    const { view } = renderReader();
    await flushAsync();
    expect(view().state.readOnly).toBe(true);
    expect(container?.querySelector("input")).toBeNull();
    expect(container?.querySelector("h1")?.textContent).toBe("公開の題");
    for (const label of ["新規", "公開", "下書き", "削除", "保存"]) {
      expect(buttonTexts().some((text) => text.includes(label))).toBe(false);
    }
  });

  it("本文の領域は、見出しの title を名前に持つ article として読める", () => {
    renderReader();
    expect(screen.getByRole("article", { name: "公開の題", exact: true }).element()).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "公開の題" }).element()).not.toBeNull();
  });

  it("右の列にタグのチップを重ねない。タグは本文の #tag だけに出る", () => {
    renderReader({ ...PAGE, body: "本文 #タグ" });
    expect(container?.querySelector(".chip-link")).toBeNull();
    expect(container?.querySelectorAll(".cm-tag")).toHaveLength(1);
  });

  it("本文の #tag を押すと、タグの一覧へ移る", () => {
    renderReader({ ...PAGE, body: "本文 #タグ" });
    const tag = container?.querySelector(".cm-tag");
    if (!tag) throw new Error("#tag が描かれていない");
    act(() => {
      tag.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    expect(location.pathname + location.search).toBe(`/?tag=${encodeURIComponent("タグ")}`);
  });

  it("リンク元が無いときは、「このページへのリンク」の節ごと出さない", async () => {
    renderReader();
    await vi.waitFor(() => expect(listBacklinks).toHaveBeenCalled());
    await flushAsync();
    expect(container?.querySelector(".rail-section-links")).toBeNull();
    expect(container?.textContent).not.toContain("このページへのリンク");
    // 情報の節など、ほかの区画は残る
    expect(container?.textContent).toContain("情報");
  });

  it("リンク元が有るときは節を出す", async () => {
    vi.mocked(listBacklinks).mockResolvedValue(
      ok({
        pages: [
          {
            id: "BBBBBBBBBBBBBBBBBBBBBB",
            title: "元",
            visibility: "public" as const,
            updatedAt: 0,
          },
        ],
        nextCursor: null,
      }),
    );
    renderReader();
    await vi.waitFor(() =>
      expect(container?.querySelector(".rail-section-links")?.textContent).toContain("元"),
    );
  });

  it("表示したページを onShown で伝える", () => {
    const onShown = vi.fn();
    renderReader(PAGE, onShown);
    expect(onShown).toHaveBeenCalledWith({
      id: PAGE.id,
      title: PAGE.title,
      visibility: "public",
    });
  });

  it("公開されたページへの link だけを /<title> の <a href> にする", async () => {
    renderReader();
    await vi.waitFor(() =>
      expect(
        [...(container?.querySelectorAll("a[href]") ?? [])]
          .map((a) => a.getAttribute("href"))
          .filter((href) => href !== null && !href.startsWith("/?")),
      ).toEqual([`/${encodeURIComponent("有る")}`]),
    );
    expect(
      [...document.querySelectorAll(".cm-wikilink-unresolved")].map((e) => e.textContent),
    ).toEqual(["無い"]);
  });

  it("公開されたページへの link のクリックで /<title> へ遷移する", async () => {
    renderReader();
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalled());
    await flushAsync();
    clickLink("有る");
    await vi.waitFor(() => expect(location.pathname).toBe(`/${encodeURIComponent("有る")}`));
  });

  it("link で移る前に、行き先の page の id に対する title を覚える", async () => {
    forgetTitles();
    renderReader();
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalled());
    await flushAsync();
    expect(recallTitle("BBBBBBBBBBBBBBBBBBBBBB")).toBeUndefined();
    clickLink("有る");
    await vi.waitFor(() => expect(location.pathname).toBe(`/${encodeURIComponent("有る")}`));
    expect(recallTitle("BBBBBBBBBBBBBBBBBBBBBB")).toBe("有る");
    forgetTitles();
  });

  it("link の行き先を調べている間は、画面を薄くして開いている途中だと伝える", async () => {
    const restoreDelay = setLoadingDelay(0);
    let answer: (result: Awaited<ReturnType<typeof findPageByTitle>>) => void = () => {};
    vi.mocked(findPageByTitle).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    try {
      renderReader();
      await vi.waitFor(() => expect(resolvePages).toHaveBeenCalled());
      await flushAsync();
      clickLink("無い");
      await vi.waitFor(() =>
        expect(container?.querySelector(".note")?.classList.contains("note-leaving")).toBe(true),
      );
      expect(container?.querySelector(".note")?.getAttribute("aria-busy")).toBe("true");
      expect(container?.textContent).toContain("「無い」を開いています…");
      // 押し直しても、問い合わせを最初からやり直さない
      const asked = () =>
        vi.mocked(findPageByTitle).mock.calls.length + vi.mocked(resolvePages).mock.calls.length;
      const before = asked();
      clickLink("無い");
      await flushAsync();
      expect(asked()).toBe(before);

      await act(async () => answer({ ok: false, reason: "not_found" }));
      await vi.waitFor(() => expect(location.pathname).toBe(`/${encodeURIComponent("無い")}`));
      expect(container?.querySelector(".note-leaving")).toBeNull();
      expect(container?.textContent).not.toContain("を開いています…");
    } finally {
      restoreDelay();
    }
  });

  it("開けない link は、案内を出さずに title の URL の空のページへ移る", async () => {
    renderReader();
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalled());
    await flushAsync();
    clickLink("無い");
    await vi.waitFor(() => expect(location.pathname).toBe(`/${encodeURIComponent("無い")}`));
    expect(container?.textContent).not.toContain("ページはありません");
    expect(createPage).not.toHaveBeenCalled();
  });

  it("title の URL にできない開けない link は「ページはありません」とだけ出し、作成の操作を出さない", async () => {
    renderReader({ ...PAGE, body: "[[api]]" });
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalled());
    await flushAsync();
    clickLink("api");
    await vi.waitFor(() => expect(container?.textContent).toContain("「api」のページはありません"));
    expect(container?.textContent).not.toContain("下書き");
    expect(buttonTexts()).toEqual(["閉じる"]);
    expect(location.pathname).toBe(new URL(startUrl).pathname);
    expect(createPage).not.toHaveBeenCalled();
  });

  it("見出し付きの開けない link は、見出しを捨てて title の URL の空のページへ移る", async () => {
    renderReader({ ...PAGE, body: "[[無い#見出し]]" });
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalled());
    await flushAsync();
    clickLink("無い#見出し");
    await vi.waitFor(() => expect(location.pathname).toBe(`/${encodeURIComponent("無い")}`));
    expect(location.hash).toBe("");
  });

  it("保存できる長さを超える title への link は、空のページへ移らず「ページはありません」を出す", async () => {
    const long = "あ".repeat(800);
    renderReader({ ...PAGE, body: `[[${long}]]` });
    await flushAsync();
    clickLink(long);
    await vi.waitFor(() =>
      expect(container?.textContent).toContain(`「${long}」のページはありません`),
    );
    expect(location.pathname).toBe(new URL(startUrl).pathname);
    expect(createPage).not.toHaveBeenCalled();
  });
});

describe("見出しと block への移動", () => {
  /** filler が長いと、先頭の link は移動後のスクロールで描かれなくなる。スクロールを見るテストだけ長くする */
  const bodyOf = (filler: string) =>
    [
      "[[#節B]] [[#^blk]] [[有る#見出し]] [[有る^id]] [[#無い見出し]] [[公開の題#節A]]",
      "",
      filler,
      "",
      "# 節A",
      "",
      "本文",
      "",
      "## 節B",
      "",
      "段落 ^blk",
      "",
      filler,
    ].join("\n");
  const LONG = bodyOf(Array.from({ length: 60 }, (_, i) => `行 ${i}`).join("\n\n"));
  const BODY = bodyOf("間");
  const PAGE_WITH_HEADINGS: Page = { ...PAGE, body: BODY };
  const at = (needle: string) => BODY.indexOf(needle);
  const hashOf = (text: string) => `#${encodeURIComponent(text)}`;

  const hrefOfLink = (text: string) =>
    [...(container?.querySelectorAll("a[href]") ?? [])]
      .find((a) => a.textContent === text)
      ?.getAttribute("href");

  beforeEach(() => {
    // 前のテストのスクロールが残ると、先頭の行が描かれない
    window.scrollTo(0, 0);
    // 自分への link は、解決先が自分のページになる
    vi.mocked(resolvePages).mockImplementation(async (titles) =>
      ok(
        titles.map((title) => {
          if (title === "有る") {
            return { id: "BBBBBBBBBBBBBBBBBBBBBB", title, visibility: "public" as const };
          }
          return title === PAGE.title
            ? { id: PAGE.id, title, visibility: "public" as const }
            : null;
        }),
      ),
    );
    vi.mocked(findPageByTitle).mockImplementation(async (title) =>
      title === PAGE.title ? ok(PAGE_WITH_HEADINGS) : { ok: false, reason: "not_found" },
    );
  });

  it("link の href に見出しと block の場所を fragment で付ける", async () => {
    renderReader(PAGE_WITH_HEADINGS);
    const path = `/${encodeURIComponent("有る")}`;
    await vi.waitFor(() => expect(hrefOfLink("有る#見出し")).toBe(`${path}${hashOf("見出し")}`));
    expect(hrefOfLink("有る^id")).toBe(`${path}#%5Eid`);
    expect(hrefOfLink("#節B")).toBe(hashOf("節B"));
    expect(hrefOfLink("#^blk")).toBe("#%5Eblk");
    expect(hrefOfLink("公開の題#節A")).toBe(`/${encodeURIComponent("公開の題")}${hashOf("節A")}`);
  });

  it("hash が見出しを指すページを開くと、その見出しへカーソルを置いてスクロールする", async () => {
    history.replaceState(null, "", `${location.pathname}${hashOf("節A")}`);
    const { view } = renderReader({ ...PAGE, body: LONG });
    expect(view().state.selection.main.head).toBe(LONG.indexOf("# 節A"));
    // ページを開いただけでは focus しない（モバイルでキーボードが出る）
    expect(view().hasFocus).toBe(false);
    await vi.waitFor(() => {
      const top = view().coordsAtPos(LONG.indexOf("# 節A"))?.top ?? Number.NaN;
      expect(top).toBeGreaterThanOrEqual(0);
      // y: "start" で、見出しの行は画面の上端のすぐ下に来る
      expect(top).toBeLessThan(100);
    });
  });

  it("hash が block を指すページを開くと、その段落へ移る", () => {
    history.replaceState(null, "", `${location.pathname}#%5Eblk`);
    const { view } = renderReader(PAGE_WITH_HEADINGS);
    expect(view().state.selection.main.head).toBe(at("段落 ^blk"));
  });

  it("見つからない見出しと block は、開いたときも hash の変化でも先頭のまま何も出さない", () => {
    history.replaceState(null, "", `${location.pathname}${hashOf("無い")}`);
    const { view } = renderReader(PAGE_WITH_HEADINGS);
    expect(view().state.selection.main.head).toBe(0);
    // hash の変化は hook の経路（navigate）で流す。replaceState はイベントを出さない
    act(() => navigate(`${location.pathname}#%5Enone`));
    expect(view().state.selection.main.head).toBe(0);
    act(() => navigate(`${location.pathname}${hashOf("存在しない見出し")}`));
    expect(view().state.selection.main.head).toBe(0);
    expect(container?.querySelector("[role=alert]")).toBeNull();
    // 同じ経路で、あるものには移る
    act(() => navigate(`${location.pathname}${hashOf("節B")}`));
    expect(view().state.selection.main.head).toBe(at("## 節B"));
  });

  it("同じページの link は遷移もページの問い合わせもせず、その位置へ移る", async () => {
    const { view } = renderReader(PAGE_WITH_HEADINGS);
    await flushAsync();
    const pathname = location.pathname;
    clickLink("#節B");
    expect(view().state.selection.main.head).toBe(at("## 節B"));
    // link を押しても focus しない（モバイルでキーボードが出る。記号も現れる）
    expect(view().hasFocus).toBe(false);
    expect(location.pathname).toBe(pathname);
    expect(location.hash).toBe(hashOf("節B"));
    for (const [titles] of vi.mocked(resolvePages).mock.calls) expect(titles).not.toContain("");
    clickLink("#^blk");
    expect(view().state.selection.main.head).toBe(at("段落 ^blk"));
    expect(location.hash).toBe("#%5Eblk");
  });

  it("同じ hash の link を、スクロールで離れた後にもう一度押すと戻る", async () => {
    const { view } = renderReader(PAGE_WITH_HEADINGS);
    await flushAsync();
    clickLink("#節B");
    act(() => view().dispatch({ selection: { anchor: BODY.length } }));
    clickLink("#節B");
    expect(view().state.selection.main.head).toBe(at("## 節B"));
  });

  it("見つからない見出しへの同じページの link は、hash だけ変えて何も動かさない", async () => {
    const { view } = renderReader(PAGE_WITH_HEADINGS);
    await flushAsync();
    clickLink("#無い見出し");
    expect(view().state.selection.main.head).toBe(0);
    expect(container?.querySelector("[role=alert]")).toBeNull();
  });

  it("自分の title への link も、遷移せずにその見出しへ移る", async () => {
    const { view } = renderReader(PAGE_WITH_HEADINGS);
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalled());
    await flushAsync();
    const pathname = location.pathname;
    clickLink("公開の題#節A");
    await vi.waitFor(() => expect(view().state.selection.main.head).toBe(at("# 節A")));
    expect(location.pathname).toBe(pathname);
  });

  it("ほかのページの見出しへの link は、遷移先の URL に fragment を付ける", async () => {
    renderReader(PAGE_WITH_HEADINGS);
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalled());
    await flushAsync();
    clickLink("有る#見出し");
    await vi.waitFor(() =>
      expect(`${location.pathname}${location.hash}`).toBe(
        `/${encodeURIComponent("有る")}${hashOf("見出し")}`,
      ),
    );
  });

  it("戻る、進むで fragment 付きの URL に戻ると、位置を合わせる", async () => {
    const { view } = renderReader(PAGE_WITH_HEADINGS);
    await flushAsync();
    clickLink("#節B");
    clickLink("#^blk");
    expect(view().state.selection.main.head).toBe(at("段落 ^blk"));
    const moved = (head: number) =>
      vi.waitFor(() => expect(view().state.selection.main.head).toBe(head));
    act(() => view().contentDOM.blur());
    history.back();
    await moved(at("## 節B"));
    expect(location.hash).toBe(hashOf("節B"));
    history.forward();
    await moved(at("段落 ^blk"));
    // 戻る、進むでは focus しない
    expect(view().hasFocus).toBe(false);
  });

  it("別のページへ fragment 付きで移る遷移では、遷移前のページの本文を動かさない", async () => {
    const { view } = renderReader(PAGE_WITH_HEADINGS);
    await flushAsync();
    act(() => navigate(`/${encodeURIComponent("別の題")}${hashOf("節B")}`));
    expect(view().state.selection.main.head).toBe(0);
  });

  it("正の URL への置き換えの後も、同じページの hash の変化には移る", async () => {
    const { view } = renderReader(PAGE_WITH_HEADINGS);
    await flushAsync();
    act(() => navigate(`/${encodeURIComponent(PAGE.title)}`, { replace: true }));
    act(() => navigate(`/${encodeURIComponent(PAGE.title)}${hashOf("節B")}`));
    expect(view().state.selection.main.head).toBe(at("## 節B"));
  });
});

describe("PageReader の添付の表示", () => {
  const NAME = `${"A".repeat(21)}b.png`;
  const OTHER = `${"C".repeat(21)}d.png`;
  let restore: (() => void) | null = null;

  function recordSrcs(): string[] {
    const recorder = recordImageSrcs();
    restore = recorder.restore;
    return recorder.srcs;
  }

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("本文の添付を、このページの id の URL で表示する", async () => {
    const srcs = recordSrcs();
    renderReader({ ...PAGE, body: `![[${NAME}]]` }, undefined, true);
    await flushAsync();
    expect(srcs).toEqual([`/api/pages/${PAGE.id}/attachments/${NAME}`]);
  });

  it("features が false なら画像の要求を出さない", async () => {
    const srcs = recordSrcs();
    renderReader({ ...PAGE, body: `![[${NAME}]]` });
    await flushAsync();
    expect(srcs).toEqual([]);
  });

  it("埋め込んだ公開ページの添付は、埋め込み先の id の URL で表示する", async () => {
    const srcs = recordSrcs();
    const otherId = "BBBBBBBBBBBBBBBBBBBBBB";
    vi.mocked(findPageByTitle).mockImplementation(async (title) =>
      title === "別"
        ? ok({ ...PAGE, id: otherId, title: "別", body: `![[${OTHER}]]` })
        : { ok: false, reason: "not_found" },
    );
    renderReader({ ...PAGE, body: "![[別]]" }, undefined, true);
    await vi.waitFor(() => expect(srcs).toEqual([`/api/pages/${otherId}/attachments/${OTHER}`]));
  });

  it("匿名に読めない（draft の）埋め込み先は展開されず、その id の要求も出さない", async () => {
    const srcs = recordSrcs();
    // API は匿名の draft を not_found で返す
    vi.mocked(findPageByTitle).mockResolvedValue({ ok: false, reason: "not_found" });
    renderReader({ ...PAGE, body: "![[下書き]]" }, undefined, true);
    await flushAsync();
    expect(srcs).toEqual([]);
    expect(container?.querySelector(".cm-embed-unresolved")).not.toBeNull();
  });
});
