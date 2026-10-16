import { EditorView } from "@codemirror/view";
import { MAX_BODY_BYTES, MAX_TITLE_BYTES, utf8ByteLength } from "@personal-wiki/domain/page-input";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page as screen } from "vitest/browser";
import { isInView } from "./in-view";
import { setLoadingDelay } from "./Loading";
import { linkRewrites } from "./link-rewrites";
import { type LinkRewriteStepResult, stepLinkRewrites } from "./link-rewrites-api";
import { PageEditor } from "./PageEditor";
import { recallTitle } from "./page-titles";
import {
  type ApiResult,
  createPage,
  deletePage,
  findPageByTitle,
  getPage,
  listBacklinks,
  listPageTitles,
  type Page,
  resolvePages,
  setVisibility,
  updatePage,
} from "./pages-api";
import { navigate } from "./route";
import { recordImageSrcs } from "./test-image-srcs";

vi.mock("./link-rewrites-api", () => ({ stepLinkRewrites: vi.fn() }));

// 上端の保存の状態が見えているかは、画面の位置で決まる。既定では見えないことにし、試験ごとに切り替える
vi.mock("./in-view", () => ({ isInView: vi.fn() }));

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

const ID = "AAAAAAAAAAAAAAAAAAAAAA";
const PAGE: Page = {
  id: ID,
  title: "題",
  body: "本文",
  visibility: "draft",
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};
const BACKUP_KEY = `personal-wiki:draft:${ID}`;

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// vitest の iframe は URL の query で orchestrator と結ばれているので、遷移の試験の後に元へ戻す
const startUrl = location.href;

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  localStorage.clear();
  vi.mocked(isInView).mockReturnValue(false);
  vi.mocked(updatePage).mockImplementation(async (_id, version, input) =>
    ok({ ...PAGE, ...input, version: version + 1 }),
  );
  vi.mocked(getPage).mockResolvedValue(ok(PAGE));
  // 削除は押す前に window.confirm で確かめる。既定では承認する
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.mocked(findPageByTitle).mockResolvedValue({ ok: false, reason: "not_found" });
  vi.mocked(listBacklinks).mockResolvedValue(ok({ pages: [], nextCursor: null }));
  vi.mocked(listPageTitles).mockResolvedValue(ok({ pages: [], nextCursor: null }));
  // 既定では、どの link も存在することにして印を付けない
  vi.mocked(resolvePages).mockImplementation(async (titles) =>
    ok(titles.map((title) => ({ id: "B", title, visibility: "draft" as const }))),
  );
});

afterEach(() => {
  linkRewrites.stop();
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  history.replaceState(null, "", startUrl);
});

function renderPage(page: Page = PAGE, attachments = false) {
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  act(() => mounted.render(<PageEditor page={page} attachments={attachments} />));
  const view = () => {
    // `.cm-content` から探すと、展開した embed の中の view に当たることがある。title 欄も
    // CodeMirror なので、本文の枠から探す
    const editor = container?.querySelector<HTMLElement>(".body-editor .cm-editor");
    const found = editor ? EditorView.findFromDOM(editor) : null;
    if (!found) throw new Error("エディタが無い");
    return found;
  };
  const button = (name: string) => {
    const found = [...(container?.querySelectorAll("button") ?? [])].find((b) =>
      b.textContent?.includes(name),
    );
    if (!found) throw new Error(`${name} のボタンが無い`);
    return found;
  };
  return { view, button };
}

function typeAtEnd(view: EditorView, text: string, userEvent = "input.type"): void {
  const end = view.state.doc.length;
  view.dispatch({
    changes: { from: end, insert: text },
    selection: { anchor: end + text.length },
    userEvent,
  });
}

/** React の再描画（useSyncExternalStore の通知は microtask で描く）と、保存の Promise を待つ */
const flushAsync = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

