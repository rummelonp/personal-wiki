import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentUpload, type UploadAttachment } from "./attachment-upload";
import { createEditor } from "./create-editor";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(upload: UploadAttachment, doc = "", readOnly = false): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, { doc, readOnly, extensions: attachmentUpload(upload) });
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
});
