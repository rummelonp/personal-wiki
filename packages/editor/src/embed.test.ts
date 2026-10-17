import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MAX_EMBED_DIMENSION, WikiLink } from "@personal-wiki/markdown";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type CreateEditorOptions, createEditor } from "./create-editor";
import { invalidateDecorations } from "./decoration-plugin";
import { embeds, type PageEmbedContent } from "./embed";
import { isCompositionUnsettled } from "./ime";
import { wikiLinks } from "./wikilink";

// 1x1 の透明な PNG。サイズ指定が無ければ 1px で描かれる。
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// 画像として読めない data URL。存在しない添付（API が 404 を返す）と同じく error になる。
const BROKEN = "data:image/png;base64,AAAA";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc: string, options: CreateEditorOptions = {}): EditorView {
  host = document.createElement("div");
  // 幅の指定が行幅に収まるようにする（`max-width: 100%` で縮むと幅の検証にならない）
  host.style.width = "800px";
  document.body.append(host);
  view = createEditor(host, { doc, resolveAttachmentUrl: () => PIXEL, ...options });
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

const embedOf = (v: EditorView, target: string) =>
  v.contentDOM.querySelector<HTMLElement>(`[data-embed-target="${target}"]`);
const imgOf = (v: EditorView, target: string) => embedOf(v, target)?.querySelector("img") ?? null;
/**
 * 見た目の本文と同じテキスト。編集ボタンはホバー等でしか出さない chrome で本文ではないので、
 * ドキュメントの内容だけを見るテストからは除く。
 */
function visibleText(el: Element | null | undefined): string {
  if (!el) return "";
  const clone = el.cloneNode(true) as Element;
  for (const button of clone.querySelectorAll(".cm-embed-edit")) button.remove();
  return clone.textContent ?? "";
}
const firstLineText = (v: EditorView) => visibleText(v.contentDOM.querySelector(".cm-line"));
/** embed の上に重ねて出した記法 */
const sourceOf = (v: EditorView) => v.contentDOM.querySelector<HTMLElement>(".cm-embed-source");

/** 全 extension の `Decoration.replace` の範囲（widget だけの点は含めない） */
const replaceRanges = (v: EditorView) => {
  const ranges: [number, number][] = [];
  for (const source of v.state.facet(EditorView.decorations)) {
    const set = typeof source === "function" ? source(v) : source;
    set.between(0, v.state.doc.length, (from, to, value) => {
      if (value.point && from < to) ranges.push([from, to]);
    });
  }
  return ranges;
};

const placeCursor = (v: EditorView, pos: number) => {
  v.focus();
  v.dispatch({ selection: EditorSelection.cursor(pos) });
};

async function loadedImg(v: EditorView, target: string): Promise<HTMLImageElement> {
  await expect.poll(() => imgOf(v, target)?.complete && imgOf(v, target)?.naturalWidth).toBe(1);
  return imgOf(v, target) as HTMLImageElement;
}

describe("image embed", () => {
  it("replaces the whole markup with the image while the editor is not focused", () => {
    const v = mount("前 ![[image.png]] 後");
    expect(imgOf(v, "image.png")?.getAttribute("src")).toBe(PIXEL);
    expect(firstLineText(v)).toBe("前  後");
    expect(v.state.doc.toString()).toBe("前 ![[image.png]] 後");
  });

  it("asks the host for the URL by the target filename", () => {
    const resolve = vi.fn(() => PIXEL);
    mount("![[folder/写真.PNG|300]]", { resolveAttachmentUrl: resolve });
    expect(resolve).toHaveBeenCalledWith("folder/写真.PNG");
  });

  it("shows the image 300px wide for |300", async () => {
    const v = mount("![[image.png|300]]");
    const img = await loadedImg(v, "image.png");
    expect(img.getBoundingClientRect().width).toBe(300);
    // 高さの指定が無いので縦横比を保つ（1x1 の画像なので 300）
    expect(img.getBoundingClientRect().height).toBe(300);
  });

  it("leaves room above and below, so the image does not touch the lines around it", async () => {
    const v = mount("前\n![[image.png|300x200]]\n後");
    const img = await loadedImg(v, "image.png");
    const line = img.closest(".cm-line")?.getBoundingClientRect();
    const rect = img.getBoundingClientRect();
    if (!line) throw new Error("行が無い");
    expect(rect.top - line.top).toBeGreaterThanOrEqual(10);
    expect(line.bottom - rect.bottom).toBeGreaterThanOrEqual(10);
  });

  it("does not widen the line around an image that is no taller than a line", async () => {
    const v = mount("前 ![[image.png|10]] 後");
    const img = await loadedImg(v, "image.png");
    await vi.waitFor(() =>
      expect(embedOf(v, "image.png")?.hasAttribute("data-embed-compact")).toBe(true),
    );
    // 行は文字の 1 行（28px）のまま。余白（12px ずつ）を足すと 52px になる
    expect(img.closest(".cm-line")?.getBoundingClientRect().height).toBeLessThan(40);
  });

  it("does not add the margin to an image written inside a sentence", async () => {
    const v = mount("前 ![[image.png|300x200]] 後");
    const img = await loadedImg(v, "image.png");
    const line = img.closest(".cm-line")?.getBoundingClientRect();
    if (!line) throw new Error("行が無い");
    expect(embedOf(v, "image.png")?.classList.contains("cm-embed-block")).toBe(false);
    expect(line.height).toBeLessThan(200 + 12);
  });

  it("keeps the edit button inside the image, not over the margin below it", async () => {
    const v = mount("前\n![[image.png|300x200]]\n後");
    const img = await loadedImg(v, "image.png");
    const button = embedOf(v, "image.png")?.querySelector<HTMLElement>(".cm-embed-edit");
    if (!button) throw new Error("編集ボタンが無い");
    const imgRect = img.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(imgRect.top);
    expect(rect.bottom).toBeLessThanOrEqual(imgRect.bottom);
    expect(rect.right).toBeLessThanOrEqual(imgRect.right);
  });

  it("names the edit button after what it edits, with the visible text in it", () => {
    const v = mount("![[image.png]]");
    const button = embedOf(v, "image.png")?.querySelector<HTMLElement>(".cm-embed-edit");
    expect(button?.textContent).toBe("記法を編集");
    expect(button?.getAttribute("aria-label")).toBe("「image.png」の埋め込み記法を編集");
    expect(button?.getAttribute("aria-label")).toContain(button?.textContent ?? "");
  });

  it.each(["120x80", "40x30"])("fits the edit button inside a %s image", async (size) => {
    const v = mount(`前\n![[image.png|${size}]]\n後`);
    const img = await loadedImg(v, "image.png");
    const button = embedOf(v, "image.png")?.querySelector<HTMLElement>(".cm-embed-edit");
    if (!button) throw new Error("編集ボタンが無い");
    const imgRect = img.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(imgRect.left);
    expect(rect.right).toBeLessThanOrEqual(imgRect.right);
    expect(rect.height).toBeLessThan(imgRect.height);
  });

  it("starts the source overlay at or above the image's top edge", async () => {
    const v = mount("前\n![[image.png|300x200]]\n後");
    const img = await loadedImg(v, "image.png");
    placeCursor(v, "前\n![[image".length);
    const overlay = v.contentDOM.querySelector<HTMLElement>(".cm-embed-source-overlay");
    if (!overlay) throw new Error("source が重なっていない");
    const imgRect = img.getBoundingClientRect();
    const rect = overlay.getBoundingClientRect();
    expect(rect.top).toBeLessThanOrEqual(imgRect.top);
    expect(rect.bottom).toBeGreaterThan(imgRect.top);
  });

  it("reads the size written after \\| as in a table cell", async () => {
    const v = mount("![[image.png\\|300]]");
    const img = imgOf(v, "image.png") as HTMLImageElement;
    await vi.waitFor(() => expect(img.getBoundingClientRect().width).toBe(300));
  });

  it("applies both the width and the height for |300x200", async () => {
    const v = mount("![[image.png|300x200]]");
    const img = await loadedImg(v, "image.png");
    expect(img.getBoundingClientRect().width).toBe(300);
    expect(img.getBoundingClientRect().height).toBe(200);
  });

  it("keeps the height even under a CSS reset that sets img { height: auto }", async () => {
    const style = document.createElement("style");
    style.textContent = "img { max-width: 100%; height: auto; }";
    document.head.append(style);
    try {
      const v = mount("![[image.png|300x200]]");
      const img = await loadedImg(v, "image.png");
      expect(img.getBoundingClientRect().height).toBe(200);
    } finally {
      style.remove();
    }
  });

  it("uses a non-size label as the alt text and keeps the natural size", async () => {
    const v = mount("![[image.png|abc]]");
    const img = await loadedImg(v, "image.png");
    expect(img.alt).toBe("abc");
    expect(img.getBoundingClientRect().width).toBe(1);
  });

  it.each(["0", "300x0", String(MAX_EMBED_DIMENSION + 1), "99999999999999999999"])(
    "ignores the unusable size |%s and shows the natural size",
    async (label) => {
      const v = mount(`![[image.png|${label}]]`);
      const img = await loadedImg(v, "image.png");
      expect(img.alt).toBe("image.png");
      expect(img.style.width).toBe("");
      expect(img.getBoundingClientRect().width).toBe(1);
    },
  );

  it("shrinks an image wider than the line without distorting it", async () => {
    const v = mount("![[image.png|2000x1000]]");
    const img = await loadedImg(v, "image.png");
    const lineWidth = (v.contentDOM.querySelector(".cm-line") as HTMLElement).clientWidth;
    expect(img.getBoundingClientRect().width).toBeLessThanOrEqual(lineWidth);
    expect(getComputedStyle(img).objectFit).toBe("contain");
  });
});

describe("markdown image", () => {
  it("renders ![alt](url) as an image for an allowed scheme", () => {
    const v = mount("前 ![alt テキスト](https://example.com/a.png) 後");
    const img = imgOf(v, "https://example.com/a.png");
    expect(img?.getAttribute("src")).toBe("https://example.com/a.png");
    expect(img?.alt).toBe("alt テキスト");
    expect(img?.referrerPolicy).toBe("no-referrer");
    expect(img?.loading).toBe("lazy");
    expect(firstLineText(v)).toBe("前  後");
    expect(v.state.doc.toString()).toBe("前 ![alt テキスト](https://example.com/a.png) 後");
  });

  it("strips angle brackets from <url> as markdown link does", () => {
    const v = mount("![alt](<https://example.com/a.png>)");
    expect(imgOf(v, "https://example.com/a.png")?.getAttribute("src")).toBe(
      "https://example.com/a.png",
    );
  });

  it("uses the url as alt when the label is empty", () => {
    const v = mount("![](https://example.com/a.png)");
    expect(imgOf(v, "https://example.com/a.png")?.alt).toBe("https://example.com/a.png");
  });

  it("allows a same-origin absolute path for help images", () => {
    const v = mount("![help](/help/foo.png)");
    expect(imgOf(v, "/help/foo.png")?.getAttribute("src")).toBe("/help/foo.png");
  });

  it.each([
    ["a javascript: url", 'javascript:alert("x")'],
    ["a data: url", "data:text/html,<script>alert(1)</script>"],
    // mailto: はリンクのクリックでは許可するが、<img src> には意味を持たないので許可しない
    ["a mailto: url (allowed for link clicks, not for <img src>)", "mailto:test@example.com"],
    [
      "a protocol-relative url (same scheme rules apply, // is not a same-origin path)",
      "//evil.example/a.png",
    ],
    // \ は特別 scheme では / と同じに扱われる（URL 仕様）ので、見た目の判定だけだと
    // //evil.example/a.png と同じ protocol-relative url として host が evil.example に解決してしまう
    [
      "a backslash-disguised path (URL parsing normalizes \\ to / for special schemes)",
      "/\\evil.example/a.png",
    ],
    ["a bare relative filename (no scheme, not an absolute path)", "foo.png"],
  ])("leaves the raw markup as text for %s", (_, url) => {
    const doc = `前 ![alt](${url}) 後`;
    const v = mount(doc);
    expect(v.contentDOM.querySelector("img")).toBeNull();
    expect(firstLineText(v)).toBe(doc);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("applies a size label written after | in the alt, like ![[a.png|300]]", () => {
    const v = mount("![alt|100](https://example.com/a.png)");
    const img = imgOf(v, "https://example.com/a.png");
    expect(img?.style.width).toBe("100px");
    expect(img?.style.height).toBe("");
  });

  it("applies both width and height for |100x145", () => {
    const v = mount("![Engelbart|100x145](https://example.com/a.png)");
    const img = imgOf(v, "https://example.com/a.png");
    expect(img?.style.width).toBe("100px");
    expect(img?.style.height).toBe("145px");
    // alt 本来の文字列とサイズ指定は両立しない（![[...]] の embed と同じ制約）ので、
    // alt は url にフォールバックし "Engelbart" は残らない
    expect(img?.alt).toBe("https://example.com/a.png");
  });

  it("falls back to the text after | as alt when it does not parse as a size", () => {
    const v = mount("![alt|abc](https://example.com/a.png)");
    expect(imgOf(v, "https://example.com/a.png")?.alt).toBe("abc");
  });

  it("ignores an unusable size after | and falls back to the url as alt", () => {
    const v = mount("![alt|0](https://example.com/a.png)");
    expect(imgOf(v, "https://example.com/a.png")?.alt).toBe("https://example.com/a.png");
  });

  it("does not treat a reference-style image as an embed", () => {
    const v = mount("![alt][ref]\n\n[ref]: https://example.com/a.png");
    expect(v.contentDOM.querySelector("img")).toBeNull();
  });

  it("reveals the source when the cursor is inside, matching the wikilink embed", () => {
    const DOC = "前置き ![alt](https://example.com/a.png) 後ろ";
    const EMBED = "![alt](https://example.com/a.png)";
    const embedFrom = DOC.indexOf(EMBED);
    const v = mount(DOC);
    const img = imgOf(v, "https://example.com/a.png");
    placeCursor(v, embedFrom + 5);
    expect(firstLineText(v)).toBe(DOC);
    expect(sourceOf(v)?.textContent).toBe(EMBED);
    // 描いていた embed の DOM をそのまま使う（wikilink の embed と同じ eq の仕組み）
    expect(imgOf(v, "https://example.com/a.png")).toBe(img);
  });

  it("renders the image again once the cursor leaves", () => {
    const DOC = "前置き ![alt](https://example.com/a.png) 後ろ";
    const EMBED = "![alt](https://example.com/a.png)";
    const embedFrom = DOC.indexOf(EMBED);
    const embedTo = embedFrom + EMBED.length;
    const v = mount(DOC);
    placeCursor(v, embedFrom + 5);
    placeCursor(v, embedTo + 1);
    expect(imgOf(v, "https://example.com/a.png")).not.toBeNull();
    expect(firstLineText(v)).not.toContain("![");
  });

  it("never lays a Decoration.replace over the cursor, wherever it sits (IME invariant 2)", () => {
    const doc = "前 ![a](https://example.com/a.png)![b](https://example.com/b.png) 後";
    const v = mount(doc);
    for (let pos = 0; pos <= doc.length; pos += 1) {
      placeCursor(v, pos);
      const touching = replaceRanges(v).filter(([from, to]) => from <= pos && pos <= to);
      expect(touching, `cursor at ${pos}`).toEqual([]);
    }
  });
});

describe("unresolved image embed", () => {
  it("shows the filename when the image cannot be loaded", async () => {
    const v = mount("前 ![[missing.png]] 後", { resolveAttachmentUrl: () => BROKEN });
    await expect
      .poll(() => embedOf(v, "missing.png")?.querySelector(".cm-embed-unresolved")?.textContent)
      .toBe("missing.png");
    expect(imgOf(v, "missing.png")).toBeNull();
    expect(v.state.doc.toString()).toBe("前 ![[missing.png]] 後");
  });

  it("shows the filename when the host cannot build a URL", () => {
    const v = mount("![[image.png]]", { resolveAttachmentUrl: () => null });
    expect(embedOf(v, "image.png")?.querySelector(".cm-embed-unresolved")?.textContent).toBe(
      "image.png",
    );
    expect(imgOf(v, "image.png")).toBeNull();
  });

  it("shows the filename when no resolver is given", () => {
    host = document.createElement("div");
    document.body.append(host);
    view = createEditor(host, { doc: "![[image.png]]" });
    expect(visibleText(embedOf(view, "image.png"))).toBe("image.png");
  });
});

describe("reveal", () => {
  const DOC = "前置き ![[image.png|300]] 後ろ";
  const EMBED = "![[image.png|300]]";
  const embedFrom = DOC.indexOf(EMBED);
  const embedTo = embedFrom + EMBED.length;

  it("shows the source over the kept image when the cursor is inside the embed", () => {
    const v = mount(DOC);
    const img = imgOf(v, "image.png");
    placeCursor(v, embedFrom + 5);
    expect(firstLineText(v)).toBe(DOC);
    expect(sourceOf(v)?.textContent).toBe(EMBED);
    // 描いていた embed の DOM をそのまま使う（WidgetType.eq）ので、画像を読み直さない
    expect(imgOf(v, "image.png")).toBe(img);
    expect(img?.isConnected).toBe(true);
  });

  it.each([
    ["right before the !", embedFrom],
    ["right after the ]]", embedTo],
  ])("shows the source when the cursor sits %s", (_, pos) => {
    const v = mount(DOC);
    placeCursor(v, pos);
    expect(firstLineText(v)).toBe(DOC);
  });

  it("renders the image again once the cursor leaves the embed", () => {
    const v = mount(DOC);
    placeCursor(v, embedFrom + 5);
    placeCursor(v, embedTo + 1);
    expect(imgOf(v, "image.png")).not.toBeNull();
    expect(firstLineText(v)).not.toContain("![[");
  });

  it("reveals the source for any of multiple selection ranges", () => {
    const v = mount(DOC, { extensions: EditorState.allowMultipleSelections.of(true) });
    v.focus();
    v.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(embedFrom + 3),
      ]),
    });
    expect(sourceOf(v)?.textContent).toBe(EMBED);
    expect(replaceRanges(v)).toEqual([]);
  });

  it("never lays a Decoration.replace over the cursor, wherever it sits (IME invariant 2)", () => {
    const doc = "前 ![[a.png]]![[b.png|300]] 後";
    const v = mount(doc);
    for (let pos = 0; pos <= doc.length; pos += 1) {
      placeCursor(v, pos);
      const touching = replaceRanges(v).filter(([from, to]) => from <= pos && pos <= to);
      expect(touching, `cursor at ${pos}`).toEqual([]);
    }
  });

  it("keeps both images when the cursor sits between two adjacent embeds", () => {
    const doc = "![[a.png]]![[b.png]]";
    const v = mount(doc);
    const a = imgOf(v, "a.png");
    const b = imgOf(v, "b.png");
    placeCursor(v, "![[a.png]]".length);
    expect(imgOf(v, "a.png")).toBe(a);
    expect(imgOf(v, "b.png")).toBe(b);
    expect(
      [...v.contentDOM.querySelectorAll(".cm-embed-source")].map((e) => e.textContent),
    ).toEqual(["![[a.png]]", "![[b.png]]"]);
  });

  it("keeps the same image element while the cursor moves elsewhere", () => {
    const v = mount(`${DOC}\n\n2 行目`);
    const img = imgOf(v, "image.png");
    placeCursor(v, v.state.doc.length);
    placeCursor(v, v.state.doc.length - 1);
    expect(imgOf(v, "image.png")).toBe(img);
    expect(img?.isConnected).toBe(true);
  });
});

