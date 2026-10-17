import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CreateEditorOptions, createEditor } from "./create-editor";
import { isCompositionUnsettled } from "./ime";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function mount(doc: string, options: CreateEditorOptions = {}): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = createEditor(host, { doc, ...options });
  cleanups.push(() => {
    view.destroy();
    host.remove();
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
}

const box = (v: EditorView) => v.contentDOM.querySelector<HTMLElement>(".cm-frontmatter");
const chipTexts = (v: EditorView) =>
  [...v.contentDOM.querySelectorAll(".cm-frontmatter-chip, .cm-frontmatter-label")].map(
    (element) => element.textContent ?? "",
  );
const visibleLines = (v: EditorView) =>
  [...v.contentDOM.querySelectorAll(".cm-line")]
    .filter((line) => !line.classList.contains("cm-frontmatter-folded"))
    .map((line) => line.textContent ?? "");

function placeCursor(v: EditorView, at: number): void {
  v.focus();
  v.dispatch({ selection: EditorSelection.cursor(at) });
}

function press(element: HTMLElement | null): void {
  if (!element) throw new Error("the element is not drawn");
  element.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
  );
}

const doc = ["---", "tags: [仕事, 読書]", "aliases:", "  - 別名", "title: X", "---", "本文"].join(
  "\n",
);