describe("PageEditor と本文のエディタ", () => {
  it("リンク元が無いときも、owner には「このページへのリンク」の節と「ありません」を出す", async () => {
    renderPage();
    await vi.waitFor(() => expect(listBacklinks).toHaveBeenCalled());
    await flushAsync();
    const section = container?.querySelector(".rail-section-links");
    expect(section?.textContent).toContain("このページへのリンク");
    expect(section?.textContent).toContain("ありません");
  });

  it("フォーカスが外れたら、入力した本文を保存する", async () => {
    const { view } = renderPage();
    view().focus();
    typeAtEnd(view(), "を書き足す");
    act(() => view().contentDOM.blur());
    await flushAsync();
    expect(updatePage).toHaveBeenCalledWith(
      ID,
      1,
      { title: "題", body: "本文を書き足す" },
      expect.anything(),
    );
  });

  it("もう一度保存する間は、失敗の通知を保存中の通知に置き換え、終わると消す", async () => {
    vi.mocked(updatePage).mockResolvedValueOnce({ ok: false, reason: "error", message: "失敗" });
    const { view, button } = renderPage();
    view().focus();
    typeAtEnd(view(), "を書き足す");
    act(() => view().contentDOM.blur());
    await flushAsync();
    const titleOf = () => container?.querySelector(".notice-title")?.textContent;
    expect(titleOf()).toBe("保存に失敗しました");

    let finish: (value: ApiResult<Page>) => void = () => {};
    vi.mocked(updatePage).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    act(() => button("もう一度保存する").click());
    await flushAsync();
    expect(titleOf()).toBe("保存しています…");
    expect(container?.querySelectorAll(".notice")).toHaveLength(1);
    expect(container?.querySelector("[role='alert']")).toBeNull();
    // 進行は上端の保存の状態が読み上げるので、通知では重ねて読み上げない
    expect(container?.querySelector(".notice [role]")).toBeNull();

    await act(async () => finish(ok({ ...PAGE, body: "本文を書き足す", version: 2 })));
    await flushAsync();
    expect(container?.querySelector(".notice")).toBeNull();
  });

  it("もう一度保存する間、上端の保存の状態が見えていれば、台には保存中の通知を出さない", async () => {
    vi.mocked(updatePage).mockResolvedValueOnce({ ok: false, reason: "error", message: "失敗" });
    const { view, button } = renderPage();
    view().focus();
    typeAtEnd(view(), "を書き足す");
    act(() => view().contentDOM.blur());
    await flushAsync();

    let finish: (value: ApiResult<Page>) => void = () => {};
    vi.mocked(updatePage).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    vi.mocked(isInView).mockReturnValue(true);
    act(() => button("もう一度保存する").click());
    await flushAsync();
    // 上端の「保存中…」と同じ保存を指すので、二重に出さない
    expect(container?.querySelector(".save-state")?.textContent).toBe("保存中…");
    expect(container?.querySelector(".notice")).toBeNull();

    // 保存の間に下までスクロールして上端が見えなくなったら、台に出す
    vi.mocked(isInView).mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(container?.querySelector(".notice-title")?.textContent).toBe("保存しています…");

    // 上端に戻れば、また台からは消える
    vi.mocked(isInView).mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(container?.querySelector(".notice")).toBeNull();

    await act(async () => finish(ok({ ...PAGE, body: "本文を書き足す", version: 2 })));
    await flushAsync();
    expect(container?.querySelector(".notice")).toBeNull();
  });

  it("上端が見えていて進行の通知が出なかったときも、再び失敗したら alert を出し直す", async () => {
    vi.mocked(updatePage).mockResolvedValueOnce({ ok: false, reason: "error", message: "失敗" });
    const { view, button } = renderPage();
    view().focus();
    typeAtEnd(view(), "を書き足す");
    act(() => view().contentDOM.blur());
    await flushAsync();

    let fail: (value: ApiResult<Page>) => void = () => {};
    vi.mocked(updatePage).mockReturnValueOnce(
      new Promise((resolve) => {
        fail = resolve;
      }),
    );
    vi.mocked(isInView).mockReturnValue(true);
    act(() => button("もう一度保存する").click());
    await flushAsync();
    expect(container?.querySelector(".notice")).toBeNull();

    await act(async () => fail({ ok: false, reason: "error", message: "また失敗" }));
    await flushAsync();
    expect(container?.querySelector(".notice [role='alert']")?.textContent).toContain(
      "保存に失敗しました",
    );
  });

  it("もう一度保存してまた失敗すると、失敗の通知を alert として出し直す", async () => {
    vi.mocked(updatePage).mockResolvedValueOnce({ ok: false, reason: "error", message: "失敗" });
    const { view, button } = renderPage();
    view().focus();
    typeAtEnd(view(), "を書き足す");
    act(() => view().contentDOM.blur());
    await flushAsync();

    let fail: (value: ApiResult<Page>) => void = () => {};
    vi.mocked(updatePage).mockReturnValueOnce(
      new Promise((resolve) => {
        fail = resolve;
      }),
    );
    act(() => button("もう一度保存する").click());
    await flushAsync();
    const progress = container?.querySelector(".notice");
    expect(progress?.querySelector(".notice-title")?.textContent).toBe("保存しています…");

    await act(async () => fail({ ok: false, reason: "error", message: "また失敗" }));
    await flushAsync();
    const alert = container?.querySelector(".notice [role='alert']");
    expect(alert?.textContent).toContain("保存に失敗しました");
    expect(container?.querySelector(".notice")).not.toBe(progress);
  });

  it("もう一度保存して 409 になると、最新を取り直す間も保存中の通知を残し、衝突の通知に替える", async () => {
    vi.mocked(updatePage).mockResolvedValueOnce({ ok: false, reason: "error", message: "失敗" });
    const { view, button } = renderPage();
    view().focus();
    typeAtEnd(view(), "を書き足す");
    act(() => view().contentDOM.blur());
    await flushAsync();
    expect(container?.querySelector(".notice-title")?.textContent).toBe("保存に失敗しました");

    vi.mocked(updatePage).mockResolvedValueOnce({
      ok: false,
      reason: "version_conflict",
      currentVersion: 2,
    });
    let latest: (value: ApiResult<Page>) => void = () => {};
    vi.mocked(getPage).mockReturnValueOnce(
      new Promise((resolve) => {
        latest = resolve;
      }),
    );
    act(() => button("もう一度保存する").click());
    await flushAsync();
    // 409 を受けて最新を取りにいく間は、通知が空白にならず、まだ保存の途中として見える
    const notices = () => [...(container?.querySelectorAll(".notice") ?? [])];
    expect(notices().map((n) => n.querySelector(".notice-title")?.textContent)).toEqual([
      "保存しています…",
    ]);
    expect(container?.querySelector("[role='alert']")).toBeNull();

    await act(async () => latest(ok({ ...PAGE, body: "サーバーの本文", version: 2 })));
    await flushAsync();
    // 衝突が決まったら、進行の通知は衝突の通知と並ばずに消える
    expect(notices().map((n) => n.querySelector(".notice-title")?.textContent)).toEqual([
      "サーバーの内容と食い違っています",
    ]);
  });

  describe.each([
    {
      name: "ログイン切れ",
      end: { ok: false, reason: "unauthorized" } as const,
      remaining: ["ログインの期限が切れました"],
      latest: null,
    },
    {
      name: "ページの消失",
      end: { ok: false, reason: "version_conflict", currentVersion: 2 } as const,
      remaining: ["このページはサーバーにありません"],
      // 衝突を知らされて最新を取りにいくと 404 で決まる
      latest: { ok: false, reason: "not_found" } as const,
    },
  ])("もう一度保存して $name になるとき", ({ end, remaining, latest }) => {
    it("保存中の通知は、その通知と並ばずに消える", async () => {
      vi.mocked(updatePage).mockResolvedValueOnce({ ok: false, reason: "error", message: "失敗" });
      const { view, button } = renderPage();
      view().focus();
      typeAtEnd(view(), "を書き足す");
      act(() => view().contentDOM.blur());
      await flushAsync();

      let finish: (value: ApiResult<Page>) => void = () => {};
      vi.mocked(updatePage).mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      if (latest !== null) vi.mocked(getPage).mockResolvedValueOnce(latest);
      const titles = () =>
        [...(container?.querySelectorAll(".notice-title") ?? [])].map((h) => h.textContent);
      act(() => button("もう一度保存する").click());
      await flushAsync();
      expect(titles()).toEqual(["保存しています…"]);

      // 描き直しのたびに、通知の並びを残す
      const seen: Array<Array<string | null>> = [];
      const observer = new MutationObserver(() => seen.push(titles()));
      observer.observe(container as HTMLElement, { childList: true, subtree: true });
      await act(async () => finish(end));
      await flushAsync();
      observer.disconnect();

      expect(titles()).toEqual(remaining);
      for (const snapshot of seen) {
        expect(snapshot.includes("保存しています…") && snapshot.length > 1).toBe(false);
      }
    });
  });

  it("変換中にページを離れても、未確定文字まで退避に残す", async () => {
    vi.mocked(updatePage).mockResolvedValue({ ok: false, reason: "error", message: "失敗" });
    const { view } = renderPage();
    const v = view();
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    typeAtEnd(v, "へんかんちゅう", "input.type.compose");
    await flushAsync();

    // pagehide は使わない。vitest の orchestrator が iframe の pagehide を見張っていて、
    // 5 秒後までテストが続いていると遷移したとみなし、ファイル全体を失敗にする
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
    const saved = JSON.parse(localStorage.getItem(BACKUP_KEY) ?? "null");
    expect(saved).toMatchObject({ body: "本文へんかんちゅう", baseVersion: 1 });
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await flushAsync();
  });

  it("保存が衝突したら読み取り専用にし、サーバーの版を取り込むと replaceDoc で差し替えて編集に戻す", async () => {
    const server: Page = { ...PAGE, body: "サーバーの本文", version: 2 };
    vi.mocked(updatePage).mockResolvedValue({
      ok: false,
      reason: "version_conflict",
      currentVersion: 2,
    });
    vi.mocked(getPage).mockResolvedValue(ok(server));
    const { view, button } = renderPage();
    const v = view();
    v.focus();
    typeAtEnd(v, "の手元の変更");
    act(() => v.contentDOM.blur());
    await flushAsync();

    expect(v.state.readOnly).toBe(true);
    expect(v.state.doc.toString()).toBe("本文の手元の変更");

    // 押すと通知の中で確かめる。やめれば何も変わらず、衝突の画面が残る
    act(() => button("サーバーの版を取り込む").click());
    await flushAsync();
    expect(container?.textContent).toContain(
      "手元の変更を破棄して、サーバーの版を取り込みますか？",
    );
    expect(document.activeElement).toBe(button("やめる"));
    act(() => button("やめる").click());
    await flushAsync();
    expect(v.state.readOnly).toBe(true);
    expect(v.state.doc.toString()).toBe("本文の手元の変更");
    expect(document.activeElement).toBe(button("サーバーの版を取り込む"));

    act(() => button("サーバーの版を取り込む").click());
    await flushAsync();
    act(() => button("取り込む").click());
    await flushAsync();
    expect(view()).toBe(v);
    expect(v.state.doc.toString()).toBe("サーバーの本文");
    expect(v.state.readOnly).toBe(false);
    // 押したボタンは消えるので、focus は本文に戻る
    expect(document.activeElement).toBe(v.contentDOM);
  });

  it("タッチ端末では、衝突を解決しても本文に focus を戻さず、キーボードを開き直さない", async () => {
    const coarse = vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(pointer: coarse)",
          media: query,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    // ページの枠が見える範囲の外にある状態で解決し、focus を移してもスクロールしないことを見る
    const spacer = document.createElement("div");
    spacer.style.height = "5000px";
    document.body.append(spacer);
    try {
      vi.mocked(updatePage).mockResolvedValue({
        ok: false,
        reason: "version_conflict",
        currentVersion: 2,
      });
      vi.mocked(getPage).mockResolvedValue(ok({ ...PAGE, body: "サーバーの本文", version: 2 }));
      const { view, button } = renderPage();
      const v = view();
      v.focus();
      typeAtEnd(v, "の手元の変更");
      act(() => v.contentDOM.blur());
      await flushAsync();

      act(() => button("サーバーの版を取り込む").click());
      await flushAsync();
      window.scrollTo(0, 4000);
      const scrolled = window.scrollY;
      expect(scrolled).toBeGreaterThan(0);
      act(() => button("取り込む").click());
      await flushAsync();
      expect(v.state.doc.toString()).toBe("サーバーの本文");
      const article = container?.querySelector("article");
      expect(document.activeElement).toBe(article);
      expect(window.scrollY).toBe(scrolled);
      // 枠は focus を移す間だけ受け取れる。外れたら、タップで本文の focus を奪わないよう元に戻す
      act(() => v.contentDOM.focus());
      expect(article?.hasAttribute("tabindex")).toBe(false);
    } finally {
      coarse.mockRestore();
      spacer.remove();
    }
  });

  it("サーバーの版を取り込んだ後の undo で、取り込む前の手元の編集を新しい本文から取り消さない", async () => {
    // 別のタブで同じ編集に続けて書き足した版。手元の編集が新しい本文にも残る
    const server: Page = { ...PAGE, body: "本文の手元の変更と別のタブの追記", version: 2 };
    vi.mocked(updatePage).mockResolvedValue({
      ok: false,
      reason: "version_conflict",
      currentVersion: 2,
    });
    vi.mocked(getPage).mockResolvedValue(ok(server));
    const { view, button } = renderPage();
    const v = view();
    v.focus();
    typeAtEnd(v, "の手元の変更");
    act(() => v.contentDOM.blur());
    await flushAsync();
    act(() => button("サーバーの版を取り込む").click());
    act(() => button("取り込む").click());
    await flushAsync();
    expect(v.state.doc.toString()).toBe(server.body);

    const undo = async () => {
      act(() => {
        v.contentDOM.dispatchEvent(
          new InputEvent("beforeinput", { inputType: "historyUndo", cancelable: true }),
        );
      });
      await flushAsync();
    };
    await undo();
    expect(v.state.doc.toString()).toBe(server.body);

    // 取り込んだ後の編集は、同じ操作で取り消せる（undo の操作が届いていることの確認）
    typeAtEnd(v, "!");
    expect(v.state.doc.toString()).toBe(`${server.body}!`);
    await undo();
    expect(v.state.doc.toString()).toBe(server.body);
  });

  it("退避が未決の間は読み取り専用にし、復元すると退避の本文に差し替える", async () => {
    localStorage.setItem(
      BACKUP_KEY,
      JSON.stringify({ title: "題", body: "退避した本文", baseVersion: 1, savedAt: 0 }),
    );
    const { view, button } = renderPage();
    const v = view();
    expect(v.state.readOnly).toBe(true);
    expect(v.contentDOM.getAttribute("inputmode")).toBe("none");
    expect(v.state.doc.toString()).toBe("本文");

    act(() => button("復元する").click());
    await flushAsync();
    expect(v.state.doc.toString()).toBe("退避した本文");
    expect(v.state.readOnly).toBe(false);
    expect(v.contentDOM.hasAttribute("inputmode")).toBe(false);
  });

  it("[[ の title の候補に title の一覧を使う", async () => {
    vi.mocked(listPageTitles).mockResolvedValue(
      ok({
        pages: [{ id: "B", title: "別のページ", visibility: "draft", updatedAt: 0 }],
        nextCursor: null,
      }),
    );
    const { view } = renderPage();
    await flushAsync();
    expect(listPageTitles).toHaveBeenCalledWith(null);

    view().focus();
    typeAtEnd(view(), "\n[[別");
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll(".cm-tooltip-autocomplete li")].map((li) => li.textContent),
      ).toContain("別のページ"),
    );
  });
});

