import { completionStatus } from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp } from "vitest/browser";
import type { UploadAttachment } from "./attachment-upload";
import { type CreateEditorOptions, createEditor } from "./create-editor";
import { invalidateDecorations } from "./decoration-plugin";
import type { PageEmbedContent } from "./embed";
import { type ImeEvent, isComposing, isCompositionUnsettled } from "./ime";
import { createMemoryPageIndex } from "./page-index";
import { setReadOnly } from "./read-only";
import { replaceDoc } from "./replace-doc";
import { createTitleEditor } from "./title-editor";

/*
 * IME 不変条件（ime.ts の冒頭）を、CompositionEvent を自前で dispatch するのではなく、Chromium の
 * IME の経路（CDP の Input.imeSetComposition / Input.insertText / Input.dispatchKeyEvent）で確かめる。
 * こうするとブラウザ自身が compositionstart・compositionupdate・beforeinput・compositionend を発火し、
 * CodeMirror は DOM の変更を読んで `input.type.compose` の transaction を作る。合成の CompositionEvent は
 * DOM の変更を伴わないので、CodeMirror の `inputState.composing` が 0 のまま進まず、確定文字列が DOM から
 * doc へ読み込まれる順序や、`composing > 0` の間 keydown を keymap より前に捨てる挙動を再現できない。
 */

let views: EditorView[] = [];
let log: ImeEvent[] = [];

afterEach(async () => {
  // 失敗したテストが変換を開いたまま終わると、次のテストの入力がその変換に続いてしまう
  if (views.some(isComposing)) await commit("");
  for (const view of views) {
    view.destroy();
    view.dom.parentElement?.remove();
  }
  views = [];
  log = [];
});

function newHost(): HTMLElement {
  const host = document.createElement("div");
  host.style.width = "800px";
  document.body.append(host);
  return host;
}

/** カーソルを末尾に置いて focus する。CDP の入力は focus のある要素に届く */
function focusAtEnd(view: EditorView): EditorView {
  views.push(view);
  view.focus();
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
  return view;
}

function mount(doc: string, options: CreateEditorOptions = {}): EditorView {
  return focusAtEnd(
    createEditor(newHost(), { doc, onImeEvent: (event) => log.push(event), ...options }),
  );
}

/** 変換中の文字列（未確定）を `text` にする。最初の呼び出しで変換が始まる */
async function compose(text: string): Promise<void> {
  await cdp().send("Input.imeSetComposition", {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
}

/** 変換中なら `text` で確定し、そうでなければ IME を通さずに `text` を入れる */
async function commit(text: string): Promise<void> {
  await cdp().send("Input.insertText", { text });
}

type Key = { key: string; code: string; keyCode: number; shift?: boolean };
const ENTER: Key = { key: "Enter", code: "Enter", keyCode: 13 };
const TAB: Key = { key: "Tab", code: "Tab", keyCode: 9 };
const SHIFT_ENTER: Key = { ...ENTER, shift: true };

/** 変換中に IME が受け取ったキー。Chromium は IME が処理したキーを keyCode 229 の keydown として渡す */
async function keyDownToIme({ key, code, shift }: Key): Promise<void> {
  await cdp().send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key,
    code,
    windowsVirtualKeyCode: 229,
    modifiers: shift ? 8 : 0,
  });
}

async function keyUp({ key, code, keyCode, shift }: Key): Promise<void> {
  await cdp().send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    modifiers: shift ? 8 : 0,
  });
}

/** 変換していないときのキー入力 */
async function press(k: Key): Promise<void> {
  await cdp().send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    modifiers: k.shift ? 8 : 0,
  });
  await keyUp(k);
}

/** `compositionSettled` の transaction まで済んだ（変換中に保留したものを流す番になった）ことを待つ */
async function settled(v: EditorView): Promise<void> {
  await expect.poll(() => isCompositionUnsettled(v)).toBe(false);
}

/** 最後の compositionstart から compositionend までに観測したイベント（両端を除く） */
function duringComposition(): ImeEvent[] {
  const start = log.findLastIndex((event) => event.kind === "compositionstart");
  const end = log.findLastIndex((event) => event.kind === "compositionend");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return log.slice(start + 1, end);
}