describe("source over a drawn embed", () => {
  const lineOf = (v: EditorView, target: string) =>
    embedOf(v, target)?.closest<HTMLElement>(".cm-line") ?? null;
  const heightOf = (element: Element | null | undefined) =>
    element?.getBoundingClientRect().height ?? Number.NaN;

  it("keeps the line height of an image embed while the cursor enters and leaves", async () => {
    const doc = "![[image.png|300x200]]\n\n後";
    const v = mount(doc);
    const img = await loadedImg(v, "image.png");
    const before = heightOf(lineOf(v, "image.png"));
    expect(before).toBeGreaterThanOrEqual(200);

    placeCursor(v, "![[image".length);
    expect(heightOf(lineOf(v, "image.png"))).toBe(before);
    // 記法は行の上端に、widget の左端から重なる
    const source = sourceOf(v)?.getBoundingClientRect();
    const line = lineOf(v, "image.png")?.getBoundingClientRect();
    expect(source?.top).toBeCloseTo(line?.top ?? Number.NaN, 0);
    expect(source?.left).toBeCloseTo(img.getBoundingClientRect().left, 0);

    placeCursor(v, v.state.doc.length);
    expect(sourceOf(v)).toBeNull();
    expect(heightOf(lineOf(v, "image.png"))).toBe(before);
    expect(imgOf(v, "image.png")).toBe(img);
  });

  it("keeps the height and the body view of a page embed while the source is shown", () => {
    const content: PageEmbedContent = {
      kind: "resolved",
      title: "Note",
      text: "1 行目\n\n2 行目\n\n3 行目",
    };
    const doc = "![[Note]]\n\n後";
    const v = mount(doc, { resolvePageEmbed: () => content });
    const nested = embedOf(v, "Note")?.querySelector(".cm-editor");
    const before = heightOf(lineOf(v, "Note"));

    placeCursor(v, "![[No".length);
    expect(sourceOf(v)?.textContent).toBe("![[Note]]");
    expect(heightOf(lineOf(v, "Note"))).toBe(before);
    expect(embedOf(v, "Note")?.querySelector(".cm-editor")).toBe(nested);
    expect(nested?.isConnected).toBe(true);
  });

  it("keeps the drawn embed while the target is edited, and redraws it after leaving", async () => {
    const resolve = vi.fn((_filename: string) => PIXEL);
    const doc = "![[image.png|300x200]]\n\n後";
    const v = mount(doc, { resolveAttachmentUrl: resolve });
    const img = await loadedImg(v, "image.png");
    const at = "![[image".length;

    placeCursor(v, at);
    v.dispatch({ changes: { from: at, insert: "2" }, selection: { anchor: at + 1 } });
    // 書きかけの target で URL を引かず、描いていた画像をそのまま残す
    expect(resolve).not.toHaveBeenCalledWith("image2.png");
    expect(imgOf(v, "image.png")).toBe(img);
    expect(sourceOf(v)?.textContent).toBe("![[image2.png|300x200]]");

    placeCursor(v, v.state.doc.length);
    expect(resolve).toHaveBeenCalledWith("image2.png");
    expect(embedOf(v, "image.png")).toBeNull();
    expect(imgOf(v, "image2.png")).not.toBeNull();
  });

  it("reflects a body that arrives while the source is shown", async () => {
    let content: PageEmbedContent = { kind: "loading" };
    const doc = "![[Note]]\n\n後";
    const v = mount(doc, { resolvePageEmbed: () => content });
    placeCursor(v, "![[No".length);
    expect(embedOf(v, "Note")?.getAttribute("data-embed-state")).toBe("loading");

    content = { kind: "resolved", title: "Note", text: "届いた本文" };
    invalidateDecorations(v);

    await expect.poll(() => embedOf(v, "Note")?.getAttribute("data-embed-state")).toBe("resolved");
    expect(sourceOf(v)?.textContent).toBe("![[Note]]");
  });

  it("shows only the source for an embed that has not been drawn yet", () => {
    const v = mount("");
    placeCursor(v, 0);
    v.dispatch({
      changes: { from: 0, insert: "![[image.png]]\n" },
      selection: { anchor: "![[image.png".length },
    });
    expect(embedOf(v, "image.png")).toBeNull();
    expect(sourceOf(v)).toBeNull();
    expect(firstLineText(v)).toBe("![[image.png]]");

    placeCursor(v, v.state.doc.length);
    expect(imgOf(v, "image.png")).not.toBeNull();
  });

  /** ブラウザが `pos` に文字（IME の未確定文字列を含む）を入れる位置 */
  const caretRectAt = (v: EditorView, pos: number) => {
    const { node, offset } = v.domAtPos(pos);
    const range = document.createRange();
    range.setStart(node, offset);
    return range.getBoundingClientRect();
  };

  it("puts text typed right after ]] beside the image, not under the source", async () => {
    const doc = "![[image.png|300x200]] 後";
    const v = mount(doc);
    const img = await loadedImg(v, "image.png");
    const pos = doc.indexOf(" 後");
    placeCursor(v, pos);

    const caret = caretRectAt(v, pos);
    const source = sourceOf(v)?.getBoundingClientRect();
    expect(caret.left).toBeCloseTo(img.getBoundingClientRect().right, 0);
    expect(caret.top).toBeGreaterThanOrEqual(source?.bottom ?? Number.NaN);
  });

  it("lays the source over an embed that follows a list marker", async () => {
    const doc = "- ![[image.png|300x200]] 後";
    const v = mount(doc);
    await loadedImg(v, "image.png");
    const before = heightOf(lineOf(v, "image.png"));
    placeCursor(v, doc.indexOf("image"));

    // 接頭辞（`- `）は折り返さないので、embed は見た目の 1 行目に来る
    expect(getComputedStyle(sourceOf(v) as HTMLElement).position).toBe("absolute");
    expect(heightOf(lineOf(v, "image.png"))).toBe(before);
  });

  it("lays the source over an embed that follows a quote marker", () => {
    const content: PageEmbedContent = { kind: "resolved", title: "Note", text: "1 行目\n\n2 行目" };
    const doc = "> ![[Note]] 後";
    const v = mount(doc, { resolvePageEmbed: () => content });
    // `> ` を見せたままの高さを基準にする。引用記号を出すかどうかは live preview がカーソルの
    // 行で決めるもので、記法を重ねるかどうかとは別に行の高さを変える。
    placeCursor(v, doc.length);
    const before = heightOf(lineOf(v, "Note"));

    placeCursor(v, doc.indexOf("Note"));
    expect(getComputedStyle(sourceOf(v) as HTMLElement).position).toBe("absolute");
    expect(heightOf(lineOf(v, "Note"))).toBe(before);
  });

  it("keeps the source in the flow for an embed that does not start its line", async () => {
    const doc = "前 ![[image.png|300x200]] 後";
    const v = mount(doc);
    const img = await loadedImg(v, "image.png");
    const before = heightOf(lineOf(v, "image.png"));
    placeCursor(v, doc.indexOf("image"));

    // 行の上端に重ねると、折り返した行では widget でなく前の本文を覆う
    const source = sourceOf(v) as HTMLElement;
    expect(getComputedStyle(source).position).toBe("static");
    expect(source.getBoundingClientRect().right).toBeLessThanOrEqual(
      img.getBoundingClientRect().left + 1,
    );
    expect(imgOf(v, "image.png")).toBe(img);
    expect(heightOf(lineOf(v, "image.png"))).toBe(before);
  });

  it("puts the source back in the flow over a loaded image one line tall, keeping the image", async () => {
    const doc = "![[image.png]] 後";
    const v = mount(doc);
    const img = await loadedImg(v, "image.png");
    await vi.waitFor(() =>
      expect(embedOf(v, "image.png")?.hasAttribute("data-embed-compact")).toBe(true),
    );
    const before = heightOf(lineOf(v, "image.png"));
    const pos = doc.indexOf(" 後");
    placeCursor(v, pos);

    const source = sourceOf(v) as HTMLElement;
    expect(getComputedStyle(source).position).toBe("static");
    expect(getComputedStyle(img).display).not.toBe("none");
    expect(heightOf(lineOf(v, "image.png"))).toBe(before);
    expect(caretRectAt(v, pos).left).toBeCloseTo(img.getBoundingClientRect().right, 0);
  });

  const compactCases: [string, string, CreateEditorOptions, string][] = [
    ["an unresolved image", "![[image.png]] 後", { resolveAttachmentUrl: () => null }, "image.png"],
    [
      "a page embed still loading",
      "![[Note]] 後",
      { resolvePageEmbed: () => ({ kind: "loading" }) },
      "Note",
    ],
  ];

  it.each(compactCases)(
    "puts the source back in the flow over %s, which is one line tall",
    (_, doc, options, target) => {
      const v = mount(doc, options);
      const before = heightOf(lineOf(v, target));
      const pos = doc.indexOf(" 後");
      placeCursor(v, pos);

      const source = sourceOf(v) as HTMLElement;
      expect(getComputedStyle(source).position).toBe("static");
      const widget = embedOf(v, target) as HTMLElement;
      expect(widget.isConnected).toBe(true);
      expect(getComputedStyle(widget).display).toBe("none");
      expect(heightOf(lineOf(v, target))).toBe(before);
      // `]]` の直後に打つ文字は記法の後ろに並ぶ
      expect(caretRectAt(v, pos).left).toBeCloseTo(source.getBoundingClientRect().right, 0);
    },
  );
});