describe("保存の前の検査の表示", () => {
  const OVER = "あ".repeat(Math.ceil(MAX_BODY_BYTES / 3) + 1);
  const alertNotice = () =>
    [...(container?.querySelectorAll(".notice") ?? [])].find((notice) =>
      notice.textContent?.includes("保存できません"),
    );

  it("本文が上限を超えたら、送らずに超えた量と直し方を出し、減らすと保存する", async () => {
    const { view } = renderPage();
    view().focus();
    act(() => typeAtEnd(view(), OVER));
    await flushAsync();
    const bytes = utf8ByteLength(`本文${OVER}`);
    expect(container?.querySelector(".save-state")?.textContent).toBe("保存できません");
    expect(alertNotice()?.querySelector(".notice-title")?.textContent).toBe(
      "本文が長すぎて保存できません",
    );
    expect(alertNotice()?.textContent).toContain(
      `${(bytes - MAX_BODY_BYTES).toLocaleString("ja-JP")} バイト以上減らすか`,
    );
    // 数は打つたびに変わるので、通知自体は読み上げず、原因だけを status で伝える
    expect(alertNotice()?.querySelector("[role]")).toBeNull();
    const meter = container?.querySelector(".body-meter .input-meter");
    expect(meter?.classList).toContain("input-meter-over");
    expect(meter?.textContent).toContain(
      `${bytes.toLocaleString("ja-JP")} / ${MAX_BODY_BYTES.toLocaleString("ja-JP")} バイト`,
    );
    act(() => view().contentDOM.blur());
    await flushAsync();
    expect(updatePage).not.toHaveBeenCalled();

    act(() => {
      view().dispatch({
        changes: { from: 2, to: view().state.doc.length, insert: "短い" },
        userEvent: "delete",
      });
    });
    act(() => view().focus());
    act(() => view().contentDOM.blur());
    await vi.waitFor(() =>
      expect(updatePage).toHaveBeenCalledWith(
        ID,
        1,
        { title: "題", body: "本文短い" },
        expect.anything(),
      ),
    );
    expect(alertNotice()).toBeUndefined();
    expect(container?.querySelector(".body-meter .input-meter")?.classList).toContain(
      "input-meter-normal",
    );
  });

  it("本文の NUL は、通知のボタンでその文字を選択して消せる", async () => {
    const { view, button } = renderPage();
    view().focus();
    act(() => typeAtEnd(view(), "\n二行目\u0000"));
    await flushAsync();
    expect(alertNotice()?.textContent).toContain("本文の 2 行目に、目に見えない文字（NUL）");
    act(() => view().contentDOM.blur());
    act(() => button("その文字を選択する").click());
    await vi.waitFor(() => expect(view().hasFocus).toBe(true));
    const { from, to } = view().state.selection.main;
    expect(view().state.sliceDoc(from, to)).toBe("\u0000");

    act(() => view().dispatch(view().state.replaceSelection("")));
    await flushAsync();
    expect(alertNotice()).toBeUndefined();
  });

  it("保存済みの内容に問題があっても、手を付けるまでは通知を出さない", async () => {
    renderPage({ ...PAGE, body: "古い\u0000" });
    await flushAsync();
    expect(alertNotice()).toBeUndefined();
    expect(container?.querySelector(".save-state")?.textContent).toBe("保存済み");
  });

  it("保存で title の重複と言われたら、再試行は出さず、既存のページを開く導線を出す", async () => {
    vi.mocked(updatePage).mockResolvedValueOnce({
      ok: false,
      reason: "title_conflict",
      message: "同じタイトルのページがすでにあります。",
      existing: { id: "B", title: "別の題", visibility: "public" },
    });
    renderPage();
    act(() => titleView().focus());
    typeTitle("別の題");
    act(() => titleView().contentDOM.blur());
    await flushAsync();
    const alert = container?.querySelector("[role='alert']");
    expect(alert?.querySelector(".notice-title")?.textContent).toBe(
      "同じタイトルのページがあるため、保存できません",
    );
    expect(alert?.textContent).toContain("タイトルを変えて Enter を押すと、保存します。");
    expect(alert?.querySelector("a")?.textContent).toBe("そのページを開く");
    expect(alert?.textContent).not.toContain("もう一度保存する");
  });

  it("title が上限の 8 割を超えたら、欄の下に長さを出す", () => {
    renderPage();
    const meter = () => container?.querySelector(".title-hint .input-meter");
    act(() => titleView().focus());
    typeTitle("a".repeat(Math.floor(MAX_TITLE_BYTES * 0.8) - 1));
    expect(meter()).toBeNull();
    typeTitle("a".repeat(MAX_TITLE_BYTES + 1));
    expect(meter()?.classList).toContain("input-meter-over");
    expect(meter()?.textContent).toContain("1,025 / 1,024 バイト");
    // 読み上げでは、欄の説明として長さを伝える
    const describedBy = titleView().contentDOM.getAttribute("aria-describedby");
    expect(document.getElementById(describedBy ?? "")?.textContent).toContain("1,025");
  });

  it("リンクに書けない文字を title に打つと、欄の下でその文字を知らせる", () => {
    renderPage();
    act(() => titleView().focus());
    typeTitle("a#b|c");
    expect(container?.querySelector(".title-hint")?.textContent).toBe(
      "「#」「|」はリンクに書けない文字です",
    );
  });
});

describe("PageEditor の tag", () => {
  const pressTag = (init: MouseEventInit = {}) => {
    const tag = container?.querySelector(".cm-tag");
    if (!tag) throw new Error("#tag が描かれていない");
    act(() => {
      tag.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init }),
      );
    });
  };

  it("本文の #tag の素のクリックは、チップと同じタグの一覧へ移る", () => {
    renderPage({ ...PAGE, body: "本文 #タグ" });
    pressTag();
    expect(location.pathname + location.search).toBe(`/?tag=${encodeURIComponent("タグ")}`);
  });

  it("修飾キー付きのクリックは移らず、エディタの既定（選択）に任せる", () => {
    renderPage({ ...PAGE, body: "本文 #タグ" });
    const before = location.pathname + location.search;
    pressTag({ shiftKey: true });
    expect(location.pathname + location.search).toBe(before);
  });
});