function afterComposition(): ImeEvent[] {
  return log.slice(log.findLastIndex((event) => event.kind === "compositionend") + 1);
}

const kindsOf = (events: ImeEvent[], kind: ImeEvent["kind"]) =>
  events.filter((event) => event.kind === kind).map((event) => event.detail);

/** 変換中の transaction は、ブラウザの変換を CodeMirror が読み取った compose の入力だけである */
function expectOnlyComposeTransactions(events: ImeEvent[]): void {
  for (const detail of kindsOf(events, "transaction")) {
    expect(detail).toMatch(/^input\.type\.compose/);
  }
}

describe("IME invariant 1 (decorations and outside dispatches wait for the composition)", () => {
  it("does not rebuild decorations while converting, and rebuilds each once after it settles", async () => {
    const v = mount("**太字** と [[Link]] と #tag の後に");
    log = [];

    await compose("あ");
    await compose("あい");
    await commit("愛");
    await settled(v);

    expect(v.state.doc.toString()).toBe("**太字** と [[Link]] と #tag の後に愛");
    const during = duringComposition();
    expect(kindsOf(during, "decoration-rebuild")).toEqual([]);
    expect(kindsOf(during, "decoration-skipped").length).toBeGreaterThan(0);
    expectOnlyComposeTransactions(during);

    const rebuilt = kindsOf(afterComposition(), "decoration-rebuild");
    expect(new Set(rebuilt).size).toBe(rebuilt.length);
    expect(new Set(rebuilt)).toEqual(new Set(kindsOf(during, "decoration-skipped")));
  });

  it("holds invalidateDecorations (an async wikilink resolution) until the conversion settles", async () => {
    let missing = false;
    const v = mount("[[Foo]] へ", { resolveWikiLink: () => !missing });
    const link = () => v.contentDOM.querySelector('[data-wikilink-target="Foo"]');
    expect(link()?.classList.contains("cm-wikilink-unresolved")).toBe(false);
    log = [];

    await compose("あ");
    missing = true;
    invalidateDecorations(v);
    expect(link()?.classList.contains("cm-wikilink-unresolved")).toBe(false);
    await compose("あい");
    await commit("愛");
    await settled(v);

    await expect.poll(() => link()?.classList.contains("cm-wikilink-unresolved")).toBe(true);
    expect(v.state.doc.toString()).toBe("[[Foo]] へ愛");
    const during = duringComposition();
    expect(kindsOf(during, "decoration-invalidation-held")).toHaveLength(1);
    expect(kindsOf(during, "decoration-rebuild")).toEqual([]);
    expectOnlyComposeTransactions(during);
  });

  it("applies setReadOnly after the conversion settles, keeping the committed text", async () => {
    const v = mount("一行目\n二行目");
    log = [];

    await compose("あ");
    setReadOnly(v, true);
    expect(v.state.readOnly).toBe(false);
    await compose("あい");
    await commit("愛");
    await settled(v);

    await expect.poll(() => v.state.readOnly).toBe(true);
    expect(v.state.doc.toString()).toBe("一行目\n二行目愛");
    expectOnlyComposeTransactions(duringComposition());
  });

  it("applies replaceDoc once after the conversion settles, without losing or doubling the committed text", async () => {
    const v = mount("一行目\n二行目");
    log = [];

    await compose("あ");
    // ホストが変換中に別の行を直した本文を受け取った。確定する文字はホストの本文にも入っている
    replaceDoc(v, "一行目を直した\n二行目");
    replaceDoc(v, "一行目を直した\n二行目愛");
    expect(v.state.doc.line(1).text).toBe("一行目");
    await compose("あい");
    await commit("愛");
    await settled(v);

    await expect.poll(() => v.state.doc.toString()).toBe("一行目を直した\n二行目愛");
    expectOnlyComposeTransactions(duringComposition());
    expect(kindsOf(afterComposition(), "transaction").filter((d) => d === "doc")).toHaveLength(1);
  });

  /** 呼び出しごとに完了を呼び出し側が決められる upload。完了の順も呼び出し側が決める */
  function deferredUploads(): {
    upload: UploadAttachment;
    complete: (index: number, filename: string) => void;
  } {
    const resolvers: ((filename: string) => void)[] = [];
    return {
      upload: () =>
        new Promise((resolve) => {
          resolvers.push((filename) => resolve({ filename }));
        }),
      complete: (index, filename) => resolvers[index]?.(filename),
    };
  }

  function pasteImage(v: EditorView, name: string): void {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([new Uint8Array([1])], name, { type: "image/png" }));
    v.contentDOM.dispatchEvent(
      new ClipboardEvent("paste", { cancelable: true, clipboardData: dataTransfer }),
    );
  }

  const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

  it("holds the replacement of an uploaded attachment placeholder until the conversion settles", async () => {
    const uploads = deferredUploads();
    const v = mount("前", { onUploadAttachment: uploads.upload });
    pasteImage(v, "a.png");
    const placeholder = v.state.doc.toString().slice(1);
    expect(placeholder).toMatch(/^!\[\[uploading\..+\.png\]\]$/);
    log = [];

    await compose("あ");
    uploads.complete(0, "FINISHED.png");
    await nextTask();
    // 変換中は placeholder のまま（外からの dispatch を保留している）
    expect(v.state.doc.toString()).toBe(`前${placeholder}あ`);
    await compose("あい");
    await commit("愛");
    await settled(v);

    await expect.poll(() => v.state.doc.toString()).toBe("前![[FINISHED.png]]愛");
    expectOnlyComposeTransactions(duringComposition());
  });

  // 検索を保留の前に済ませると、変換中に placeholder の前へ入った文字の分だけ位置がずれる
  it("finds the placeholder after the conversion settles, even when text was inserted before it", async () => {
    const uploads = deferredUploads();
    const v = mount("前", { onUploadAttachment: uploads.upload });
    pasteImage(v, "a.png");
    v.dispatch({ selection: { anchor: 0 } });
    log = [];

    await compose("あ");
    uploads.complete(0, "FINISHED.png");
    await nextTask();
    await commit("愛情");
    await settled(v);

    await expect.poll(() => v.state.doc.toString()).toBe("愛情前![[FINISHED.png]]");
  });

  it("replaces every placeholder when several uploads finish during one conversion", async () => {
    const uploads = deferredUploads();
    const v = mount("", { onUploadAttachment: uploads.upload });
    pasteImage(v, "a.png");
    pasteImage(v, "b.png");
    log = [];

    await compose("あ");
    // 完了の順は貼り付けの順と逆でもよい。同じ key で潰し合うと片方が placeholder のまま残る
    uploads.complete(1, "SECOND.png");
    uploads.complete(0, "FIRST.png");
    await nextTask();
    expect(v.state.doc.toString()).toMatch(/uploading\..+uploading\./);
    await commit("愛");
    await settled(v);

    await expect.poll(() => v.state.doc.toString()).toBe("![[FIRST.png]]![[SECOND.png]]愛");
    expectOnlyComposeTransactions(duringComposition());
  });
});