// 再生できる短い webm をその場で作る。fixture を置かずに loadedmetadata まで確かめるため。
async function recordWebm(): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 48;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  const recorder = new MediaRecorder(canvas.captureStream(10), { mimeType: "video/webm" });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.start();
  for (const color of ["red", "blue", "red", "blue"]) {
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  recorder.stop();
  await stopped;
  return URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
}

describe("video embed", () => {
  let clip = "";
  beforeAll(async () => {
    clip = await recordWebm();
  });

  const videoOf = (v: EditorView, target: string) =>
    embedOf(v, target)?.querySelector("video") ?? null;

  // widget の内側の変化で transaction が起きていないことを見る（IME 不変条件 1）
  function mountCounting(doc: string, options: CreateEditorOptions = {}) {
    const counter = { transactions: 0 };
    const v = mount(doc, {
      resolveAttachmentUrl: () => clip,
      extensions: EditorView.updateListener.of((update) => {
        counter.transactions += update.transactions.length;
      }),
      ...options,
    });
    return { v, counter };
  }

  it("replaces the whole markup with a player that neither autoplays nor preloads the body", () => {
    const { v } = mountCounting("前 ![[clip.webm]] 後");
    const video = videoOf(v, "clip.webm");
    expect(video?.getAttribute("src")).toBe(clip);
    expect(video?.controls).toBe(true);
    expect(video?.autoplay).toBe(false);
    expect(video?.preload).toBe("metadata");
    expect(firstLineText(v)).toBe("前  後");
    expect(v.state.doc.toString()).toBe("前 ![[clip.webm]] 後");
  });

  it.each(["clip.mkv", "clip.mov", "clip.mp4", "clip.ogv", "clip.webm"])(
    "expands %s as a video",
    (target) => {
      const { v } = mountCounting(`![[${target}]]`);
      expect(videoOf(v, target)).not.toBeNull();
    },
  );

  it("asks the host for the URL by the target filename", () => {
    const resolve = vi.fn(() => clip);
    mountCounting("![[folder/動画.MP4]]", { resolveAttachmentUrl: resolve });
    expect(resolve).toHaveBeenCalledWith("folder/動画.MP4");
  });

  it("loads the metadata without dispatching a transaction", async () => {
    const { v, counter } = mountCounting("前 ![[clip.webm]] 後");
    await expect.poll(() => videoOf(v, "clip.webm")?.readyState ?? 0).toBeGreaterThanOrEqual(1);
    expect(videoOf(v, "clip.webm")?.videoWidth).toBe(64);
    expect(counter.transactions).toBe(0);
  });

  it("does not apply a size label", () => {
    const { v } = mountCounting("![[clip.webm|300x200]]");
    expect(videoOf(v, "clip.webm")?.style.width).toBe("");
    expect(videoOf(v, "clip.webm")?.style.height).toBe("");
  });

  // 見ているのはブラウザのコントロールではなく、editor がそのクリックを自分の選択操作として
  // 扱うかどうか（widget の ignoreEvent）なので、mouse event を video に直接送る。
  it("keeps the player for a click on it instead of moving the cursor into the embed", async () => {
    const doc = "前 ![[clip.webm]] 後\n\n2 行目";
    const { v } = mountCounting(doc);
    placeCursor(v, doc.length);
    const video = videoOf(v, "clip.webm") as HTMLVideoElement;
    await expect.poll(() => video.readyState).toBeGreaterThanOrEqual(1);
    const rect = video.getBoundingClientRect();
    const at = {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    video.dispatchEvent(new MouseEvent("mousedown", at));
    video.dispatchEvent(new MouseEvent("mouseup", at));
    expect(v.state.selection.main.head).toBe(doc.length);
    expect(videoOf(v, "clip.webm")).toBe(video);
  });

  it("keeps the same player while the cursor moves elsewhere", () => {
    const doc = "![[clip.webm]]\n\n2 行目";
    const { v } = mountCounting(doc);
    const video = videoOf(v, "clip.webm");
    placeCursor(v, doc.length);
    placeCursor(v, doc.length - 1);
    expect(videoOf(v, "clip.webm")).toBe(video);
  });

  it("shows the source when the cursor is inside the embed", () => {
    const doc = "前 ![[clip.webm]] 後";
    const { v } = mountCounting(doc);
    const video = videoOf(v, "clip.webm");
    placeCursor(v, doc.indexOf("clip"));
    expect(firstLineText(v)).toBe(doc);
    expect(sourceOf(v)?.textContent).toBe("![[clip.webm]]");
    // 同じ video 要素を残すので、再生位置も読み込んだメタデータも失われない
    expect(videoOf(v, "clip.webm")).toBe(video);
  });

  it("does not decorate the expanded embed as a WikiLink", () => {
    const { v } = mountCounting("前 ![[clip.webm]] 後");
    expect(v.contentDOM.querySelector('[data-wikilink-target="clip.webm"]')).toBeNull();
  });

  it("shows the filename without dispatching when the video cannot be loaded", async () => {
    const { v, counter } = mountCounting("前 ![[missing.mp4]] 後", {
      resolveAttachmentUrl: () => "data:video/mp4;base64,AAAA",
    });
    await expect
      .poll(() => embedOf(v, "missing.mp4")?.querySelector(".cm-embed-unresolved")?.textContent)
      .toBe("missing.mp4");
    expect(videoOf(v, "missing.mp4")).toBeNull();
    expect(counter.transactions).toBe(0);
    expect(v.state.doc.toString()).toBe("前 ![[missing.mp4]] 後");
  });

  it("shows the filename when the host cannot build a URL", () => {
    const { v } = mountCounting("![[clip.mp4]]", { resolveAttachmentUrl: () => null });
    expect(embedOf(v, "clip.mp4")?.querySelector(".cm-embed-unresolved")?.textContent).toBe(
      "clip.mp4",
    );
    expect(videoOf(v, "clip.mp4")).toBeNull();
  });
});

describe("page embed", () => {
  const resolved = (title: string, text: string): PageEmbedContent => ({
    kind: "resolved",
    title,
    text,
  });
  const LOADING: PageEmbedContent = { kind: "loading" };
  const UNRESOLVED: PageEmbedContent = { kind: "unresolved" };
  const bodyOf = (v: EditorView, target: string) =>
    embedOf(v, target)?.querySelector<HTMLElement>(".cm-embed-page-body .cm-content") ?? null;

  it("replaces the markup with the page title and its body while the editor is not focused", () => {
    const content = resolved("Note", "埋め込まれた **本文**");
    const v = mount("前\n![[Note]]\n後", { resolvePageEmbed: () => content });

    const embed = embedOf(v, "Note");
    expect(embed?.getAttribute("data-embed-state")).toBe("resolved");
    expect(embed?.querySelector(".cm-embed-page-title")?.textContent).toBe("Note");
    // 本文も同じ live preview で描くので、記法は隠れる
    expect(bodyOf(v, "Note")?.textContent).toBe("埋め込まれた 本文");
    expect(v.state.doc.toString()).toBe("前\n![[Note]]\n後");
  });

  it("leaves room above and below the expanded body", () => {
    const v = mount("前\n![[Note]]\n後", {
      resolvePageEmbed: () => resolved("Note", "埋め込まれた本文"),
    });
    const embed = embedOf(v, "Note");
    const line = embed?.closest(".cm-line")?.getBoundingClientRect();
    const rect = embed?.getBoundingClientRect();
    if (!line || !rect) throw new Error("行が無い");
    expect(rect.top - line.top).toBeGreaterThanOrEqual(10);
    expect(line.bottom - rect.bottom).toBeGreaterThanOrEqual(10);
  });

  it("asks the host by the target, not by the label", () => {
    const resolve = vi.fn(() => resolved("Note", ""));
    mount("![[Note|別名]]", { resolvePageEmbed: resolve });
    expect(resolve).toHaveBeenCalledWith("Note");
  });

  describe("draft badge", () => {
    const BADGE = ".cm-wikilink-draft-badge";

    it("adds a text badge to the title of an embed whose target is a draft", () => {
      const v = mount("前\n![[Draft]]\n\n![[Open]]\n後", {
        resolvePageEmbed: (target) => resolved(target, "本文"),
        isDraftWikiLink: (target) => target === "Draft",
      });
      const title = embedOf(v, "Draft")?.querySelector(".cm-embed-page-title");
      expect(title?.querySelector(BADGE)?.textContent).toBe("下書き");
      // 読み上げでタイトルに続けて読まれるよう、印はタイトルの要素の中に置く
      expect(title?.textContent).toBe("Draft下書き");
      expect(embedOf(v, "Open")?.querySelector(BADGE)).toBeNull();
      expect(v.contentDOM.querySelectorAll(BADGE)).toHaveLength(1);
      expect(v.state.doc.toString()).toBe("前\n![[Draft]]\n\n![[Open]]\n後");
    });

    it("badges a draft embed while it is loading, but not when it is unresolved", () => {
      const loading = mount("![[Draft]]", {
        resolvePageEmbed: () => LOADING,
        isDraftWikiLink: () => true,
      });
      expect(embedOf(loading, "Draft")?.querySelector(BADGE)).not.toBeNull();
      const unresolved = mount("![[Draft]]", {
        resolvePageEmbed: () => UNRESOLVED,
        isDraftWikiLink: () => true,
      });
      expect(embedOf(unresolved, "Draft")?.querySelector(BADGE)).toBeNull();
    });

    // create-editor.ts は wikiLinks() にも同じ判定を渡すので、embeds() 単体の構成は別に組む
    describe("style", () => {
      const pageEmbeds = (): Extension =>
        embeds(undefined, {
          resolve: () => resolved("Draft", "本文"),
          render: (parent, text) => {
            parent.textContent = text;
            return { destroy: () => {} };
          },
          isDraft: () => true,
        });
      const mountWith = (...extensions: Extension[]) => {
        host = document.createElement("div");
        document.body.append(host);
        view = new EditorView({
          parent: host,
          state: EditorState.create({
            doc: "![[Draft]]",
            extensions: [markdown({ extensions: [WikiLink] }), ...extensions],
          }),
        });
        return view;
      };
      const badgeRules = (v: EditorView) =>
        v.state
          .facet(EditorView.styleModule)
          .filter((m) => m.getRules().includes("cm-wikilink-draft-badge")).length;

      // style は document 単位で 1 度だけ mount され、先に動いた別のテストの view でも入るので、
      // computed style ではなく、この view の state が theme を持つかを見る
      it("includes the badge style when only embeds() is given the draft test", () => {
        const v = mountWith(pageEmbeds());
        expect(v.contentDOM.querySelector(BADGE)).not.toBeNull();
        expect(badgeRules(v)).toBe(1);
      });

      it("keeps a single badge style when wikiLinks() is given the draft test too", () => {
        const v = mountWith(
          pageEmbeds(),
          wikiLinks(undefined, undefined, undefined, undefined, () => true),
        );
        expect(badgeRules(v)).toBe(1);
      });
    });

    it("does not badge an embed when no draft test is configured", () => {
      const v = mount("![[Draft]]", { resolvePageEmbed: () => resolved("Draft", "本文") });
      expect(v.contentDOM.querySelector(BADGE)).toBeNull();
    });

    it("does not badge the links inside the embedded body", () => {
      const v = mount("![[Note]]", {
        resolvePageEmbed: () => resolved("Note", "[[Draft]]"),
        isDraftWikiLink: (target) => target === "Draft",
      });
      expect(v.contentDOM.querySelector(BADGE)).toBeNull();
    });

    it("redraws the embed when the draft test result changes", async () => {
      let draft = false;
      const content = resolved("Draft", "本文");
      const v = mount("![[Draft]]", {
        resolvePageEmbed: () => content,
        isDraftWikiLink: () => draft,
      });
      expect(v.contentDOM.querySelector(BADGE)).toBeNull();

      draft = true;
      invalidateDecorations(v);
      await vi.waitFor(() => expect(v.contentDOM.querySelector(BADGE)).not.toBeNull());
    });

    // 作り直すと本文の入れ子の view が壊れ、本文で選んでいた範囲が消える
    it("adds and removes the badge without rebuilding the embedded body", async () => {
      let draft = false;
      const content = resolved("Draft", "本文");
      const v = mount("![[Draft]]", {
        resolvePageEmbed: () => content,
        isDraftWikiLink: () => draft,
      });
      const widget = embedOf(v, "Draft");
      const nested = widget?.querySelector(".cm-embed-page-body .cm-editor");
      expect(nested).not.toBeNull();

      draft = true;
      invalidateDecorations(v);
      await vi.waitFor(() => expect(v.contentDOM.querySelector(BADGE)).not.toBeNull());
      expect(embedOf(v, "Draft")).toBe(widget);
      expect(widget?.querySelector(".cm-embed-page-body .cm-editor")).toBe(nested);
      expect(widget?.querySelectorAll(BADGE)).toHaveLength(1);

      draft = false;
      invalidateDecorations(v);
      await vi.waitFor(() => expect(v.contentDOM.querySelector(BADGE)).toBeNull());
      expect(embedOf(v, "Draft")).toBe(widget);
      expect(widget?.querySelector(".cm-embed-page-body .cm-editor")).toBe(nested);
    });

    it("adds the badge to the same element while the embed is loading", async () => {
      let draft = false;
      const v = mount("![[Draft]]", {
        resolvePageEmbed: () => LOADING,
        isDraftWikiLink: () => draft,
      });
      const widget = embedOf(v, "Draft");

      draft = true;
      invalidateDecorations(v);
      await vi.waitFor(() => expect(v.contentDOM.querySelector(BADGE)).not.toBeNull());
      expect(embedOf(v, "Draft")).toBe(widget);
    });

    it("still rebuilds the embedded body when its content changes with the badge", async () => {
      let draft = false;
      let content = resolved("Draft", "本文");
      const v = mount("![[Draft]]", {
        resolvePageEmbed: () => content,
        isDraftWikiLink: () => draft,
      });
      const nested = embedOf(v, "Draft")?.querySelector(".cm-embed-page-body .cm-editor");

      draft = true;
      content = resolved("Draft", "別の本文");
      invalidateDecorations(v);
      await vi.waitFor(() => expect(v.contentDOM.querySelector(BADGE)).not.toBeNull());
      const rebuilt = embedOf(v, "Draft")?.querySelector(".cm-embed-page-body .cm-editor");
      expect(rebuilt).not.toBe(nested);
      expect(rebuilt?.textContent).toContain("別の本文");
    });
  });

  // 添付の配信 URL はページ単位なので、埋め込んだ本文の添付は埋め込み先のページで引く
  it("resolves an attachment inside an embedded body with the embedded page's target", () => {
    const resolve = vi.fn((filename: string, embedTarget?: string) =>
      embedTarget === undefined ? PIXEL : `${PIXEL}#${embedTarget}/${filename}`,
    );
    mount("![[own.png]]\n\n![[Note|別名]]", {
      resolvePageEmbed: () => resolved("Note", "![[inner.png]]"),
      resolveAttachmentUrl: resolve,
    });
    expect(resolve).toHaveBeenCalledWith("own.png");
    expect(resolve).toHaveBeenCalledWith("inner.png", "Note");
    expect(resolve).not.toHaveBeenCalledWith("inner.png");
  });

  // 埋め込み本文は create-editor.ts に readOnlyFocusable: false を渡して作るので、外側の
  // view と違って focus できない。クリックすると外側の view から focus が
  // 奪われ、記法表示や本文の縦位置が崩れるため。直接編集する経路は widget 右上の
  // 「編集」ボタンに絞り、本文自体はクリックできないままにする
  it("keeps the embedded body non-focusable", () => {
    const content = resolved("Note", "本文");
    const v = mount("![[Note]]", { resolvePageEmbed: () => content });
    expect(bodyOf(v, "Note")?.getAttribute("contenteditable")).toBe("false");
  });

  it("shows only the target for an unresolved page, whatever the reason", () => {
    // 無い page と読めない page を host は同じ unresolved で渡す。表示に理由も本文も出ない
    const v = mount("前 ![[Secret]] 後", { resolvePageEmbed: () => UNRESOLVED });
    const embed = embedOf(v, "Secret");
    expect(embed?.getAttribute("data-embed-state")).toBe("unresolved");
    expect(visibleText(embed)).toBe("Secret");
    expect(embed?.querySelector(".cm-embed-unresolved")?.textContent).toBe("Secret");
    expect(embed?.querySelector(".cm-embed-page-body")).toBeNull();
  });

  it("shows the target while loading and the body after the host invalidates", async () => {
    let content: PageEmbedContent = LOADING;
    const v = mount("![[Note]]", { resolvePageEmbed: () => content });
    expect(embedOf(v, "Note")?.getAttribute("data-embed-state")).toBe("loading");
    expect(visibleText(embedOf(v, "Note"))).toBe("Note");

    content = resolved("Note", "届いた本文");
    invalidateDecorations(v);

    await expect.poll(() => bodyOf(v, "Note")?.textContent).toBe("届いた本文");
  });

  it("holds a body that arrives during composition until the composition settles", async () => {
    // IME 不変条件 1。取得の完了は変換中にも届く。その間は widget を差し替えない
    let content: PageEmbedContent = LOADING;
    const v = mount("![[Note]]\n\n", { resolvePageEmbed: () => content });
    placeCursor(v, v.state.doc.length);

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    content = resolved("Note", "届いた本文");
    invalidateDecorations(v);
    expect(embedOf(v, "Note")?.getAttribute("data-embed-state")).toBe("loading");

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    await expect.poll(() => bodyOf(v, "Note")?.textContent).toBe("届いた本文");
  });

  it("does not expand the page into itself", () => {
    const v = mount("![[Me]]", { resolvePageEmbed: () => ({ kind: "self" }) });
    const embed = embedOf(v, "Me");
    expect(embed?.getAttribute("data-embed-state")).toBe("self");
    expect(visibleText(embed)).toBe("Me");
    expect(embed?.querySelector(".cm-embed-page-body")).toBeNull();
  });

  it("expands only one level, so an embed back to the source stays a link", () => {
    // A が B を、B が A を埋め込む相互参照。A の中の B は展開し、B の本文の中の ![[A]] は展開しない
    const resolve = vi.fn((target: string) =>
      target === "B" ? resolved("B", "B の本文 ![[A]] と ![[image.png]]") : UNRESOLVED,
    );
    const v = mount("![[B]]", { resolvePageEmbed: resolve });

    const body = bodyOf(v, "B");
    expect(body?.querySelector('[data-wikilink-target="A"]')).not.toBeNull();
    expect(body?.querySelector(".cm-embed-page")).toBeNull();
    expect(resolve.mock.calls.map(([target]) => target)).toEqual(["B"]);
    // 添付の embed は再帰しないので、埋め込んだ本文の中でも展開する
    expect(body?.querySelector('[data-embed-target="image.png"] img')).not.toBeNull();
  });

  it("shows the source while the cursor touches the markup", () => {
    const doc = "前 ![[Note]] 後";
    const v = mount(doc, { resolvePageEmbed: () => resolved("Note", "本文") });
    placeCursor(v, doc.indexOf(" 後"));
    expect(sourceOf(v)?.textContent).toBe("![[Note]]");
    expect(embedOf(v, "Note")?.getAttribute("data-embed-state")).toBe("resolved");
  });

  it("keeps the body view while the host returns the same content", () => {
    const content = resolved("Note", "本文");
    const doc = "![[Note]]\n\n2 行目";
    const v = mount(doc, { resolvePageEmbed: () => content });
    const body = bodyOf(v, "Note");

    placeCursor(v, doc.length);
    v.dispatch({ changes: { from: doc.length, insert: "を編集" } });
    invalidateDecorations(v);

    expect(bodyOf(v, "Note")).toBe(body);
    expect(body?.isConnected).toBe(true);
  });

  it("destroys the body view when the content changes", async () => {
    let content = resolved("Note", "本文");
    const v = mount("![[Note]]", { resolvePageEmbed: () => content });
    const nested = embedOf(v, "Note")?.querySelector(".cm-editor");
    expect(nested).not.toBeNull();

    content = UNRESOLVED;
    invalidateDecorations(v);

    await expect
      .poll(() => embedOf(v, "Note")?.getAttribute("data-embed-state"))
      .toBe("unresolved");
    // EditorView.destroy は自分の DOM を親から外す。widget の DOM ごと外れただけなら親は残る
    expect(nested?.parentNode).toBeNull();
  });

  it("navigates by the target when the title is clicked, without moving the cursor", () => {
    const onWikiLinkClick = vi.fn();
    const doc = "![[note]]\n\n2 行目";
    const v = mount(doc, { resolvePageEmbed: () => resolved("Note", "本文"), onWikiLinkClick });
    placeCursor(v, doc.length);

    embedOf(v, "note")
      ?.querySelector(".cm-embed-page-title")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));

    expect(onWikiLinkClick).toHaveBeenCalledWith({
      target: "note",
      label: null,
      blockId: null,
      heading: null,
    });
    expect(v.state.selection.main.head).toBe(doc.length);
  });

  it("navigates from a link inside the embedded body", () => {
    const onWikiLinkClick = vi.fn();
    const v = mount("![[Note]]", {
      resolvePageEmbed: () => resolved("Note", "[[Other]] へ"),
      onWikiLinkClick,
    });

    bodyOf(v, "Note")
      ?.querySelector('[data-wikilink-target="Other"]')
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));

    expect(onWikiLinkClick).toHaveBeenCalledWith({
      target: "Other",
      label: null,
      blockId: null,
      heading: null,
    });
  });

  describe("wikilinks inside the embedded body", () => {
    it("points a target-less link at the embedded page, in both the click and the href", () => {
      const onWikiLinkClick = vi.fn();
      const hrefForWikiLink = vi.fn((link: { target: string; heading: string | null }) =>
        link.target === "" ? "#外側" : `/p/${link.target}#${link.heading}`,
      );
      const resolveWikiLink = vi.fn(() => true);
      const v = mount("![[B]]", {
        resolvePageEmbed: () => resolved("B", "[[#節X]] と [[C#節Y]]"),
        onWikiLinkClick,
        hrefForWikiLink,
        resolveWikiLink,
      });
      const body = bodyOf(v, "B");

      const own = body?.querySelector('[data-wikilink-heading="節X"]');
      expect(own?.getAttribute("href")).toBe("/p/B#節X");
      own?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
      );
      expect(onWikiLinkClick).toHaveBeenLastCalledWith({
        target: "B",
        label: null,
        blockId: null,
        heading: "節X",
      });

      expect(resolveWikiLink).not.toHaveBeenCalledWith("");

      const other = body?.querySelector('[data-wikilink-heading="節Y"]');
      expect(other?.getAttribute("href")).toBe("/p/C#節Y");
      other?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
      );
      expect(onWikiLinkClick).toHaveBeenLastCalledWith({
        target: "C",
        label: null,
        blockId: null,
        heading: "節Y",
      });
    });

    const unresolvedIn = (v: EditorView) =>
      [...(bodyOf(v, "Note")?.querySelectorAll(".cm-wikilink-unresolved") ?? [])].map(
        (e) => e.textContent,
      );

    it("marks a link that becomes unresolved after invalidateDecorations on the outer view", () => {
      const content = resolved("Note", "[[あり]] と [[なし]]");
      const missing = new Set<string>();
      const v = mount("![[Note]]", {
        resolvePageEmbed: () => content,
        resolveWikiLink: (target) => !missing.has(target),
      });
      expect(unresolvedIn(v)).toEqual([]);

      missing.add("なし");
      invalidateDecorations(v);
      expect(unresolvedIn(v)).toEqual(["なし"]);
    });

    it("stops invalidating a nested view that was destroyed with its widget", () => {
      let content = resolved("Note", "[[なし]]");
      const resolveWikiLink = vi.fn(() => true);
      const v = mount("![[Note]]", { resolvePageEmbed: () => content, resolveWikiLink });
      content = UNRESOLVED;
      invalidateDecorations(v);
      expect(embedOf(v, "Note")?.getAttribute("data-embed-state")).toBe("unresolved");

      resolveWikiLink.mockClear();
      invalidateDecorations(v);
      expect(resolveWikiLink).not.toHaveBeenCalled();
    });

    it("holds the nested view's rebuild while that view is composing", () => {
      const content = resolved("Note", "[[なし]]");
      let missing = false;
      const v = mount("![[Note]]", {
        resolvePageEmbed: () => content,
        resolveWikiLink: () => !missing,
      });
      const nested = bodyOf(v, "Note");
      if (!nested) throw new Error("本文の view が無い");
      nested.dispatchEvent(new CompositionEvent("compositionstart"));

      missing = true;
      invalidateDecorations(v);
      expect(unresolvedIn(v)).toEqual([]);

      nested.dispatchEvent(new CompositionEvent("compositionend"));
      return vi.waitFor(() => expect(unresolvedIn(v)).toEqual(["なし"]));
    });
  });

  it("leaves block embeds to the WikiLink decoration", () => {
    const resolve = vi.fn(() => resolved("Note", "本文"));
    const v = mount("![[Note^abc]] ![[Note#^abc]]", { resolvePageEmbed: resolve });
    expect(v.contentDOM.querySelector(".cm-embed-page")).toBeNull();
    expect(v.contentDOM.querySelectorAll('[data-wikilink-target="Note"]')).toHaveLength(2);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("section embed", () => {
  const PAGE: PageEmbedContent = {
    kind: "resolved",
    title: "Note",
    text: "前文\n\n## A\n\nA の本文\n\n### A-1\n\n子の本文\n\n## B\n\nB の本文",
  };
  const sectionBodies = (v: EditorView) =>
    [...v.contentDOM.querySelectorAll<HTMLElement>(".cm-embed-page-body .cm-content")].map(
      (body) => body.textContent,
    );

  it("shows only the section from the heading to the next heading of the same level", () => {
    const v = mount("![[Note#A]]", { resolvePageEmbed: () => PAGE });
    const embed = embedOf(v, "Note");
    expect(embed?.getAttribute("data-embed-state")).toBe("resolved");
    expect(embed?.querySelector(".cm-embed-page-title")?.textContent).toBe("Note");
    expect(sectionBodies(v)).toEqual(["AA の本文A-1子の本文"]);
    expect(v.state.doc.toString()).toBe("![[Note#A]]");
  });

  it("asks the host by the page title and shares the fetched content between sections", () => {
    const resolve = vi.fn((_target: string) => PAGE);
    const v = mount("![[Note#A#A-1]]\n\n![[Note#B|別名]]", { resolvePageEmbed: resolve });
    expect(resolve.mock.calls.map(([target]) => target)).toEqual(["Note", "Note"]);
    expect(sectionBodies(v)).toEqual(["A-1子の本文", "BB の本文"]);
  });

  it("falls back to the whole page when the heading is missing", () => {
    const v = mount("![[Note#無い見出し]]", { resolvePageEmbed: () => PAGE });
    expect(sectionBodies(v)).toEqual(["前文AA の本文A-1子の本文BB の本文"]);
  });

  it("shows the target while loading and the section after the host invalidates", async () => {
    let content: PageEmbedContent = { kind: "loading" };
    const v = mount("![[Note#B]]", { resolvePageEmbed: () => content });
    expect(embedOf(v, "Note")?.getAttribute("data-embed-state")).toBe("loading");
    expect(visibleText(embedOf(v, "Note"))).toBe("Note");

    content = PAGE;
    invalidateDecorations(v);
    await expect.poll(() => sectionBodies(v)).toEqual(["BB の本文"]);
  });

  it("keeps the section view while the host returns the same content", () => {
    const doc = "![[Note#A]]\n\n2 行目";
    const v = mount(doc, { resolvePageEmbed: () => PAGE });
    const body = v.contentDOM.querySelector(".cm-embed-page-body .cm-content");

    placeCursor(v, doc.length);
    v.dispatch({ changes: { from: doc.length, insert: "を編集" } });
    invalidateDecorations(v);

    expect(v.contentDOM.querySelector(".cm-embed-page-body .cm-content")).toBe(body);
    expect(body?.isConnected).toBe(true);
  });

  it("does not expand a section of the page itself, nor show a reason for an unresolved one", () => {
    const v = mount("![[Me#A]] ![[Secret#A]]", {
      resolvePageEmbed: (target) => (target === "Me" ? { kind: "self" } : { kind: "unresolved" }),
    });
    expect(embedOf(v, "Me")?.getAttribute("data-embed-state")).toBe("self");
    expect(embedOf(v, "Secret")?.getAttribute("data-embed-state")).toBe("unresolved");
    expect(visibleText(embedOf(v, "Secret"))).toBe("Secret");
    expect(v.contentDOM.querySelector(".cm-embed-page-body")).toBeNull();
  });

  it("extracts the section again when the fetched content changes", async () => {
    let content = PAGE;
    const v = mount("![[Note#B]]", { resolvePageEmbed: () => content });
    expect(sectionBodies(v)).toEqual(["BB の本文"]);

    content = { kind: "resolved", title: "Note", text: "## B\n\n書き換えた本文\n\n## C" };
    invalidateDecorations(v);
    await expect.poll(() => sectionBodies(v)).toEqual(["B書き換えた本文"]);

    // 見出しが消えた内容に変わると page 全体に戻る
    content = { kind: "resolved", title: "Note", text: "見出しの無い本文" };
    invalidateDecorations(v);
    await expect.poll(() => sectionBodies(v)).toEqual(["見出しの無い本文"]);
  });

  it("keeps the section view when only another section of the page changes", () => {
    let content = PAGE;
    const v = mount("![[Note#A]]", { resolvePageEmbed: () => content });
    const body = v.contentDOM.querySelector(".cm-embed-page-body .cm-content");

    content = {
      kind: "resolved",
      title: "Note",
      text: "前文\n\n## A\n\nA の本文\n\n### A-1\n\n子の本文\n\n## B\n\n書き換えた B の本文",
    };
    invalidateDecorations(v);

    expect(v.contentDOM.querySelector(".cm-embed-page-body .cm-content")).toBe(body);
    expect(body?.isConnected).toBe(true);
    expect(sectionBodies(v)).toEqual(["AA の本文A-1子の本文"]);
  });

  it("navigates to the page by the target when the title is clicked", () => {
    const onWikiLinkClick = vi.fn();
    mount("![[Note#A]]", { resolvePageEmbed: () => PAGE, onWikiLinkClick });
    view?.contentDOM
      .querySelector(".cm-embed-page-title")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(onWikiLinkClick).toHaveBeenCalledWith({
      target: "Note",
      label: null,
      blockId: null,
      heading: null,
    });
  });

  it("does not treat a same-page heading embed as an embed", () => {
    // 同じ page の見出しへの link は WikiLink だが、自分自身の embed は展開しない
    const resolve = vi.fn(() => PAGE);
    const v = mount("前 ![[#A]] 後", { resolvePageEmbed: resolve });
    expect(v.contentDOM.querySelector(".cm-embed-page")).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("leaves a section embed to the WikiLink decoration when the host cannot resolve pages", () => {
    const v = mount("前 ![[Note#A]] 後");
    expect(embedOf(v, "Note")).toBeNull();
    expect(v.contentDOM.querySelector('[data-wikilink-target="Note"]')).not.toBeNull();
  });
});

describe("embeds that are not expanded", () => {
  it("leaves a page embed to the WikiLink decoration when the host cannot resolve pages", () => {
    const v = mount("前 ![[Note]] 後");
    expect(embedOf(v, "Note")).toBeNull();
    expect(v.contentDOM.querySelector('[data-wikilink-target="Note"]')).not.toBeNull();
  });

  it("does not expand a plain link to an image file", () => {
    const v = mount("前 [[image.png]] 後");
    expect(embedOf(v, "image.png")).toBeNull();
    expect(v.contentDOM.querySelector('[data-wikilink-target="image.png"]')).not.toBeNull();
  });

  it("does not expand an embed inside inline code", () => {
    const v = mount("前 `![[image.png]]` 後");
    expect(embedOf(v, "image.png")).toBeNull();
  });

  it("does not decorate the expanded embed as a WikiLink", () => {
    const v = mount("前 ![[image.png]] 後");
    expect(v.contentDOM.querySelector('[data-wikilink-target="image.png"]')).toBeNull();
  });
});

describe("edit button", () => {
  const resolved = (title: string, text: string): PageEmbedContent => ({
    kind: "resolved",
    title,
    text,
  });
  const editButtonOf = (v: EditorView, target: string) =>
    embedOf(v, target)?.querySelector<HTMLButtonElement>(".cm-embed-edit") ?? null;
  const press = (button: HTMLButtonElement | null | undefined) => {
    if (!button) throw new Error("edit button is not drawn");
    button.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
    );
  };
  const countTransactions = (onCount: () => void): Extension =>
    EditorView.updateListener.of((update) => {
      for (const _ of update.transactions) onCount();
    });

  it("places the cursor right before ]] for a wikilink image embed", () => {
    const doc = "前 ![[image.png]] 後";
    const v = mount(doc);
    press(editButtonOf(v, "image.png"));
    expect(v.state.selection.main.head).toBe(doc.indexOf("]]"));
    expect(v.hasFocus).toBe(true);
  });

  it("places the cursor right before ) for a markdown image embed", () => {
    const doc = "前 ![alt](https://example.com/a.png) 後";
    const v = mount(doc);
    press(editButtonOf(v, "https://example.com/a.png"));
    expect(v.state.selection.main.head).toBe(doc.lastIndexOf(")"));
  });

  it("places the cursor right before ]] for a page embed", () => {
    const doc = "前 ![[Note]] 後";
    const v = mount(doc, { resolvePageEmbed: () => resolved("Note", "本文") });
    press(editButtonOf(v, "Note"));
    expect(v.state.selection.main.head).toBe(doc.indexOf("]]"));
  });

  it("works for an unresolved page embed too", () => {
    const doc = "前 ![[Secret]] 後";
    const v = mount(doc, { resolvePageEmbed: () => ({ kind: "unresolved" }) });
    press(editButtonOf(v, "Secret"));
    expect(v.state.selection.main.head).toBe(doc.indexOf("]]"));
  });

  it("works for an unresolved image embed too", () => {
    const doc = "前 ![[missing.png]] 後";
    const v = mount(doc, { resolveAttachmentUrl: () => null });
    press(editButtonOf(v, "missing.png"));
    expect(v.state.selection.main.head).toBe(doc.indexOf("]]"));
  });

  it("places the cursor right before ]] for a video embed", () => {
    const doc = "前 ![[clip.webm]] 後";
    const v = mount(doc);
    press(editButtonOf(v, "clip.webm"));
    expect(v.state.selection.main.head).toBe(doc.indexOf("]]"));
  });

  it("lands on the same position once the source is already shown inline", () => {
    // 記法の前が block の接頭辞でも空白でもないので、source は流れの中にそのまま出る
    // （embed.ts の onlyBlockPrefixBefore）。widget は記法の直後の点に移り、posAtDOM は
    // すでに終わりの位置を返す（editEmbedSource のもう一方の分岐）
    const doc = "前 ![[image.png]] 後";
    const v = mount(doc);
    placeCursor(v, doc.indexOf("image.png"));
    expect(sourceOf(v)?.textContent).toBe("![[image.png]]");
    press(editButtonOf(v, "image.png"));
    expect(v.state.selection.main.head).toBe(doc.indexOf("]]"));
  });

  // 名前が短い embed は widget が狭く、ボタンの幅がその幅までに切り詰められて「記…」になる
  it.each([
    ["page unresolved", "![[a]]", { resolvePageEmbed: () => ({ kind: "unresolved" as const }) }],
    ["page loading", "![[a]]", { resolvePageEmbed: () => ({ kind: "loading" as const }) }],
    ["page self", "![[a]]", { resolvePageEmbed: () => ({ kind: "self" as const }) }],
    ["image unresolved", "![[a.png]]", { resolveAttachmentUrl: () => null }],
    ["video unresolved", "![[a.webm]]", { resolveAttachmentUrl: () => null }],
  ] satisfies [string, string, CreateEditorOptions][])(
    "does not clip the button label of a short %s name",
    (_label, doc, options) => {
      const v = mount(doc, options);
      const button = v.contentDOM.querySelector<HTMLElement>(".cm-embed-edit");
      if (!button) throw new Error("edit button is not drawn");
      expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
    },
  );

  it("does not clip the button label of a long name either", () => {
    const v = mount("![[とても長い名前の存在しないページ]]", {
      resolvePageEmbed: () => ({ kind: "unresolved" }),
    });
    const button = editButtonOf(v, "とても長い名前の存在しないページ");
    if (!button) throw new Error("edit button is not drawn");
    expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
  });

  it("does not reserve room for the button after a short name", () => {
    const v = mount("前 ![[a]] 後", { resolvePageEmbed: () => ({ kind: "unresolved" }) });
    const embed = embedOf(v, "a");
    const button = editButtonOf(v, "a");
    const name = embed?.querySelector(".cm-embed-unresolved");
    if (!embed || !button || !name) throw new Error("embed is not drawn");
    expect(embed.getBoundingClientRect().width).toBeLessThan(button.getBoundingClientRect().width);
    // 名前の下に出し、hover の間も名前に重ならない
    expect(button.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      name.getBoundingClientRect().bottom,
    );
    expect(button.getBoundingClientRect().left).toBeCloseTo(embed.getBoundingClientRect().left, 0);
  });

  it("keeps the button of a name near the right edge inside the editor when it is shown", () => {
    const doc = `${Array.from({ length: 24 }, (_, i) => `${"あ".repeat(i + 4)} ![[ab]]`).join("\n\n")}\n\n最後`;
    const v = mount(doc, { resolvePageEmbed: () => ({ kind: "unresolved" }) });
    if (host) host.style.width = "300px";
    placeCursor(v, doc.length);
    const contentRight = () => v.contentDOM.getBoundingClientRect().right;
    const embeds = [...v.contentDOM.querySelectorAll<HTMLElement>(".cm-embed")];
    const buttonOf = (embed: HTMLElement) => {
      const button = embed.querySelector<HTMLElement>(".cm-embed-edit");
      if (!button) throw new Error("edit button is not drawn");
      return button;
    };
    // 初期の位置では切れる embed がある（無ければ、この test は何も見張らない）
    expect(
      embeds.some((embed) => buttonOf(embed).getBoundingClientRect().right > contentRight()),
    ).toBe(true);
    for (const embed of embeds) {
      embed.dispatchEvent(new PointerEvent("pointerenter"));
      expect(buttonOf(embed).getBoundingClientRect().right).toBeLessThanOrEqual(
        contentRight() + 0.5,
      );
    }
  });

  // 折り返した名前でも、ボタンは最後の行の左端の真下に出る（行の途中から始まる名前では、
  // 位置合わせが無いと最初の行の左端に付き、最後の行の下から離れる）。
  it.each([
    ["a single line", "前 ", "短い", "unresolved", false, 1],
    ["a name wrapped from the start of the line", "", "あ".repeat(40), "unresolved", false, 3],
    ["a name wrapped after text", "前の文です。", "あ".repeat(30), "unresolved", false, 2],
    [
      "a name with spaces",
      "前の文です。 ",
      "Getting Started With Cloudflare Workers",
      "unresolved",
      false,
      2,
    ],
    ["a draft name with a badge", "前の文です。 ", "あ".repeat(30), "loading", true, 3],
    ["a draft name with a badge on one line", "前 ", "短い", "loading", true, 1],
  ] as const)(
    "puts the button of %s under the left edge of its last line",
    (_label, prefix, name, kind, draft, lines) => {
      const doc = `${prefix}![[${name}]]\n\n最後`;
      const v = mount(doc, {
        resolvePageEmbed: () => ({ kind }),
        isDraftWikiLink: () => draft,
      });
      if (host) host.style.width = "300px";
      placeCursor(v, doc.length);
      const embed = embedOf(v, name);
      const button = editButtonOf(v, name);
      if (!embed || !button) throw new Error("embed is not drawn");
      const lastLine = [...(embed.firstElementChild?.getClientRects() ?? [])].at(-1);
      if (!lastLine) throw new Error("name is not drawn");
      expect(embed.firstElementChild?.getClientRects().length).toBe(lines);
      const width = button.getBoundingClientRect().width;
      embed.dispatchEvent(new PointerEvent("pointerenter"));
      const rect = button.getBoundingClientRect();
      expect(rect.left).toBeCloseTo(lastLine.left, 0);
      expect(rect.top).toBeCloseTo(lastLine.bottom, 0);
      expect(rect.width).toBeCloseTo(width, 0);
    },
  );

  it.each([
    ["image", "![[a.png]]", {}],
    ["unresolved page", "![[a]]", { resolvePageEmbed: () => ({ kind: "unresolved" as const }) }],
    ["page", "![[Note]]", { resolvePageEmbed: () => resolved("Note", "本文") }],
    ["video", "![[a.webm]]", {}],
  ] satisfies [string, string, CreateEditorOptions][])(
    "keeps the button of a %s embed out of the Tab order",
    (_label, doc, options) => {
      const v = mount(doc, options);
      expect(v.contentDOM.querySelector<HTMLElement>(".cm-embed-edit")?.tabIndex).toBe(-1);
    },
  );

  it.each([
    ["a short name", "ab", false],
    ["a name that fits in one line", "a".repeat(30), false],
    ["a long name with spaces", "Getting Started With Cloudflare Workers Guide", false],
    ["a long name without spaces", "あ".repeat(25), true],
    ["a long ASCII name without spaces", "A".repeat(41), true],
  ])("marks %s as breakable at any character: %s", (_label, name, expected) => {
    const doc = `![[${name}]]\n\n最後`;
    const v = mount(doc, { resolvePageEmbed: () => ({ kind: "unresolved" }) });
    placeCursor(v, doc.length);
    const element = embedOf(v, name)?.querySelector(".cm-embed-unresolved");
    expect(element?.classList.contains("cm-embed-long-name")).toBe(expected);
  });

  it("does not move the button of an image embed when the pointer enters", async () => {
    const v = mount("前\n![[image.png|120x80]]\n後");
    await loadedImg(v, "image.png");
    const embed = embedOf(v, "image.png");
    const button = editButtonOf(v, "image.png");
    if (!embed || !button) throw new Error("embed is not drawn");
    // 右へはみ出した状態にしても、補正は文字だけの widget のボタンにしか入れない
    embed.style.transform = "translateX(700px)";
    const content = v.contentDOM.getBoundingClientRect();
    expect(button.getBoundingClientRect().right).toBeGreaterThan(content.right);
    embed.dispatchEvent(new PointerEvent("pointerenter"));
    expect(button.style.left).toBe("");
  });

  it("hides the button of a text-only embed on a device that cannot hover, and leaves an image's", async () => {
    const v = mount("![[a]]\n\n![[image.png|120x80]]\n\n最後", {
      resolvePageEmbed: () => ({ kind: "unresolved" }),
    });
    await loadedImg(v, "image.png");
    // 実機の media の判定は差し替えられないので、media 抜きで同じ規則を当てる
    const rules: string[] = [];
    for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSMediaRule && rule.conditionText.includes("hover: none")) {
          for (const inner of rule.cssRules) rules.push(inner.cssText);
        }
      }
    }
    expect(rules.join("\n"), "no rule under @media (hover: none)").toContain("cm-embed-edit");
    const style = document.createElement("style");
    style.textContent = rules.join("\n");
    document.head.append(style);
    try {
      expect(getComputedStyle(editButtonOf(v, "a") as Element).display).toBe("none");
      expect(getComputedStyle(editButtonOf(v, "image.png") as Element).display).not.toBe("none");
    } finally {
      style.remove();
    }
  });

  it("does not show the button in a readOnly view", () => {
    const v = mount("![[image.png]]", { readOnly: true });
    expect(editButtonOf(v, "image.png")).toBeNull();
  });

  it("does not show the button on a readOnly page embed", () => {
    const v = mount("![[Note]]", {
      resolvePageEmbed: () => resolved("Note", "本文"),
      readOnly: true,
    });
    expect(editButtonOf(v, "Note")).toBeNull();
  });

  it("does not show the button inside the nested body of a page embed", () => {
    const v = mount("![[Note]]", {
      resolvePageEmbed: () => resolved("Note", "![[image.png]]"),
    });
    const body = embedOf(v, "Note")?.querySelector(".cm-embed-page-body");
    expect(body?.querySelector(".cm-embed-edit")).toBeNull();
    // 外側の embed 自体にはボタンが残る
    expect(editButtonOf(v, "Note")).not.toBeNull();
  });

  it("labels the button with the target for screen readers", () => {
    const v = mount("![[image.png]]");
    expect(editButtonOf(v, "image.png")?.getAttribute("aria-label")).toContain("image.png");
  });

  it("does not navigate when the button is clicked, unlike the title", () => {
    const onWikiLinkClick = vi.fn();
    const v = mount("![[Note]]", {
      resolvePageEmbed: () => resolved("Note", "本文"),
      onWikiLinkClick,
    });
    press(editButtonOf(v, "Note"));
    expect(onWikiLinkClick).not.toHaveBeenCalled();
  });

  it("ignores the button until the composition settles (IME invariant 1)", async () => {
    let transactions = 0;
    const doc = "![[image.png]]";
    const v = mount(doc, { extensions: countTransactions(() => (transactions += 1)) });

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    press(editButtonOf(v, "image.png"));
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    press(editButtonOf(v, "image.png"));
    expect(transactions).toBe(0);

    await vi.waitFor(() => expect(isCompositionUnsettled(v)).toBe(false));
    press(editButtonOf(v, "image.png"));
    expect(v.state.selection.main.head).toBe(doc.indexOf("]]"));
  });

  /**
   * 記法の範囲を DOM 生成時に固定した文字列（`widgetSources`）で
   * 覚えるのではなく、押した時点の state と DOM から都度求め直すことを固定する。
   * `resolvePageEmbed` は本来の contract どおり、内容が変わらない同じ target には同じ
   * オブジェクトを返す（PageEmbedResolver のドキュメント参照）。そうしないと
   * `PageEmbedWidget.eq` が常に false になり、widget の使い回し自体が起きない。
   */
  function memoizingResolver(text = "本文"): (target: string) => PageEmbedContent {
    const cache = new Map<string, PageEmbedContent>();
    return (target) => {
      let content = cache.get(target);
      if (!content) {
        content = resolved(target, text);
        cache.set(target, content);
      }
      return content;
    };
  }

  it("lands right before ]] after an alias is added while the widget is reused", async () => {
    const doc = "前 ![[Note]] 後";
    const v = mount(doc, { resolvePageEmbed: memoizingResolver() });
    const button = editButtonOf(v, "Note");
    expect(button).not.toBeNull();

    // alias を足しても target、content、page は変わらないので widget（DOM）は eq で使い回される。
    // ボタンの closure が持つ widget もこの同じインスタンスのまま。
    v.dispatch({ changes: { from: doc.indexOf("]]"), insert: "|別名" } });
    expect(editButtonOf(v, "Note")).toBe(button);
    // 記法の書き換えた場所から離れた位置へカーソルを戻し、source を隠したまま押す
    // （出している間の分岐は別のテストで確かめる）
    v.dispatch({ selection: EditorSelection.cursor(0) });
    const newDoc = v.state.doc.toString();
    expect(newDoc).toBe("前 ![[Note|別名]] 後");

    press(editButtonOf(v, "Note"));

    expect(v.state.selection.main.head).toBe(newDoc.indexOf("]]"));
    // focus による組み直しは CodeMirror 側で 10ms 遅らせている（updateForFocusChange）
    await vi.waitFor(() => expect(sourceOf(v)?.textContent).toBe("![[Note|別名]]"));
  });

  it("does not throw for an embed at the very start of the doc", () => {
    const doc = "![[image.png]]";
    const v = mount(doc);
    expect(() => press(editButtonOf(v, "image.png"))).not.toThrow();
    expect(v.state.selection.main.head).toBe(doc.indexOf("]]"));
  });

  it("lands right before the first embed's ]], not the adjacent second one's, when two identical embeds sit next to each other", () => {
    const doc = "![[a.png]]![[a.png]]";
    const v = mount(doc);
    // 最初の embed の中にカーソルを置いて source を出す。2 番目は記法が隣接していても
    // selection と交差しないので隠れたまま
    placeCursor(v, doc.indexOf("a.png"));
    expect(sourceOf(v)?.textContent).toBe("![[a.png]]");

    // querySelector は最初に一致した embed（＝出している方）のボタンを返す
    press(editButtonOf(v, "a.png"));

    expect(v.state.selection.main.head).toBe(doc.indexOf("]]"));
  });

  it("reveals the source when the button is pressed", async () => {
    const doc = "前 ![[Note]] 後";
    const v = mount(doc, { resolvePageEmbed: memoizingResolver() });
    expect(sourceOf(v)).toBeNull();

    // dispatch を先に、focus を後にする（reveal は focusChanged での組み直しに乗る）
    v.dispatch({ changes: { from: doc.indexOf("]]"), insert: "|別名" } });
    v.dispatch({ selection: EditorSelection.cursor(0) });
    expect(sourceOf(v)).toBeNull();

    press(editButtonOf(v, "Note"));

    expect(v.hasFocus).toBe(true);
    // focus による組み直しは CodeMirror 側で 10ms 遅らせている（updateForFocusChange）
    await vi.waitFor(() => expect(sourceOf(v)?.textContent).toBe("![[Note|別名]]"));
  });

  /**
   * 再発防止: resolved なページ embed だけ appendEditButton へ widget の
   * root（wrapper）でなくタイトル行（titleRow）を渡していた。titleRow は常に wrapper の
   * 最初の子（wrapper.append(titleRow, body)）なので previousElementSibling が常に null になり、
   * source を出している間も「隠している」分岐に落ちて posAtDOM の値（reveal 中は記法の終わり）を
   * 記法の先頭として syntaxTree を引き直してしまっていた。
   */
  it("lands right before ]] for a resolved page embed whose source is shown inline", () => {
    const doc = "前 ![[Note]] 後";
    const v = mount(doc, { resolvePageEmbed: () => resolved("Note", "本文") });
    placeCursor(v, doc.indexOf("Note"));
    expect(sourceOf(v)?.textContent).toBe("![[Note]]");

    press(editButtonOf(v, "Note"));

    expect(v.state.selection.main.head).toBe(doc.indexOf("]]"));
  });

  it("lands right before the resolved page embed's own ]], not the adjacent embed's, when its source is shown as an overlay", () => {
    const doc = "![[Note]]![[a.png]]";
    const v = mount(doc, { resolvePageEmbed: () => resolved("Note", "本文") });
    placeCursor(v, doc.indexOf("Note"));
    expect(sourceOf(v)?.textContent).toBe("![[Note]]");

    press(editButtonOf(v, "Note"));

    expect(v.state.selection.main.head).toBe(doc.indexOf("]]"));
  });
});