describe("PageEditor の wikilink", () => {
  const clickLink = (text: string) => {
    const link = [...(container?.querySelectorAll(".cm-wikilink") ?? [])].find(
      (e) => e.textContent === text,
    );
    if (!link) throw new Error(`${text} の link が無い`);
    act(() => {
      link.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
  };

  it("存在するページへの link は、クリックでそのページへ SPA 遷移する", async () => {
    vi.mocked(resolvePages).mockImplementation(async (titles) =>
      ok(
        titles.map((title) => ({
          id: "BBBBBBBBBBBBBBBBBBBBBB",
          title,
          visibility: "draft" as const,
        })),
      ),
    );
    renderPage({ ...PAGE, body: "[[別]]" });
    clickLink("別");
    await vi.waitFor(() => expect(location.pathname).toBe("/p/BBBBBBBBBBBBBBBBBBBBBB"));
  });

  it("link で別ページへ移る前に、行き先の title を覚えさせる", async () => {
    vi.mocked(resolvePages).mockImplementation(async (titles) =>
      ok(
        titles.map((title) => ({
          id: "BBBBBBBBBBBBBBBBBBBBBB",
          title,
          visibility: "draft" as const,
        })),
      ),
    );
    renderPage({ ...PAGE, body: "[[別]]" });
    clickLink("別");
    await vi.waitFor(() => expect(location.pathname).toBe("/p/BBBBBBBBBBBBBBBBBBBBBB"));
    expect(recallTitle("BBBBBBBBBBBBBBBBBBBBBB")).toBe("別");
  });

  it("存在しない title だけに未解決の印を付ける", async () => {
    vi.mocked(resolvePages).mockImplementation(async (titles) =>
      ok(
        titles.map((title) =>
          title === "有る" ? { id: "B", title, visibility: "draft" as const } : null,
        ),
      ),
    );
    renderPage({ ...PAGE, body: "[[有る]] [[無い]]" });
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll(".cm-wikilink-unresolved")].map((e) => e.textContent),
      ).toEqual(["無い"]),
    );
    expect(resolvePages).toHaveBeenCalledTimes(1);
  });

  it("存在の確認が失敗しても、どの link にも印を付けない", async () => {
    vi.mocked(resolvePages).mockResolvedValue({ ok: false, reason: "error", message: "500" });
    renderPage({ ...PAGE, body: "[[無い]]" });
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalled());
    await flushAsync();
    expect(document.querySelectorAll(".cm-wikilink-unresolved")).toHaveLength(0);
  });

  it("無いページの link をクリックすると、案内を出さずに title の URL の空のページへ移る", async () => {
    vi.mocked(resolvePages).mockImplementation(async (titles) => ok(titles.map(() => null)));
    renderPage({ ...PAGE, body: "[[無い]]" });
    clickLink("無い");
    await vi.waitFor(() => expect(location.pathname).toBe(`/${encodeURIComponent("無い")}`));
    expect(container?.textContent).not.toContain("まだありません");
    expect(createPage).not.toHaveBeenCalled();
  });

  it("title の URL にできない無いページの link は、作成の案内を出し、「作成して開く」で新規作成の画面へ移る", async () => {
    vi.mocked(resolvePages).mockImplementation(async (titles) => ok(titles.map(() => null)));
    const { button } = renderPage({ ...PAGE, body: "[[api]]" });
    clickLink("api");
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("「api」のページはまだありません"),
    );
    expect(location.pathname).toBe(new URL(startUrl).pathname);

    // 作るのは移った先の新規作成の画面
    act(() => button("作成して開く").click());
    expect(`${location.pathname}${location.search}`).toBe("/?new");
    expect(createPage).not.toHaveBeenCalled();
  });

  it("link の行き先を調べている間は、画面を薄くして開いている途中だと伝える", async () => {
    const restoreDelay = setLoadingDelay(0);
    let answer: (result: Awaited<ReturnType<typeof resolvePages>>) => void = () => {};
    vi.mocked(resolvePages)
      .mockImplementationOnce(async (titles) => ok(titles.map(() => null)))
      .mockReturnValue(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
    try {
      renderPage({ ...PAGE, body: "[[無い]]" });
      await vi.waitFor(() => expect(resolvePages).toHaveBeenCalledTimes(1));
      await flushAsync();
      clickLink("無い");
      await vi.waitFor(() =>
        expect(container?.querySelector(".note")?.classList.contains("note-leaving")).toBe(true),
      );
      expect(container?.querySelector(".note")?.getAttribute("aria-busy")).toBe("true");
      expect(container?.textContent).toContain("「無い」を開いています…");
      // 押し直しても、問い合わせを最初からやり直さない
      expect(resolvePages).toHaveBeenCalledTimes(2);
      clickLink("無い");
      await flushAsync();
      expect(resolvePages).toHaveBeenCalledTimes(2);

      await act(async () => answer(ok([null])));
      await vi.waitFor(() => expect(location.pathname).toBe(`/${encodeURIComponent("無い")}`));
      expect(container?.querySelector(".note-leaving")).toBeNull();
      expect(container?.textContent).not.toContain("を開いています…");
    } finally {
      restoreDelay();
    }
  });

  it("リンク先を調べられなかったときは、無いと言わずに再試行を促す", async () => {
    vi.mocked(resolvePages).mockResolvedValue({ ok: false, reason: "error", message: "500" });
    renderPage({ ...PAGE, body: "[[別]]" });
    clickLink("別");
    await vi.waitFor(() => expect(container?.textContent).toContain("調べられませんでした"));
    expect(container?.textContent).not.toContain("まだありません");
    expect(location.pathname).toBe(new URL(startUrl).pathname);
  });

  it("![[ページ]] を取得した本文で展開する", async () => {
    vi.mocked(findPageByTitle).mockResolvedValue(
      ok({ ...PAGE, id: "BBBBBBBBBBBBBBBBBBBBBB", title: "別", body: "埋め込まれた本文" }),
    );
    renderPage({ ...PAGE, body: "![[別]]" });
    await vi.waitFor(() =>
      expect(container?.querySelector(".cm-embed-page")?.textContent).toContain("埋め込まれた本文"),
    );
  });

  it("![[ページ#見出し]] は取得した本文のうち、その見出しの節だけを展開する", async () => {
    vi.mocked(findPageByTitle).mockResolvedValue(
      ok({
        ...PAGE,
        id: "BBBBBBBBBBBBBBBBBBBBBB",
        title: "別",
        body: "# 一\n\n一の本文\n\n# 二\n\n二の本文\n",
      }),
    );
    renderPage({ ...PAGE, body: "![[別#二]]" });
    await vi.waitFor(() =>
      expect(container?.querySelector(".cm-embed-page")?.textContent).toContain("二の本文"),
    );
    expect(container?.querySelector(".cm-embed-page")?.textContent).not.toContain("一の本文");
    expect(findPageByTitle).toHaveBeenCalledWith("別", expect.anything());
  });

  it("[[ページ#見出し]] のクリックでは、# を切らずに editor が分けた target で引く", async () => {
    vi.mocked(resolvePages).mockImplementation(async (titles) =>
      ok(
        titles.map((title) => ({
          id: "BBBBBBBBBBBBBBBBBBBBBB",
          title,
          visibility: "draft" as const,
        })),
      ),
    );
    renderPage({ ...PAGE, body: "[[別#二]]" });
    clickLink("別#二");
    await vi.waitFor(() => expect(location.pathname).toBe("/p/BBBBBBBBBBBBBBBBBBBBBB"));
    for (const [titles] of vi.mocked(resolvePages).mock.calls) {
      expect(titles).not.toContain("別#二");
      expect(titles).toContain("別");
    }
  });

  it("本文だけの保存では、存在の確認も embed の本文も取り直さない", async () => {
    vi.mocked(findPageByTitle).mockResolvedValue(
      ok({ ...PAGE, id: "BBBBBBBBBBBBBBBBBBBBBB", title: "別", body: "埋め込まれた本文" }),
    );
    const { view } = renderPage({ ...PAGE, body: "[[無い]]\n![[別]]" });
    await vi.waitFor(() => expect(container?.querySelector(".cm-embed-page")).not.toBeNull());
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalledTimes(1));
    expect(findPageByTitle).toHaveBeenCalledTimes(1);

    // autosave は 2 秒ごとに走るので、保存のたびに取り直すと無駄が大きい
    view().focus();
    typeAtEnd(view(), "\n追記");
    act(() => view().contentDOM.blur());
    await vi.waitFor(() => expect(updatePage).toHaveBeenCalledTimes(1));
    // 取り直すなら debounce の後に要求が出る
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(resolvePages).toHaveBeenCalledTimes(1);
    expect(findPageByTitle).toHaveBeenCalledTimes(1);
  });

  it("title を変えて保存したら、存在の確認だけを取り直す", async () => {
    vi.mocked(findPageByTitle).mockResolvedValue(
      ok({ ...PAGE, id: "BBBBBBBBBBBBBBBBBBBBBB", title: "別", body: "埋め込まれた本文" }),
    );
    renderPage({ ...PAGE, body: "[[無い]]\n![[別]]" });
    await vi.waitFor(() => expect(container?.querySelector(".cm-embed-page")).not.toBeNull());
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalledTimes(1));

    act(() => titleView().focus());
    typeTitle("新しい題");
    act(() => titleView().contentDOM.blur());
    await vi.waitFor(() => expect(resolvePages).toHaveBeenCalledTimes(2));
    expect(findPageByTitle).toHaveBeenCalledTimes(1);
  });
});

