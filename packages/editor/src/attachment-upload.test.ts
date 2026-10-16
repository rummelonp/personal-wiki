import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { extractDerived, extractWikiLinks, isAttachmentTarget } from "@personal-wiki/markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachmentUpload,
  isUploadingTarget,
  newUploadToken,
  placeholderTarget,
  type UploadAttachment,
  uploadTokenOf,
} from "./attachment-upload";
import { type CreateEditorOptions, createEditor } from "./create-editor";

/** サーバーが振る添付の名前（packages/domain の規則と同じ形） */
const SERVER_ATTACHMENT_NAME = /^[A-Za-z0-9_-]{22}\.(png|jpg|gif|webp|avif)$/;

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(upload: UploadAttachment, doc = "", readOnly = false): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, { doc, readOnly, extensions: attachmentUpload(upload) });
  return view;
}

function mountWithOptions(options: CreateEditorOptions): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, options);
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

function imageFile(name = "photo.png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

function dataTransferWithFiles(files: File[]): DataTransfer {
  const dataTransfer = new DataTransfer();
  for (const file of files) dataTransfer.items.add(file);
  return dataTransfer;
}

function dispatchPaste(v: EditorView, dataTransfer: DataTransfer) {
  v.contentDOM.dispatchEvent(
    new ClipboardEvent("paste", { bubbles: false, cancelable: true, clipboardData: dataTransfer }),
  );
}

function dispatchDrop(v: EditorView, dataTransfer: DataTransfer) {
  v.contentDOM.dispatchEvent(
    new DragEvent("drop", {
      bubbles: false,
      cancelable: true,
      clientX: 0,
      clientY: 0,
      dataTransfer,
    }),
  );
}

describe("attachmentUpload", () => {
  it("inserts ![[filename]] at the cursor once a pasted image finishes uploading", async () => {
    const upload = vi.fn(async (file: File) => ({ filename: file.name }));
    const v = mount(upload, "前 後");
    v.dispatch({ selection: { anchor: 1 } });

    dispatchPaste(v, dataTransferWithFiles([imageFile("cat.png")]));

    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("前![[cat.png]] 後"));
    expect(upload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "cat.png" }));
  });

  it("inserts ![[filename]] at the drop position once a dropped image finishes uploading", async () => {
    const upload = vi.fn(async (file: File) => ({ filename: file.name }));
    const v = mount(upload, "abc");

    dispatchDrop(v, dataTransferWithFiles([imageFile("dropped.png")]));

    await vi.waitFor(() => expect(v.state.doc.toString()).toContain("![[dropped.png]]"));
  });

  it("does not call upload for a plain text paste", () => {
    const upload = vi.fn();
    const v = mount(upload);
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", "hello");

    dispatchPaste(v, dataTransfer);

    expect(upload).not.toHaveBeenCalled();
  });

  it("filters out non-image files, leaving only images uploaded", async () => {
    const upload = vi.fn(async (file: File) => ({ filename: file.name }));
    const v = mount(upload, "");
    const textFile = new File(["hi"], "note.txt", { type: "text/plain" });

    dispatchPaste(v, dataTransferWithFiles([textFile, imageFile("kept.png")]));

    await vi.waitFor(() => expect(v.state.doc.toString()).toContain("![[kept.png]]"));
    expect(upload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "kept.png" }));
  });

  it("removes the placeholder without inserting anything when upload fails", async () => {
    const upload = vi.fn(async () => {
      throw new Error("network error");
    });
    const v = mount(upload, "前 後");
    v.dispatch({ selection: { anchor: 2 } });

    dispatchPaste(v, dataTransferWithFiles([imageFile("cat.png")]));

    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("前 後"));
  });

  // domEventHandlers は builtin の paste/drop（readOnly を見る）より先に走るので、
  // ここで見ないと読み取り専用でも placeholder の挿入とアップロードが進んでしまう
  it("does not upload a pasted image when the view is read-only", () => {
    const upload = vi.fn();
    const v = mount(upload, "前 後", true);
    v.dispatch({ selection: { anchor: 1 } });

    dispatchPaste(v, dataTransferWithFiles([imageFile("cat.png")]));

    expect(upload).not.toHaveBeenCalled();
    expect(v.state.doc.toString()).toBe("前 後");
  });

  it("does not upload a dropped image when the view is read-only", () => {
    const upload = vi.fn();
    const v = mount(upload, "abc", true);

    dispatchDrop(v, dataTransferWithFiles([imageFile("dropped.png")]));

    expect(upload).not.toHaveBeenCalled();
    expect(v.state.doc.toString()).toBe("abc");
  });

  it("replaces every placeholder when several uploads finish in reverse order", async () => {
    const finishers: ((filename: string) => void)[] = [];
    const upload: UploadAttachment = () =>
      new Promise((resolve) => finishers.push((filename) => resolve({ filename })));
    const v = mount(upload, "");

    dispatchPaste(v, dataTransferWithFiles([imageFile("a.png"), imageFile("b.png")]));
    expect(finishers).toHaveLength(2);
    finishers[1]?.("SECOND.png");
    finishers[0]?.("FIRST.png");

    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("![[FIRST.png]]![[SECOND.png]]"));
  });

  // 自動保存はアップロード中の本文も保存する。サーバーは拡張子の無い embed を page の参照として
  // links に入れ、添付の参照は 22 文字の base64url の名前だけを受け付ける
  it("writes a placeholder that is neither a page link nor an attachment name", () => {
    const upload: UploadAttachment = () => new Promise(() => {});
    const v = mount(upload, "");

    dispatchPaste(v, dataTransferWithFiles([imageFile("a.png"), imageFile("b.png")]));

    const body = v.state.doc.toString();
    expect(extractDerived(body).links).toEqual([]);
    const embeds = extractWikiLinks(body).filter((ref) => ref.isEmbed);
    expect(embeds).toHaveLength(2);
    for (const ref of embeds) {
      expect(isAttachmentTarget(ref.target)).toBe(true);
      expect(ref.target).not.toMatch(SERVER_ATTACHMENT_NAME);
    }
    // D1 の添付の参照になるのは、サーバーの名前の規則に合うものだけ
    const { attachments } = extractDerived(body);
    expect(attachments).toHaveLength(2);
    expect(attachments.filter((name) => SERVER_ATTACHMENT_NAME.test(name))).toEqual([]);
  });

  it("renders the placeholder as a progress label without the file name or the edit button", () => {
    const upload: UploadAttachment = () => new Promise(() => {});
    const resolveAttachmentUrl = vi.fn(() => "data:image/png;base64,AAAA");
    const v = mountWithOptions({ onUploadAttachment: upload, resolveAttachmentUrl });

    dispatchPaste(v, dataTransferWithFiles([imageFile("a.png")]));
    v.dispatch({ selection: { anchor: 0 } });

    const embed = v.contentDOM.querySelector<HTMLElement>(".cm-embed-image");
    expect(embed?.textContent).toBe("画像を添付中…");
    expect(embed?.querySelector("img, .cm-embed-unresolved, .cm-embed-edit")).toBeNull();
    expect(resolveAttachmentUrl).not.toHaveBeenCalled();
  });

  it("keeps the placeholder text in the document while the label is shown", () => {
    const upload: UploadAttachment = () => new Promise(() => {});
    const v = mountWithOptions({ onUploadAttachment: upload, resolveAttachmentUrl: () => null });

    dispatchPaste(v, dataTransferWithFiles([imageFile("a.png")]));
    v.dispatch({ selection: { anchor: 0 } });

    expect(v.state.doc.toString()).toMatch(/^!\[\[uploading\.\d+-\d+\.png\]\]$/);
  });

  it("shows the placeholder as source again when the cursor returns to it", () => {
    const upload: UploadAttachment = () => new Promise(() => {});
    const v = mountWithOptions({ onUploadAttachment: upload, resolveAttachmentUrl: () => null });
    dispatchPaste(v, dataTransferWithFiles([imageFile("a.png")]));
    v.dispatch({ selection: { anchor: 0 } });

    v.focus();
    v.dispatch({ selection: { anchor: v.state.doc.length } });

    expect(v.contentDOM.querySelector(".cm-embed-source")?.textContent).toBe(
      v.state.doc.toString(),
    );
  });

  it("draws an embed whose name only resembles the placeholder as a normal image", () => {
    const v = mountWithOptions({
      doc: "![[uploading.draft.png]]",
      resolveAttachmentUrl: () => null,
    });

    const embed = v.contentDOM.querySelector<HTMLElement>(".cm-embed-image");
    expect(embed?.querySelector(".cm-embed-unresolved")?.textContent).toBe("uploading.draft.png");
    expect(embed?.textContent).not.toContain("画像を添付中…");
  });

  it("draws a leftover placeholder that no upload in this view owns as an unresolved image", () => {
    const target = placeholderTarget(newUploadToken());
    const v = mountWithOptions({ doc: `![[${target}]]`, resolveAttachmentUrl: () => null });
    v.dispatch({ selection: { anchor: 0 } });

    const embed = v.contentDOM.querySelector<HTMLElement>(".cm-embed-image");
    expect(embed?.querySelector(".cm-embed-unresolved")?.textContent).toBe(target);
    expect(embed?.querySelector(".cm-embed-edit")).not.toBeNull();
    expect(embed?.textContent).not.toContain("画像を添付中…");
  });

  it("stops treating the token as uploading once the upload succeeds", async () => {
    let finish: (filename: string) => void = () => {};
    const upload: UploadAttachment = () =>
      new Promise((resolve) => {
        finish = (filename) => resolve({ filename });
      });
    const v = mount(upload, "");
    dispatchPaste(v, dataTransferWithFiles([imageFile("a.png")]));
    const target = /!\[\[(.+)\]\]/.exec(v.state.doc.toString())?.[1] ?? "";
    expect(isUploadingTarget(v.state, target)).toBe(true);

    finish("DONE.png");

    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("![[DONE.png]]"));
    expect(isUploadingTarget(v.state, target)).toBe(false);
  });

  it("stops treating the token as uploading once the upload fails, even if undo brings the placeholder back", async () => {
    let fail: () => void = () => {};
    const upload: UploadAttachment = () =>
      new Promise((_resolve, reject) => {
        fail = () => reject(new Error("failed"));
      });
    const v = mountWithOptions({ onUploadAttachment: upload, resolveAttachmentUrl: () => null });
    dispatchPaste(v, dataTransferWithFiles([imageFile("a.png")]));
    const placeholder = v.state.doc.toString();
    const target = /!\[\[(.+)\]\]/.exec(placeholder)?.[1] ?? "";

    fail();

    await vi.waitFor(() => expect(v.state.doc.toString()).toBe(""));
    expect(isUploadingTarget(v.state, target)).toBe(false);
    v.dispatch({ changes: { from: 0, insert: placeholder }, selection: { anchor: 0 } });
    const embed = v.contentDOM.querySelector<HTMLElement>(".cm-embed-image");
    expect(embed?.textContent).not.toContain("画像を添付中…");
  });

  it("stops treating the token as uploading when the user removed the placeholder before it finished", async () => {
    let finish: (filename: string) => void = () => {};
    const upload: UploadAttachment = () =>
      new Promise((resolve) => {
        finish = (filename) => resolve({ filename });
      });
    const v = mount(upload, "");
    dispatchPaste(v, dataTransferWithFiles([imageFile("a.png")]));
    const target = /!\[\[(.+)\]\]/.exec(v.state.doc.toString())?.[1] ?? "";
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "" } });

    finish("DONE.png");

    await vi.waitFor(() => expect(isUploadingTarget(v.state, target)).toBe(false));
    expect(v.state.doc.toString()).toBe("");
  });

  // 判定の形を変えずに生成だけ変える（またはその逆）と、実際のアップロードが「添付中」と描かれなくなる
  it("recognises every target that placeholderTarget builds from a generated token", () => {
    for (let i = 0; i < 3; i += 1) {
      const token = newUploadToken();
      expect(uploadTokenOf(placeholderTarget(token))).toBe(token);
    }
    expect(uploadTokenOf("uploading.draft.png")).toBeNull();
  });

  // 保留した action の中で placeholder を探す（IME 不変条件 1 の保留の間に位置が動く）
  it("finds the placeholder when the upload finishes, not when it was held", async () => {
    let finish: (filename: string) => void = () => {};
    const upload: UploadAttachment = () =>
      new Promise((resolve) => {
        finish = (filename) => resolve({ filename });
      });
    const v = mount(upload, "前");
    v.dispatch({ selection: { anchor: 1 } });
    dispatchPaste(v, dataTransferWithFiles([imageFile("a.png")]));
    v.dispatch({ selection: { anchor: 0 } });

    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    finish("FINISHED.png");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(v.state.doc.toString()).toMatch(/^前!\[\[uploading\./);
    v.dispatch({ changes: { from: 0, insert: "愛" } });
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));

    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("愛前![[FINISHED.png]]"));
  });

  it("replaces the placeholder in a view that has only this extension", async () => {
    const upload = vi.fn(async (file: File) => ({ filename: file.name }));
    host = document.createElement("div");
    document.body.append(host);
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: "", extensions: attachmentUpload(upload) }),
    });

    dispatchPaste(view, dataTransferWithFiles([imageFile("solo.png")]));

    await vi.waitFor(() => expect(view?.state.doc.toString()).toBe("![[solo.png]]"));
  });

  it("accepts every image/* file by default and lets the host narrow it", async () => {
    const upload = vi.fn(async (file: File) => ({ filename: file.name }));
    const v = mountWithOptions({
      onUploadAttachment: upload,
      acceptAttachment: (file) => file.type === "image/png" || file.type === "image/webp",
    });
    const svg = new File(["<svg/>"], "vector.svg", { type: "image/svg+xml" });
    const webp = new File([new Uint8Array([1])], "kept.webp", { type: "image/webp" });

    dispatchPaste(v, dataTransferWithFiles([svg, webp]));

    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("![[kept.webp]]"));
    expect(upload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "kept.webp" }));
  });

  it("leaves the paste to the default handler when the host accepts none of the files", () => {
    const upload = vi.fn();
    const v = mountWithOptions({ onUploadAttachment: upload, acceptAttachment: () => false });

    const event = new ClipboardEvent("paste", {
      cancelable: true,
      clipboardData: dataTransferWithFiles([imageFile("a.png")]),
    });
    v.contentDOM.dispatchEvent(event);

    expect(upload).not.toHaveBeenCalled();
    expect(v.state.doc.toString()).toBe("");
  });
});