// CodeMirror は変換中（DOM の変更を読んだ後）の keydown を keymap より前に捨てるので、editor の
// isComposing の guard（list-keymap、title-editor、acceptUnlessComposing）を外してもここは落ちない。
// ここが見張るのは CodeMirror のその挙動が変わったときの回帰で、guard 自体は各単体テストが
// 合成の compositionstart で確かめる。
describe("IME invariant 3 (Enter, Tab and Shift+Enter during conversion belong to the IME)", () => {
  it("does not continue the list or indent when the IME takes those keys", async () => {
    const v = mount("- 項目");

    await compose("あ");
    await keyDownToIme(ENTER);
    await commit("愛");
    await keyUp(ENTER);
    await settled(v);
    expect(v.state.doc.toString()).toBe("- 項目愛");

    await compose("い");
    await keyDownToIme(TAB);
    await keyUp(TAB);
    await keyDownToIme(SHIFT_ENTER);
    await commit("胃");
    await keyUp(SHIFT_ENTER);
    await settled(v);
    expect(v.state.doc.toString()).toBe("- 項目愛胃");
    expect(v.state.selection.main.head).toBe(v.state.doc.length);

    // 変換していなければ同じ Enter でリストが続く（keymap が生きていて、上の結果が偶然ではない）
    await press(ENTER);
    expect(v.state.doc.toString()).toBe("- 項目愛胃\n- ");
  });

  it("keeps the title field focused when the IME takes Enter", async () => {
    const body = createEditor(newHost(), { doc: "本文" });
    views.push(body);
    const onCommit = vi.fn();
    const title = focusAtEnd(
      createTitleEditor(newHost(), { doc: "題", bodyView: () => body, onCommit }),
    );

    await compose("な");
    await keyDownToIme(ENTER);
    await commit("名");
    await keyUp(ENTER);
    await settled(title);
    expect(title.state.doc.toString()).toBe("題名");
    expect(onCommit).not.toHaveBeenCalled();
    expect(title.hasFocus).toBe(true);

    await press(ENTER);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(body.hasFocus).toBe(true);
  });
});