describe("PageEditor の見出しと block への移動", () => {
  const BODY = "前 [[#節B]] [[#^blk]] [[別#二]]\n\n# 節A\n\n本文\n\n## 節B\n\n段落 ^blk\n";
  const at = (needle: string) => BODY.indexOf(needle);
  const hashOf = (text: string) => `#${encodeURIComponent(text)}`;

  const clickLink = (text: string) => {
    const link = [...(container?.querySelectorAll(".cm-wikilink") ?? [])].find(
      (e) => e.textContent === text,
    );
    if (!link) throw new Error(`${text} の link が無い`);
    act(() => {
      link.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
  };

  beforeEach(() => {
    vi.mocked(resolvePages).mockImplementation(async (titles) =>
      ok(
        titles.map((title) => ({
          id: "BBBBBBBBBBBBBBBBBBBBBB",
          title,
          visibility: "draft" as const,
        })),
      ),
    );
  });

  it("hash が見出しを指すページを開くと、その見出しにカーソルを置く", () => {
    history.replaceState(null, "", `${location.pathname}${hashOf("節B")}`);
    const { view } = renderPage({ ...PAGE, body: BODY });
    expect(view().state.selection.main.head).toBe(at("## 節B"));
    // ページを開いただけでは focus しない（モバイルでキーボードが出る）
    expect(view().hasFocus).toBe(false);
  });

  it("hash が block を指すページを開くと、その段落にカーソルを置く", () => {
    history.replaceState(null, "", `${location.pathname}#%5Eblk`);
    const { view } = renderPage({ ...PAGE, body: BODY });
    expect(view().state.selection.main.head).toBe(at("段落 ^blk"));
  });

  it("見つからない hash では、先頭のままにする", () => {
    history.replaceState(null, "", `${location.pathname}${hashOf("無い")}`);
    const { view } = renderPage({ ...PAGE, body: BODY });
    expect(view().state.selection.main.head).toBe(0);
    expect(container?.querySelector("[role=alert]")).toBeNull();
  });

  it("移動した後に入力しても、カーソルを見出しへ戻さない", async () => {
    history.replaceState(null, "", `${location.pathname}${hashOf("節B")}`);
    const { view } = renderPage({ ...PAGE, body: BODY });
    view().focus();
    typeAtEnd(view(), "追記");
    await flushAsync();
    expect(view().state.selection.main.head).toBe(BODY.length + 2);
  });

  it("同じページの link は遷移もページの問い合わせもせず、その位置へ移る", async () => {
    const { view } = renderPage({ ...PAGE, body: BODY });
    await flushAsync();
    const pathname = location.pathname;
    clickLink("#節B");
    expect(view().state.selection.main.head).toBe(at("## 節B"));
    // link を押しても focus しない（モバイルでキーボードが出る。記号も現れる）
    expect(view().hasFocus).toBe(false);
    expect(location.pathname).toBe(pathname);
    expect(location.hash).toBe(hashOf("節B"));
    clickLink("#^blk");
    expect(view().state.selection.main.head).toBe(at("段落 ^blk"));
    expect(findPageByTitle).not.toHaveBeenCalled();
    for (const [titles] of vi.mocked(resolvePages).mock.calls) expect(titles).not.toContain("");
  });

  it("本文に caret がある状態で見出しの link を押すと、focus を外して記号を出さない", async () => {
    const { view } = renderPage({ ...PAGE, body: BODY });
    await flushAsync();
    view().focus();
    clickLink("#節B");
    expect(view().hasFocus).toBe(false);
    expect(view().state.selection.main.head).toBe(at("## 節B"));
  });

  it("ほかのページの見出しへの link は、遷移先の URL に fragment を付ける", async () => {
    renderPage({ ...PAGE, body: BODY });
    await flushAsync();
    clickLink("別#二");
    await vi.waitFor(() =>
      expect(`${location.pathname}${location.hash}`).toBe(
        `/p/BBBBBBBBBBBBBBBBBBBBBB${hashOf("二")}`,
      ),
    );
  });

  it("link の href にも fragment を付ける", async () => {
    renderPage({ ...PAGE, body: BODY });
    await vi.waitFor(() =>
      expect(
        [...(container?.querySelectorAll("a[href]") ?? [])]
          .filter((a) => a.classList.contains("cm-wikilink"))
          .map((a) => a.getAttribute("href")),
      ).toEqual([hashOf("節B"), "#%5Eblk", `/p/BBBBBBBBBBBBBBBBBBBBBB${hashOf("二")}`]),
    );
  });

  it("戻る、進むで fragment 付きの URL に戻ると、位置を合わせる", async () => {
    const { view } = renderPage({ ...PAGE, body: BODY });
    await flushAsync();
    clickLink("#節B");
    clickLink("#^blk");
    act(() => view().contentDOM.blur());
    history.back();
    await vi.waitFor(() => expect(view().state.selection.main.head).toBe(at("## 節B")));
    history.forward();
    await vi.waitFor(() => expect(view().state.selection.main.head).toBe(at("段落 ^blk")));
    // 戻る、進むでは focus しない
    expect(view().hasFocus).toBe(false);
  });

  it("別のページへ fragment 付きで移る遷移では、遷移前のページの本文を動かさない", async () => {
    const { view } = renderPage({ ...PAGE, body: BODY });
    await flushAsync();
    act(() => navigate(`/p/BBBBBBBBBBBBBBBBBBBBBB${hashOf("節B")}`));
    expect(view().state.selection.main.head).toBe(0);
    expect(view().hasFocus).toBe(false);
  });

  it("正の URL への置き換えの後も、同じページの hash の変化には移る", async () => {
    const { view } = renderPage({ ...PAGE, body: BODY });
    await flushAsync();
    act(() => navigate("/p/CCCCCCCCCCCCCCCCCCCCCC", { replace: true }));
    act(() => navigate(`/p/CCCCCCCCCCCCCCCCCCCCCC${hashOf("節B")}`));
    expect(view().state.selection.main.head).toBe(at("## 節B"));
  });
});

describe("まだ作っていないページ（page が null）", () => {
  const NEW_ID = "CCCCCCCCCCCCCCCCCCCCCC";
  const NEW_BACKUP_PREFIX = "personal-wiki:draft:new:";
  const newBackupKeys = () =>
    Object.keys(localStorage).filter((key) => key.startsWith(NEW_BACKUP_PREFIX));
  // 作れていない退避を持つ key はモジュールの中で覚えられるので、テストごとに別の key にする
  let orphanCount = 0;
  const seedOrphan = (backup: object) => {
    orphanCount += 1;
    const key = `${NEW_BACKUP_PREFIX}orphan-${orphanCount}`;
    localStorage.setItem(key, JSON.stringify(backup));
    return key;
  };
  const titleContent = () => container?.querySelector<HTMLElement>(".title-input .cm-content");
  const bodyContent = () =>
    container?.querySelector<HTMLElement>(".body-editor .cm-content[aria-label='本文']");
  const pending = () => {
    let resolve: (value: ApiResult<Page>) => void = () => {};
    const promise = new Promise<ApiResult<Page>>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const created = (input: { title: string; body: string }): ApiResult<Page> =>
    ok({ ...PAGE, id: NEW_ID, ...input, version: 1 });

  function renderNew(newTitle = "") {
    container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    act(() => mounted.render(<PageEditor page={null} newTitle={newTitle} attachments />));
    const view = () => {
      const editor = container?.querySelector<HTMLElement>(".body-editor .cm-editor");
      const found = editor ? EditorView.findFromDOM(editor) : null;
      if (!found) throw new Error("エディタが無い");
      return found;
    };
    return { view };
  }

  beforeEach(() => {
    vi.mocked(createPage).mockImplementation(async (input) => created(input));
  });

  it("title 欄にフォーカスし、本文を打っても title を決めるまで作らない", async () => {
    const { view } = renderNew();
    expect(document.activeElement).toBe(titleContent());
    expect(container?.textContent).toContain("タイトルを決めると保存します");
    act(() => typeAtEnd(view(), "本文だけ"));
    act(() => view().contentDOM.blur());
    await flushAsync();
    expect(createPage).not.toHaveBeenCalled();
  });

  it("title を打って Enter を押すと、打った本文ごと作って本文へ移る", async () => {
    const { view } = renderNew();
    act(() => typeAtEnd(view(), "先に書いた本文"));
    typeTitle("新しい題");
    pressEnter(false);
    expect(document.activeElement).toBe(bodyContent());
    await flushAsync();
    expect(createPage).toHaveBeenCalledWith({ title: "新しい題", body: "先に書いた本文" });
    expect(newBackupKeys()).toEqual([]);
  });

  it("変換を確定する Enter と、空の title では作らない", async () => {
    renderNew();
    typeTitle("変換中", "input.type.compose");
    pressEnter(true, 229);
    typeTitle("");
    pressEnter(false);
    await flushAsync();
    expect(createPage).not.toHaveBeenCalled();
  });

  it("title を渡されたら、開いてすぐ作り、本文にフォーカスする", async () => {
    renderNew("渡した題");
    expect(document.activeElement).toBe(bodyContent());
    await flushAsync();
    expect(createPage).toHaveBeenCalledWith({ title: "渡した題", body: "" });
  });

  it("作る応答を待つ間に打った本文は消えず、作れた後に保存する", async () => {
    const create = pending();
    vi.mocked(createPage).mockReturnValue(create.promise);
    const { view } = renderNew("待つ題");
    await flushAsync();
    expect(container?.textContent).toContain("作成中…");
    const content = bodyContent();
    act(() => typeAtEnd(view(), "待つ間の本文"));
    await act(async () => create.resolve(created({ title: "待つ題", body: "" })));
    await flushAsync();
    expect(view().state.doc.toString()).toBe("待つ間の本文");
    expect(bodyContent()).toBe(content);
    act(() => view().focus());
    act(() => view().contentDOM.blur());
    await vi.waitFor(() =>
      expect(updatePage).toHaveBeenCalledWith(
        NEW_ID,
        1,
        { title: "待つ題", body: "待つ間の本文" },
        expect.anything(),
      ),
    );
  });

  it("title が重複したら、打った内容を残して直し方と既存のページへのリンクを出す", async () => {
    vi.mocked(createPage).mockResolvedValue({
      ok: false,
      reason: "title_conflict",
      message: "同じタイトルのページがすでにあります。",
      existing: { id: ID, title: "重なる題", visibility: "draft" },
    });
    const { view } = renderNew();
    act(() => typeAtEnd(view(), "残る本文"));
    typeTitle("重なる題");
    pressEnter(false);
    const link = () => container?.querySelector("[role='alert'] a");
    await vi.waitFor(() => expect(link()?.getAttribute("href")).toBe(`/p/${ID}`));
    expect(link()?.textContent).toBe("そのページを開く");
    const alert = container?.querySelector("[role='alert']")?.textContent;
    expect(alert).toContain("同じタイトルのページがあるため、作成できません");
    expect(alert).toContain("「重なる題」というページがすでにあります。");
    expect(alert).toContain("タイトルを変えて Enter を押すと、もう一度作ります。");
    expect(alert).not.toContain("大文字と小文字");
    // 送り直しても同じ応答になるので、再試行は出さない
    expect(alert).not.toContain("もう一度作成する");
    expect(view().state.doc.toString()).toBe("残る本文");
    expect(titleText()).toBe("重なる題");
    // 直しかけの title でも、リンクは送った title の既存のページを指したまま
    typeTitle("直しかけ");
    expect(link()?.getAttribute("href")).toBe(`/p/${ID}`);

    vi.mocked(createPage).mockImplementation(async (input) => created(input));
    typeTitle("別の題");
    pressEnter(false);
    await vi.waitFor(() =>
      expect(createPage).toHaveBeenLastCalledWith({ title: "別の題", body: "残る本文" }),
    );
  });

  it("見た目の違う title と重なったら、同じとみなす規則を添える", async () => {
    vi.mocked(createPage).mockResolvedValue({
      ok: false,
      reason: "title_conflict",
      message: "同じタイトルのページがすでにあります。",
      existing: { id: ID, title: "Wiki Page", visibility: "draft" },
    });
    renderNew();
    typeTitle("wiki_page");
    pressEnter(false);
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("「Wiki Page」というページがすでにあります。"),
    );
    expect(container?.textContent).toContain(
      "大文字と小文字、全角と半角、_ と空白の違いは、同じタイトルとみなします。",
    );
  });

  it("通信の失敗では、打った内容を退避に残し、「もう一度作成する」で作り直す", async () => {
    vi.mocked(createPage).mockResolvedValue({
      ok: false,
      reason: "error",
      message: "通信できない",
    });
    const { view } = renderNew();
    act(() => typeAtEnd(view(), "残る本文"));
    typeTitle("題");
    pressEnter(false);
    await vi.waitFor(() => expect(container?.textContent).toContain("作成できませんでした"));
    expect(container?.querySelector("[role='status']")?.textContent).toBe("作成に失敗");
    const keys = newBackupKeys();
    expect(keys).toHaveLength(1);
    const saved = JSON.parse(localStorage.getItem(keys[0] ?? "") ?? "null");
    expect(saved).toMatchObject({ title: "題", body: "残る本文", createFailed: true });

    vi.mocked(createPage).mockImplementation(async (input) => created(input));
    const retry = [...(container?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "もう一度作成する",
    );
    act(() => retry?.click());
    await vi.waitFor(() => expect(createPage).toHaveBeenCalledTimes(2));
    expect(createPage).toHaveBeenLastCalledWith({ title: "題", body: "残る本文" });
  });

  it("退避が端末に書けないときは、退避してあるとは言わず、内容をコピーするよう案内する", async () => {
    vi.mocked(createPage).mockResolvedValue({
      ok: false,
      reason: "error",
      message: "通信できない",
    });
    // 容量超過や private window では localStorage への書き込みが例外になる
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    try {
      const { view } = renderNew();
      act(() => typeAtEnd(view(), "残る本文"));
      typeTitle("題");
      pressEnter(false);
      await vi.waitFor(() =>
        expect(container?.querySelector(".notice-title")?.textContent).toBe(
          "作成できず、内容を端末に退避できませんでした",
        ),
      );
      expect(container?.textContent).toContain("この端末には退避できませんでした");
      expect(container?.textContent).not.toContain("この端末にも退避してあります");
    } finally {
      setItem.mockRestore();
    }
  });

  it("作れずに残った退避は、作れなかったことを示して復元を尋ね、復元すると作る", async () => {
    seedOrphan({
      title: "残った題",
      body: "残った本文",
      baseVersion: 0,
      savedAt: 0,
      createFailed: true,
    });
    const { view } = renderNew();
    expect(container?.textContent).toContain(
      "作成できなかったページ「残った題」の内容が、この端末に退避されています",
    );
    expect(view().state.readOnly).toBe(true);
    const restore = [...(container?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "復元する",
    );
    act(() => restore?.click());
    await vi.waitFor(() =>
      expect(createPage).toHaveBeenCalledWith({ title: "残った題", body: "残った本文" }),
    );
    expect(newBackupKeys()).toEqual([]);
  });

  it("削除されたページの退避は、見出しだけで削除されたページの内容と分かる", async () => {
    seedOrphan({
      title: "消えた題",
      body: "消えた本文",
      baseVersion: 1,
      savedAt: 0,
      deletedFrom: ID,
    });
    renderNew();
    expect(container?.querySelector(".notice-title")?.textContent).toBe(
      "削除されたページで保存できなかった内容があります",
    );
    // 本文は見出しを繰り返さず、選んだ後に何が起きるかから始まる
    const text = container?.querySelector(".notice-text")?.textContent ?? "";
    expect(text).toMatch(
      /^復元すると、「消えた題」の内容が新しいページになります。破棄すると、この端末に退避した内容（[^）]+）は消えます。$/,
    );
    expect(text).not.toContain("削除されたページ");
  });

  it("title を渡して開いた画面は、残った退避を尋ねない", async () => {
    const key = seedOrphan({ title: "残った題", body: "残った本文", baseVersion: 0, savedAt: 0 });
    renderNew("渡した題");
    await flushAsync();
    expect(container?.textContent).not.toContain("この端末に退避されています");
    expect(createPage).toHaveBeenCalledWith({ title: "渡した題", body: "" });
    expect(localStorage.getItem(key)).not.toBeNull();
  });

  it("作る前は削除の操作を出さず、画像を貼ると先に作るよう案内する", async () => {
    const { view } = renderNew();
    expect(container?.textContent).not.toContain("このページを削除");
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(3)], "cat.png", { type: "image/png" }));
    act(() => {
      view().contentDOM.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: false, cancelable: true }),
      );
    });
    await vi.waitFor(() =>
      expect(container?.textContent).toContain(
        "画像は、タイトルを決めてページを作ってから貼ってください。",
      ),
    );
  });
});