describe("frontmatter block", () => {
  it("tags と aliases を chip で見せ、他のキーは件数だけ出す", () => {
    const v = mount(doc);
    expect(box(v)).not.toBeNull();
    expect(chipTexts(v)).toEqual(["#仕事", "#読書", "別名", "別名", "ほか 1 項目"]);
  });

  it("キーが 1 つも無ければ枠だけを見せる", () => {
    expect(chipTexts(mount("---\n---\n本文"))).toEqual(["プロパティ"]);
  });

  describe("枠の aria-label", () => {
    const label = (source: string) => box(mount(source))?.getAttribute("aria-label");

    it("中身を含めず「プロパティ」だけにする（中身は group の中の chip が伝える）", () => {
      expect(label(doc)).toBe("プロパティ");
      expect(label("---\ntags: [仕事]\n---\n本文")).toBe("プロパティ");
      expect(label("---\n---\n本文")).toBe("プロパティ");
    });

    it("tags を書き換えても名前は変わらない", () => {
      const v = mount("---\ntags: [仕事]\n---\n本文");
      v.dispatch({ changes: { from: "---\ntags: [".length, insert: "読書, " } });
      expect(box(v)?.getAttribute("aria-label")).toBe("プロパティ");
      expect(chipTexts(v)).toEqual(["#読書", "#仕事"]);
    });
  });

  it("2 行目以降を畳み、本文は残す", () => {
    const v = mount(doc);
    // 見えているのは枠の行（中身は widget の文字）と本文の 2 行だけ
    expect(visibleLines(v)).toHaveLength(2);
    expect(visibleLines(v).at(-1)).toBe("本文");
    expect(v.contentDOM.querySelectorAll(".cm-frontmatter-folded")).toHaveLength(5);
  });

  it("枠の上下に空の行ボックスを作らない", () => {
    const v = mount(doc);
    const line = v.contentDOM.querySelector<HTMLElement>(".cm-line");
    const element = box(v);
    if (!line || !element) throw new Error("the box is not drawn");

    // widget が `display: block` だと、CodeMirror が前後に置く `img.cm-widgetBuffer` が独立した
    // 行ボックスになり、枠の上下に本文 1 行分の空白が出る（theme.ts）。行の高さで見張る。
    expect(line.getBoundingClientRect().height).toBeCloseTo(
      element.getBoundingClientRect().height,
      0,
    );
  });

  it("カーソルが範囲に触れると source に戻す", () => {
    const v = mount(doc);
    placeCursor(v, doc.indexOf("tags"));

    expect(box(v)).toBeNull();
    expect(v.contentDOM.querySelectorAll(".cm-frontmatter-source")).toHaveLength(6);
    expect(visibleLines(v)).toEqual(doc.split("\n"));
  });

  it("枠のクリックで先頭にカーソルを置いて source を出す", () => {
    const v = mount(doc);
    press(box(v));

    expect(v.state.selection.main.head).toBe(0);
    expect(box(v)).toBeNull();
  });

  it("tag の chip のクリックは tag の遷移を呼び、枠を畳んだままにする", () => {
    const onTagClick = vi.fn();
    const v = mount(doc, { onTagClick });
    press(v.contentDOM.querySelector<HTMLElement>(".cm-frontmatter-chip.cm-tag"));

    expect(onTagClick).toHaveBeenCalledWith({ name: "仕事" });
    expect(box(v)).not.toBeNull();
    expect(v.state.selection.main.head).toBe(0);
  });

  describe("キーボード", () => {
    const keydown = (element: HTMLElement | null, key: string, init: KeyboardEventInit = {}) => {
      if (!element) throw new Error("the element is not drawn");
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      element.dispatchEvent(event);
      return event;
    };
    const tagChip = (v: EditorView) =>
      v.contentDOM.querySelector<HTMLElement>(".cm-frontmatter-chip.cm-tag");

    it("tag の chip は Tab で届くリンクで、支援技術から押せるよう button の子にしない", () => {
      const v = mount(doc, { onTagClick: vi.fn() });
      const chip = tagChip(v);
      expect(chip?.tabIndex).toBe(0);
      expect(chip?.getAttribute("role")).toBe("link");
      expect(chip?.closest("[role=button]")).toBeNull();
      expect(box(v)?.getAttribute("role")).toBe("group");
    });

    it("chip の focus の枠（太さ 2px と間隔 1px）と枠の線の間に、2px 以上空ける", () => {
      const v = mount(doc, { onTagClick: vi.fn() });
      const chip = tagChip(v)?.getBoundingClientRect();
      const frame = box(v);
      if (!chip || !frame) throw new Error("the chip is not drawn");
      const outer = frame.getBoundingClientRect();
      const ring = 3;
      const clearance = 2;
      expect(chip.top - outer.top - frame.clientTop).toBeGreaterThanOrEqual(ring + clearance);
      expect(outer.bottom - frame.clientTop - chip.bottom).toBeGreaterThanOrEqual(ring + clearance);
    });

    it("tag の chip で Enter を押すとクリックと同じ遷移を呼び、枠を畳んだままにする", () => {
      const onTagClick = vi.fn();
      const v = mount(doc, { onTagClick });
      const second = v.contentDOM.querySelectorAll<HTMLElement>(".cm-frontmatter-chip.cm-tag")[1];

      const event = keydown(second ?? null, "Enter");

      expect(onTagClick).toHaveBeenCalledExactlyOnceWith({ name: "読書" });
      expect(event.defaultPrevented).toBe(true);
      expect(box(v)).not.toBeNull();
      expect(v.state.selection.main.head).toBe(0);
    });

    it("Enter 以外のキーと修飾キー付きの Enter では遷移しない", () => {
      const onTagClick = vi.fn();
      const v = mount(doc, { onTagClick });
      keydown(tagChip(v), " ");
      keydown(tagChip(v), "a");
      keydown(tagChip(v), "Enter", { metaKey: true });
      keydown(tagChip(v), "Enter", { ctrlKey: true });
      keydown(tagChip(v), "Enter", { altKey: true });
      keydown(tagChip(v), "Enter", { shiftKey: true });
      expect(onTagClick).not.toHaveBeenCalled();
    });

    it("chip のキー入力は本文を書き換えない", () => {
      const v = mount(doc, { onTagClick: vi.fn() });
      const before = v.state.doc.toString();
      for (const key of ["Enter", "Backspace", "Delete", "x"]) keydown(tagChip(v), key);
      expect(v.state.doc.toString()).toBe(before);
    });

    it("遷移を受け取る handler が無い view では chip に Tab を止めない", () => {
      const v = mount(doc);
      const chip = tagChip(v);
      expect(chip?.hasAttribute("tabindex")).toBe(false);
      expect(chip?.hasAttribute("role")).toBe(false);
    });
  });

  it("`#` 付きで書かれた tag も `#` を 1 つだけ見せる", () => {
    const onTagClick = vi.fn();
    const v = mount("---\ntags: [#仕事]\n---\n", { onTagClick });
    const chip = v.contentDOM.querySelector<HTMLElement>(".cm-frontmatter-chip.cm-tag");

    expect(chip?.textContent).toBe("#仕事");
    press(chip);
    expect(onTagClick).toHaveBeenCalledWith({ name: "仕事" });
  });

  it("composition が落ち着くまでクリックを無視する", async () => {
    const v = mount(doc);
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    press(box(v));
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    press(box(v));
    expect(box(v)).not.toBeNull();

    await vi.waitFor(() => expect(isCompositionUnsettled(v)).toBe(false));
    press(box(v));
    expect(box(v)).toBeNull();
  });

  it("枠の直後は畳んだままで、閉じ `---` の行末に触れると source に戻す", () => {
    const v = mount(doc);
    // 枠の直後（本文の先頭）にカーソルを置いても、枠の範囲には触れていないので畳んだまま
    placeCursor(v, doc.indexOf("本文"));
    expect(box(v)).not.toBeNull();

    // 閉じ `---` の行末に触れたら source に戻る（端点を含めて交差とみなす。IME 不変条件 2）
    placeCursor(v, doc.indexOf("本文") - 1);
    expect(box(v)).toBeNull();
  });

  it("閉じ `---` が無ければ畳まない", () => {
    const v = mount("---\ntags: [a]\n本文");
    expect(box(v)).toBeNull();
    expect(v.contentDOM.querySelectorAll(".cm-frontmatter-folded")).toHaveLength(0);
  });

  it("Live Preview を切ると畳まない", () => {
    expect(box(mount(doc, { livePreview: false }))).toBeNull();
  });

  it("focus できない view では畳んだまま、クリックでも開かない", () => {
    // 埋め込みの中の nested view がこれに当たる。`editable` が false だと contentDOM が
    // contenteditable でなくなり `view.focus()` が効かないので、枠を開く手立てが無い。
    // 読み取り専用でも focus できる view（閲覧用の本文）では、選択だけの dispatch は通るので開く。
    const v = mount(doc, { extensions: EditorView.editable.of(false) });
    expect(box(v)).not.toBeNull();

    press(box(v));
    expect(box(v)).not.toBeNull();
  });
});