describe("IME invariants 3 and 4 ([[ completion)", () => {
  const index = () =>
    createMemoryPageIndex(
      [
        { id: "p1", title: "Code" },
        { id: "p2", title: "コード" },
      ],
      { normalize: (text) => text.toLowerCase() },
    );
  const tooltip = () => document.querySelector(".cm-tooltip-autocomplete");

  it("closes the candidates while converting, does not accept them with the IME's Enter, and reopens after", async () => {
    const v = mount("", { pageIndex: index() });
    await commit("[[");
    await expect.poll(() => completionStatus(v.state)).toBe("active");
    log = [];

    await compose("こ");
    expect(completionStatus(v.state)).toBeNull();
    expect(tooltip()).toBeNull();
    await compose("こーど");
    expect(completionStatus(v.state)).toBeNull();
    // 候補はすでに閉じており、keydown も CodeMirror が keymap より前に捨てるので、acceptUnlessComposing の
    // guard はここでは通らない（guard は wikilink-autocomplete.test.ts が確かめる）
    await keyDownToIme(ENTER);
    await commit("コード");
    await keyUp(ENTER);
    expect(v.state.doc.toString()).toBe("[[コード");
    expectOnlyComposeTransactions(duringComposition());

    await settled(v);
    await expect.poll(() => completionStatus(v.state)).toBe("active");
    expect(v.state.doc.toString()).toBe("[[コード");

    // 変換していなければ Enter で候補を確定する。autocomplete は開いてから interactionDelay（既定 75ms）の
    // 間の確定を無視するので、それより長く待つ
    await new Promise((resolve) => setTimeout(resolve, 150));
    await press(ENTER);
    expect(v.state.doc.toString()).toBe("[[コード]]");
  });
});