describe("添付の貼り付けと表示", () => {
  const NAME = `${"A".repeat(21)}b.png`;
  const OTHER = `${"C".repeat(21)}d.png`;
  const srcOf = (name: string, id = ID) => `/api/pages/${id}/attachments/${name}`;

  const png = (name = "cat.png", size = 3) =>
    new File([new Uint8Array(size)], name, { type: "image/png" });

  function paste(view: EditorView, file: File): void {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    act(() => {
      view.contentDOM.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: false,
          cancelable: true,
          clipboardData: dataTransfer,
        }),
      );
    });
  }

  let restoreImageSrc: (() => void) | null = null;
  function recordSrcs(): string[] {
    const recorder = recordImageSrcs();
    restoreImageSrc = recorder.restore;
    return recorder.srcs;
  }

  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    restoreImageSrc?.();
    restoreImageSrc = null;
    vi.unstubAllGlobals();
  });

  const saved = (name: string) =>
    Response.json({ name, contentType: "image/png", size: 3 }, { status: 201 });

  it("貼り付けた画像を上げ、返った名前を本文に書く", async () => {
    fetchMock.mockImplementation(async () => saved(NAME));
    const { view } = renderPage(PAGE, true);
    const v = view();
    v.focus();
    paste(v, png());
    await vi.waitFor(() => expect(v.state.doc.toString()).toContain(`![[${NAME}]]`));
    expect(v.state.doc.toString()).not.toContain("uploading");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/attachments");
    expect(init.method).toBe("POST");
  });

  it("features が false なら、貼り付けた画像を上げない", async () => {
    const { view } = renderPage(PAGE, false);
    const v = view();
    v.focus();
    paste(v, png());
    await flushAsync();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(v.state.doc.toString()).toBe("本文");
    expect(container?.querySelector(".notice-warn")).toBeNull();
  });

  const svg = () =>
    new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], "a.svg", {
      type: "image/svg+xml",
    });

  function drop(view: EditorView, file: File): void {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    act(() => {
      view.contentDOM.dispatchEvent(
        new DragEvent("drop", { bubbles: false, cancelable: true, dataTransfer }),
      );
    });
  }

  it("受けない種類の画像（svg）の貼り付けは、上げずに通知し、本文には何も入れない", async () => {
    const { view } = renderPage(PAGE, true);
    const v = view();
    v.focus();
    paste(v, svg());
    await vi.waitFor(() => expect(container?.textContent).toContain("添付できない形式"));
    await flushAsync();
    expect(container?.querySelector("[role=alert]")?.textContent).toContain("a.svg");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(v.state.doc.toString()).toBe("本文");
  });

  it("受けない種類の画像（svg）の drop も、上げずに通知し、中身の XML を本文に入れない", async () => {
    const { view } = renderPage(PAGE, true);
    const v = view();
    drop(v, svg());
    await vi.waitFor(() => expect(container?.textContent).toContain("添付できない形式"));
    await flushAsync();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(v.state.doc.toString()).toBe("本文");
  });

  it("画像でないファイルは扱わず、通知も出さない", async () => {
    const { view } = renderPage(PAGE, true);
    const v = view();
    v.focus();
    paste(v, new File(["memo"], "memo.txt", { type: "text/plain" }));
    await flushAsync();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container?.querySelector("[role=alert]")).toBeNull();
  });

  it("上限を超える画像は送らずに通知し、placeholder を除く", async () => {
    const { view } = renderPage(PAGE, true);
    const v = view();
    v.focus();
    paste(v, png("big.png", 10_000_001));
    await vi.waitFor(() => expect(container?.textContent).toContain("big.png"));
    await flushAsync();
    expect(container?.querySelector("[role=alert]")?.textContent).toContain("10 MB までです");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(v.state.doc.toString()).toBe("本文");
  });

  it.each([
    [413, {}, "大きすぎる"],
    [415, {}, "添付できない形式"],
    [415, { error: "content_mismatch" }, "として読めませんでした"],
    [503, { error: "attachments_unavailable" }, "添付を使えません"],
    [500, {}, "添付できませんでした"],
  ])("%i の失敗は理由を通知し、placeholder を除く", async (status, body, text) => {
    fetchMock.mockImplementation(async () => Response.json(body, { status }));
    const { view } = renderPage(PAGE, true);
    const v = view();
    v.focus();
    paste(v, png());
    await vi.waitFor(() => expect(container?.textContent).toContain(text));
    await flushAsync();
    expect(v.state.doc.toString()).toBe("本文");
    expect(container?.querySelector("a[href^='/_auth/login']")).toBeNull();
  });

  it.each([
    [401, "ログインの期限が切れた"],
    [403, "サーバーに拒否されました"],
  ])("%i ではログインし直すリンクを出す", async (status, text) => {
    fetchMock.mockImplementation(async () => Response.json({}, { status }));
    const { view } = renderPage(PAGE, true);
    const v = view();
    v.focus();
    paste(v, png());
    await vi.waitFor(() => expect(container?.textContent).toContain(text));
    expect(container?.querySelector("a[href^='/_auth/login']")).not.toBeNull();
  });

  it("通知は閉じられる", async () => {
    fetchMock.mockImplementation(async () => Response.json({}, { status: 500 }));
    const { view, button } = renderPage(PAGE, true);
    view().focus();
    paste(view(), png());
    await vi.waitFor(() => expect(container?.textContent).toContain("添付できませんでした"));
    act(() => button("閉じる").click());
    expect(container?.textContent).not.toContain("添付できませんでした");
  });

  it("本文の添付は、このページの id の URL で表示する", async () => {
    const srcs = recordSrcs();
    renderPage({ ...PAGE, body: `![[${NAME}]]\n\n末尾` }, true);
    await flushAsync();
    expect(srcs).toEqual([srcOf(NAME)]);
  });

  it("features が false なら画像の要求を出さない", async () => {
    const srcs = recordSrcs();
    renderPage({ ...PAGE, body: `![[${NAME}]]\n\n末尾` }, false);
    await flushAsync();
    expect(srcs).toEqual([]);
    expect(container?.querySelector(".cm-embed-unresolved")?.textContent).toBe(NAME);
  });

  it("アップロード中の placeholder と形の合わない名前は画像の要求を出さない", async () => {
    const srcs = recordSrcs();
    renderPage(
      { ...PAGE, body: "![[uploading.1700000000000-0.png]]\n\n![[photo.png]]\n\n末尾" },
      true,
    );
    await flushAsync();
    expect(srcs).toEqual([]);
  });

  it("入れ子の embed の添付は、埋め込み先のページの id の URL で表示する", async () => {
    const srcs = recordSrcs();
    const OTHER_ID = "BBBBBBBBBBBBBBBBBBBBBB";
    vi.mocked(findPageByTitle).mockImplementation(async (title) =>
      title === "別"
        ? ok({ ...PAGE, id: OTHER_ID, title: "別", body: `![[${OTHER}]]` })
        : { ok: false, reason: "not_found" },
    );
    renderPage({ ...PAGE, body: `![[別]]\n\n![[${NAME}]]\n\n末尾` }, true);
    await vi.waitFor(() => expect(srcs).toContain(srcOf(OTHER, OTHER_ID)));
    expect(srcs).toContain(srcOf(NAME));
    expect(srcs).not.toContain(srcOf(OTHER));
  });

  it("埋め込み先を読めなければ展開されず、その添付の要求も出さない", async () => {
    const srcs = recordSrcs();
    vi.mocked(findPageByTitle).mockResolvedValue({ ok: false, reason: "not_found" });
    renderPage({ ...PAGE, body: "![[別]]\n\n末尾" }, true);
    await flushAsync();
    expect(srcs).toEqual([]);
  });
});

function titleView(): EditorView {
  const editor = container?.querySelector<HTMLElement>(".title-input .cm-editor");
  const found = editor ? EditorView.findFromDOM(editor) : null;
  if (!found) throw new Error("title の欄が無い");
  return found;
}

const titleText = () => titleView().state.doc.toString();

/** title 欄の中身を `text` に打ち替える。`userEvent` に compose を渡すと変換中の入力になる */
function typeTitle(text: string, userEvent = "input.type"): void {
  const v = titleView();
  act(() => {
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: text },
      selection: { anchor: text.length },
      userEvent,
    });
  });
}

function pressEnter(isComposing: boolean, keyCode = 13): void {
  act(() => {
    titleView().contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing,
        keyCode,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

describe("本文の領域の名前", () => {
  it("title の文字を名前に持つ article として読め、title を打ち替えると名前も変わる", () => {
    renderPage();
    expect(screen.getByRole("article", { name: "題", exact: true }).element()).not.toBeNull();
    typeTitle("新しい題");
    expect(screen.getByRole("article", { name: "新しい題", exact: true }).element()).not.toBeNull();
    expect(screen.getByRole("article", { name: "題", exact: true }).query()).toBeNull();
  });

  it("title が空の間は名前を付けず、入力した後に付ける", () => {
    renderPage({ ...PAGE, title: "" });
    expect(screen.getByRole("article").element()).not.toBeNull();
    expect(screen.getByRole("article", { name: /./ }).query()).toBeNull();
    typeTitle("決めた題");
    expect(screen.getByRole("article", { name: "決めた題", exact: true }).element()).not.toBeNull();
  });
});

describe("title の確定", () => {
  it("打っている間は保存せず、Enter で確定して保存し、本文へ移る。変換中の Enter では保存しない", async () => {
    const { view } = renderPage();
    act(() => titleView().focus());
    titleView().contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    typeTitle("しんしい", "input.type.compose");
    await flushAsync();
    pressEnter(true, 229);
    typeTitle("新しい題", "input.type.compose");
    titleView().contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await flushAsync();
    expect(updatePage).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(titleView().contentDOM);
    expect(container?.querySelector(".save-state")?.textContent).toContain("未保存");

    pressEnter(false);
    await flushAsync();
    expect(document.activeElement).toBe(view().contentDOM);
    expect(updatePage).toHaveBeenCalledTimes(1);
    expect(updatePage).toHaveBeenCalledWith(
      ID,
      1,
      { title: "新しい題", body: "本文" },
      expect.anything(),
    );
    // 確定済みなので、その後の blur では送らない
    act(() => titleView().contentDOM.blur());
    await flushAsync();
    expect(updatePage).toHaveBeenCalledTimes(1);
  });

  it("Safari の変換を確定する Enter（isComposing が false で keyCode が 229）では保存しない", async () => {
    renderPage();
    act(() => titleView().focus());
    typeTitle("新しい題");
    pressEnter(false, 229);
    await flushAsync();
    expect(updatePage).not.toHaveBeenCalled();

    pressEnter(false);
    await flushAsync();
    expect(updatePage).toHaveBeenCalledTimes(1);
  });

  it("blur で確定して保存する", async () => {
    renderPage();
    act(() => titleView().focus());
    typeTitle("別の題");
    act(() => titleView().contentDOM.blur());
    await flushAsync();
    expect(updatePage).toHaveBeenCalledWith(
      ID,
      1,
      { title: "別の題", body: "本文" },
      expect.anything(),
    );
  });

  it("確定前に本文の保存が走っても、打っている途中の title は送らない", async () => {
    const { view } = renderPage();
    view().focus();
    typeAtEnd(view(), "を書き足す");
    // 本文にフォーカスを置いたまま title を打ち、本文の blur で保存させる
    typeTitle("打ちかけ");
    act(() => view().contentDOM.blur());
    await flushAsync();
    expect(updatePage).toHaveBeenCalledWith(
      ID,
      1,
      { title: "題", body: "本文を書き足す" },
      expect.anything(),
    );
    expect(titleText()).toBe("打ちかけ");
  });

  it("長い title は改行を含まない 1 つの title として打ち、貼り付けた改行は空白にする", async () => {
    renderPage();
    act(() => titleView().focus());
    const v = titleView();
    act(() => {
      v.dispatch({
        changes: { from: v.state.doc.length, insert: "の続き\n二行目" },
        userEvent: "input.paste",
      });
    });
    expect(titleText()).toBe("題の続き 二行目");
    act(() => v.contentDOM.blur());
    await flushAsync();
    expect(updatePage).toHaveBeenCalledWith(
      ID,
      1,
      { title: "題の続き 二行目", body: "本文" },
      expect.anything(),
    );
  });

  it("退避が未決の間は title も読み取り専用にし、復元すると同じ欄のまま書けるように戻す", async () => {
    localStorage.setItem(
      BACKUP_KEY,
      JSON.stringify({ title: "退避した題", body: "本文", baseVersion: 1, savedAt: 0 }),
    );
    const { button } = renderPage();
    const v = titleView();
    expect(v.state.readOnly).toBe(true);
    expect(v.contentDOM.getAttribute("inputmode")).toBe("none");
    typeTitle("打てない");
    expect(titleText()).toBe("題");

    act(() => button("復元する").click());
    await flushAsync();
    expect(titleView()).toBe(v);
    expect(titleText()).toBe("退避した題");
    expect(v.state.readOnly).toBe(false);
    expect(v.contentDOM.hasAttribute("inputmode")).toBe(false);
    typeTitle("打てる");
    expect(titleText()).toBe("打てる");
  });

  it("変換中のフォーカス復帰が他での改名を持ち込んでも、確定後に打ちかけの title で上書きしない", async () => {
    vi.mocked(getPage).mockResolvedValue(ok({ ...PAGE, title: "他で変えた", version: 2 }));
    renderPage();
    act(() => titleView().focus());
    titleView().contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    typeTitle("題へん", "input.type.compose");
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flushAsync();
    typeTitle("題変換", "input.type.compose");
    titleView().contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(titleText()).toBe("他で変えた"));
    await flushAsync();
    expect(titleText()).toBe("他で変えた");

    pressEnter(false);
    act(() => titleView().contentDOM.blur());
    await flushAsync();
    expect(updatePage).not.toHaveBeenCalled();
  });

  it("衝突の解決でサーバーの title を取り込むと、同じ欄の中身を差し替える", async () => {
    const server: Page = { ...PAGE, title: "サーバーの題", version: 2 };
    vi.mocked(updatePage).mockResolvedValue({
      ok: false,
      reason: "version_conflict",
      currentVersion: 2,
    });
    vi.mocked(getPage).mockResolvedValue(ok(server));
    const { view, button } = renderPage();
    const v = titleView();
    view().focus();
    typeAtEnd(view(), "の手元の変更");
    act(() => view().contentDOM.blur());
    await flushAsync();
    expect(v.state.readOnly).toBe(true);

    act(() => button("サーバーの版を取り込む").click());
    act(() => button("取り込む").click());
    await flushAsync();
    expect(titleView()).toBe(v);
    expect(titleText()).toBe("サーバーの題");
    expect(v.state.readOnly).toBe(false);
  });
});

describe("リンクの書き換えの取り込み", () => {
  const step = (value: Partial<LinkRewriteStepResult>): LinkRewriteStepResult => ({
    processed: null,
    conflict: false,
    failed: [],
    remaining: 0,
    ...value,
  });
  const processedSelf = {
    sourcePageId: ID,
    title: "題",
    visibility: "draft" as const,
    version: 2,
    rewritten: 1,
  };
  const linked: Page = { ...PAGE, body: "[[他]] 本文" };
  const rewritten: Page = { ...linked, body: "[[新他]] 本文", version: 2 };

  /** step が呼ばれるまでは linked を、呼ばれた後は書き換えた版を返す（フォーカスでの確認でも読まれる） */
  function serveRewriteOnStep(value: LinkRewriteStepResult, after: Page) {
    let current = linked;
    vi.mocked(getPage).mockImplementation(async () => ok(current));
    vi.mocked(stepLinkRewrites).mockImplementationOnce(async () => {
      current = after;
      return { ok: true, value };
    });
  }

  it("title を変えた保存が積んだ書き換えを進め、開いているページの書き換えを取り込んで次の保存の版にする", async () => {
    vi.mocked(updatePage).mockImplementationOnce(async (_id, version, input) =>
      ok({ ...linked, ...input, version: version + 1, linkRewrites: { queued: 1 } }),
    );
    serveRewriteOnStep(step({ processed: { ...processedSelf, title: "新", version: 3 } }), {
      ...rewritten,
      title: "新",
      version: 3,
    });
    const { view } = renderPage(linked);
    act(() => titleView().focus());
    typeTitle("新");
    act(() => titleView().contentDOM.blur());
    await vi.waitFor(() => expect(view().state.doc.toString()).toBe("[[新他]] 本文"));
    expect(stepLinkRewrites).toHaveBeenCalledTimes(1);

    view().focus();
    typeAtEnd(view(), "!");
    act(() => view().contentDOM.blur());
    await flushAsync();
    expect(updatePage).toHaveBeenLastCalledWith(
      ID,
      3,
      { title: "新", body: "[[新他]] 本文!" },
      expect.anything(),
    );
  });

  it("変換中は差し替えず、変換が終わってから、打った文字に書き換えを重ねて取り込む", async () => {
    serveRewriteOnStep(step({ processed: processedSelf }), rewritten);
    const { view } = renderPage(linked);
    const v = view();
    v.focus();
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    typeAtEnd(v, "かな", "input.type.compose");
    act(() => linkRewrites.start());
    await vi.waitFor(() => expect(stepLinkRewrites).toHaveBeenCalled());
    await flushAsync();
    expect(v.state.doc.toString()).toBe("[[他]] 本文かな");
    // 取り込みを待っている間に変換する。変換前の本文で重ねると、確定した文字が消える
    const end = v.state.doc.length;
    v.dispatch({
      changes: { from: end - 2, to: end, insert: "仮名" },
      selection: { anchor: end },
      userEvent: "input.type.compose",
    });
    await flushAsync();

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("[[新他]] 本文仮名"));
    act(() => v.contentDOM.blur());
    await flushAsync();
    expect(updatePage).toHaveBeenLastCalledWith(
      ID,
      2,
      { title: "題", body: "[[新他]] 本文仮名" },
      expect.anything(),
    );
  });

  it("新しい title がリンクに書けないと Worker が知らせたら、その旨を出す", async () => {
    vi.mocked(updatePage).mockImplementationOnce(async (_id, version, input) =>
      ok({
        ...PAGE,
        ...input,
        version: version + 1,
        linkRewrites: { queued: 0, skipped: "unsafe_title" },
      }),
    );
    renderPage();
    act(() => titleView().focus());
    typeTitle("新#");
    act(() => titleView().contentDOM.blur());
    await flushAsync();
    expect(container?.textContent).toContain("このタイトルの「#」はリンクに書けないので");
    expect(stepLinkRewrites).not.toHaveBeenCalled();
  });

  it("リンクに書けない title の案内は、書き換えの数を返さない保存で title を変えたら消す", async () => {
    vi.mocked(updatePage).mockImplementationOnce(async (_id, version, input) =>
      ok({
        ...PAGE,
        ...input,
        version: version + 1,
        linkRewrites: { queued: 0, skipped: "unsafe_title" },
      }),
    );
    const { view } = renderPage();
    act(() => titleView().focus());
    typeTitle("新#");
    act(() => titleView().contentDOM.blur());
    await flushAsync();
    expect(container?.textContent).toContain("このタイトルの「#」はリンクに書けないので");

    // 本文だけの保存（title が変わらない）では消さない
    view().focus();
    typeAtEnd(view(), "追記");
    act(() => view().contentDOM.blur());
    await flushAsync();
    expect(updatePage).toHaveBeenCalledTimes(2);
    expect(container?.textContent).toContain("このタイトルの「#」はリンクに書けないので");

    // リンク元が無い title への変更は、応答に linkRewrites が付かない
    act(() => titleView().focus());
    typeTitle("新");
    act(() => titleView().contentDOM.blur());
    await flushAsync();
    expect(updatePage).toHaveBeenCalledTimes(3);
    expect(container?.textContent).not.toContain("はリンクに書けないので");
  });
});

describe("公開の切り替えと削除の待ち", () => {
  const PUBLIC: Page = { ...PAGE, visibility: "public" };
  let restoreDelay: (() => void) | null = null;

  afterEach(() => {
    restoreDelay?.();
    restoreDelay = null;
  });

  const option = (label: string) => {
    const found = [
      ...(container?.querySelectorAll<HTMLButtonElement>(".segmented-option") ?? []),
    ].find((b) => b.textContent === label);
    if (!found) throw new Error(`${label} の選択が無い`);
    return found;
  };
  const publishNote = () => container?.querySelector(".publish-note")?.textContent;

  function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("公開を押した直後に「公開」を選択中にして、遅れた後に「公開にしています…」を出す。押し直しは受けない", async () => {
    restoreDelay = setLoadingDelay(40);
    const reply = deferred<ApiResult<Page>>();
    vi.mocked(setVisibility).mockReturnValue(reply.promise);
    const { button } = renderPage();
    await flushAsync();

    act(() => option("公開").click());
    act(() => button("公開する").click());
    await flushAsync();
    expect(setVisibility).toHaveBeenCalledWith(ID, 1, "public");
    expect(option("公開").getAttribute("aria-pressed")).toBe("true");
    expect(option("下書き").getAttribute("aria-pressed")).toBe("false");
    expect(option("公開").disabled).toBe(true);
    expect(option("下書き").disabled).toBe(true);
    expect(publishNote()).toBe("");

    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(publishNote()).toBe("公開にしています…");

    await act(async () => reply.resolve(ok({ ...PAGE, visibility: "public", version: 2 })));
    await flushAsync();
    expect(option("公開").getAttribute("aria-pressed")).toBe("true");
    expect(option("公開").disabled).toBe(false);
    expect(publishNote()).toBe("公開しました。");
    expect(document.activeElement).toBe(option("公開"));
  });

  it("公開が失敗したら元の「下書き」に戻し、失敗の通知を出す", async () => {
    restoreDelay = setLoadingDelay(0);
    const reply = deferred<ApiResult<Page>>();
    vi.mocked(setVisibility).mockReturnValue(reply.promise);
    const { button } = renderPage();
    await flushAsync();

    act(() => option("公開").click());
    act(() => button("公開する").click());
    await flushAsync();
    expect(publishNote()).toBe("公開にしています…");

    await act(async () => reply.resolve({ ok: false, reason: "error", message: "失敗" }));
    await flushAsync();
    expect(option("下書き").getAttribute("aria-pressed")).toBe("true");
    expect(option("公開").getAttribute("aria-pressed")).toBe("false");
    expect(publishNote()).toBe("");
    expect(container?.textContent).toContain("公開設定を変えられませんでした");
  });

  it("下書きに戻す間は「下書き」を選択中にして「下書きに戻しています…」を出す", async () => {
    restoreDelay = setLoadingDelay(0);
    const reply = deferred<ApiResult<Page>>();
    vi.mocked(setVisibility).mockReturnValue(reply.promise);
    renderPage(PUBLIC);
    await flushAsync();

    act(() => option("下書き").click());
    await flushAsync();
    expect(option("下書き").getAttribute("aria-pressed")).toBe("true");
    expect(option("公開").getAttribute("aria-pressed")).toBe("false");
    expect(publishNote()).toBe("下書きに戻しています…");

    await act(async () => reply.resolve(ok({ ...PUBLIC, visibility: "draft", version: 2 })));
    await flushAsync();
    expect(option("下書き").getAttribute("aria-pressed")).toBe("true");
    expect(publishNote()).toBe("下書きに戻しました。");
  });

  it("応答がすぐ届けば、状態の文字を出さない", async () => {
    restoreDelay = setLoadingDelay(1000);
    vi.mocked(setVisibility).mockResolvedValue(ok({ ...PUBLIC, version: 2 }));
    const { button } = renderPage();
    await flushAsync();

    act(() => option("公開").click());
    act(() => button("公開する").click());
    await flushAsync();
    expect(publishNote()).toBe("公開しました。");
  });

  it("削除の応答を待つ間は、削除ボタンを「削除中…」にして、読み上げ用の status にも出す", async () => {
    const reply = deferred<ApiResult<null>>();
    vi.mocked(deletePage).mockReturnValue(reply.promise);
    const { button } = renderPage();
    await flushAsync();
    const remove = button("このページを削除");
    const statusOf = () => remove.parentElement?.querySelector("[role='status']")?.textContent;
    expect(statusOf()).toBe("");

    act(() => remove.click());
    await flushAsync();
    expect(deletePage).toHaveBeenCalled();
    expect(remove.textContent).toBe("削除中…");
    expect(remove.disabled).toBe(true);
    expect(statusOf()).toBe("削除中…");

    await act(async () => reply.resolve({ ok: false, reason: "error", message: "失敗" }));
    await flushAsync();
    expect(remove.textContent).toBe("このページを削除");
    expect(statusOf()).toBe("");
    expect(button("もう一度削除する")).toBeDefined();
  });

  it("未保存の変更があるときだけ、削除の確認で変更も捨てることを伝える", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { view, button } = renderPage();
    await flushAsync();
    act(() => button("このページを削除").click());
    expect(confirm).toHaveBeenLastCalledWith(`「${PAGE.title}」を削除しますか？元に戻せません。`);

    act(() => typeAtEnd(view(), "追記"));
    act(() => button("このページを削除").click());
    expect(confirm).toHaveBeenLastCalledWith(
      `「${PAGE.title}」を削除しますか？保存していない変更も捨てます。元に戻せません。`,
    );
    expect(deletePage).not.toHaveBeenCalled();
  });
});