describe("settling after a delayed DOM flush (iOS Safari)", () => {
  /** `requestAnimationFrame` の callback を溜め、`release` まで走らせない */
  function holdAnimationFrames(): { release: () => void } {
    const original = { request: window.requestAnimationFrame, cancel: window.cancelAnimationFrame };
    const held = new Map<number, FrameRequestCallback>();
    // 溜める前に本物の rAF で予約された id と重ならない値から振る。重ならない id の取り消しは本物へ渡す
    let next = 1_000_000_000;
    window.requestAnimationFrame = (callback) => {
      held.set(next, callback);
      return next++;
    };
    window.cancelAnimationFrame = (id) => {
      if (!held.delete(id)) original.cancel.call(window, id);
    };
    return {
      release() {
        // 溜めた callback が次の frame を頼むことがあるので、空になるまで回す
        while (held.size > 0) {
          const [id, callback] = held.entries().next().value as [number, FrameRequestCallback];
          held.delete(id);
          callback(performance.now());
        }
        window.requestAnimationFrame = original.request;
        window.cancelAnimationFrame = original.cancel;
      },
    };
  }

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));
  const domSelectionCollapsed = () => document.getSelection()?.isCollapsed;

  /**
   * `[[` を変換して確定する。確定分の DOM 変更は、iOS と同じく次の frame まで読ませない。
   * `measureFirst` なら、遅らせた flush より前に measure の frame を予約しておく
   */
  async function commitWithDelayedFlush(v: EditorView, measureFirst: boolean): Promise<void> {
    // iOS は変換中の文字列（marked text）全体を DOM の選択にする
    await cdp().send("Input.imeSetComposition", { text: "[[", selectionStart: 0, selectionEnd: 2 });
    expect(domSelectionCollapsed()).toBe(false);
    expect(v.state.selection.main).toMatchObject({ from: 1, to: 3 });
    // compose の transaction が頼んだ measure を先に済ませる。溜めた後に残っていると、その measure が
    // 遅らせた flush を片付けてしまい、どちらの順で予約したかを選べない
    await nextFrame();
    log = [];

    const frames = holdAnimationFrames();
    try {
      // 待つ間に measure が本物の rAF で予約し直されていると、溜められずに次の frame で走ってしまう。
      // 座標の読み取りは、予約済みの measure をその場で済ませて予約を取り消す
      v.coordsAtPos(0);
      if (measureFirst) v.requestMeasure();
      // iOS は確定の直前に変換中の文字列を消してから入れ直し、CodeMirror はその DOM の変更を
      // 次の frame まで読まない（@codemirror/view 6.43.12 の DOMObserver の MutationObserver の
      // callback、`browser.ios && view.composing` の分岐の flushSoon）。Chromium はこの分岐に
      // 入らないので、同じ遅れを白箱で作る
      // biome-ignore lint/suspicious/noExplicitAny: CodeMirror の内部の DOMObserver を直接呼ぶ
      (v as any).observer.flushSoon();
      await commit("[[");
      await macrotask();
      // 遅れた flush がまだ確定後の選択（DOM では折りたたまれている）を読んでおらず、settle もまだ。
      // 修正前はここで settle し、古い選択（[[ 全体）を DOM に書き戻していた
      expect(v.state.selection.main).toMatchObject({ from: 1, to: 3 });
      expect(domSelectionCollapsed()).toBe(true);
      expect(isCompositionUnsettled(v)).toBe(true);
    } finally {
      frames.release();
    }
    await settled(v);
  }

  /** 確定後の選択を flush が読んでから、settle の transaction が来た */
  function expectSettledAfterFlush(): void {
    // 遅れた flush は確定後の選択を compose の入力として入れ、settle は空の transaction（effect）
    expect(kindsOf(afterComposition(), "transaction")).toEqual(["input.type.compose", "effect"]);
  }

  async function expectCommittedBracketsKept(v: EditorView): Promise<void> {
    expect(v.state.doc.toString()).toBe("前[[");
    expect(v.state.selection.main).toMatchObject({ from: 3, to: 3 });
    expect(domSelectionCollapsed()).toBe(true);
    await commit("こ");
    expect(v.state.doc.toString()).toBe("前[[こ");
  }

  it("keeps the committed [[ when the DOM flush is held until the next frame", async () => {
    const v = mount("前");
    await commitWithDelayedFlush(v, false);
    expectSettledAfterFlush();
    await expectCommittedBracketsKept(v);
  });

  // measure の forceFlush が遅れた flush を取り消して先に読む順でも、settle はその後になる
  it("keeps the committed [[ when a measure frame was requested before the delayed flush", async () => {
    const v = mount("前");
    await commitWithDelayedFlush(v, true);
    expectSettledAfterFlush();
    await expectCommittedBracketsKept(v);
  });
});

describe("page embed inside a conversion", () => {
  it("rebuilds the nested body on invalidate without breaking the outer conversion", async () => {
    const content: PageEmbedContent = { kind: "resolved", title: "Note", text: "[[なし]] へ" };
    let missing = false;
    const v = mount("![[Note]]\n\n", {
      resolvePageEmbed: () => content,
      resolveWikiLink: () => !missing,
    });
    const unresolvedInBody = () =>
      v.contentDOM.querySelectorAll(".cm-embed-page-body .cm-wikilink-unresolved").length;
    expect(unresolvedInBody()).toBe(0);
    log = [];

    await compose("あ");
    missing = true;
    invalidateDecorations(v);
    // 入れ子の view は変換していないので、外側の変換中でもその場で組み直す
    expect(unresolvedInBody()).toBe(1);
    await compose("あい");
    await commit("愛");
    await settled(v);

    expect(v.state.doc.toString()).toBe("![[Note]]\n\n愛");
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
    const during = duringComposition();
    expect(kindsOf(during, "decoration-rebuild")).toEqual([]);
    expectOnlyComposeTransactions(during);
  });
});
