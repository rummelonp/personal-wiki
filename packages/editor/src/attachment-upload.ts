import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export interface UploadedAttachment {
  readonly filename: string;
}

/**
 * 添付として受け付ける content type の正式な判定は、アップロード先の規則を知る呼び出し側に委ねる。
 * ここでは `image/*` の緩い事前フィルタだけ行い、実際の許可判定と実アップロードは `upload` が担う。
 */
export type UploadAttachment = (file: File) => Promise<UploadedAttachment>;

function extractImageFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return [];
  return Array.from(dataTransfer.files).filter((file) => file.type.startsWith("image/"));
}

let uploadSeq = 0;

/** アップロード中を示す一時的な記法。挿入位置の追跡に使うだけなので構文として解釈されなくてよい。 */
function placeholderText(token: string): string {
  return `![[Uploading:${token}]]`;
}

function insertPlaceholder(view: EditorView, pos: number, token: string): number {
  const text = placeholderText(token);
  view.dispatch({
    changes: { from: pos, to: pos, insert: text },
    selection: { anchor: pos + text.length },
  });
  return text.length;
}

/**
 * アップロード完了時、挿入した placeholder を doc 内で検索して置き換える。CodeMirror の
 * 変更に対する位置追跡（RangeSet.map 等）を使わないのは、非同期待ちの間の任意の編集を
 * 気にせず済むため。編集で placeholder 自体が消えていれば何もしない（元に戻す操作等）。
 */
function resolvePlaceholder(view: EditorView, token: string, replacement: string): void {
  const text = placeholderText(token);
  const index = view.state.doc.toString().indexOf(text);
  if (index === -1) return;
  view.dispatch({ changes: { from: index, to: index + text.length, insert: replacement } });
}

function uploadFiles(view: EditorView, pos: number, files: File[], upload: UploadAttachment): void {
  let insertPos = pos;
  for (const file of files) {
    const token = `${Date.now()}-${uploadSeq++}`;
    insertPos += insertPlaceholder(view, insertPos, token);
    upload(file)
      .then((result) => resolvePlaceholder(view, token, `![[${result.filename}]]`))
      .catch(() => resolvePlaceholder(view, token, ""));
  }
}

/**
 * クリップボード貼り付け / ドラッグ&ドロップで画像ファイルを受け取り、`upload`
 * の完了後にカーソル位置へ `![[filename]]` を挿入する。
 * 画像ファイルを含まないイベントは処理せず、既定の貼り付け/drop に委ねる。
 */
export function attachmentUpload(upload: UploadAttachment): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      // domEventHandlers は CodeMirror 自身の builtin handler（`readOnly` を見る）より先に
      // 走るので、ここで見ないと読み取り専用でもアップロードが進んでしまう。
      if (view.state.readOnly) return false;
      const files = extractImageFiles(event.clipboardData);
      if (files.length === 0) return false;
      uploadFiles(view, view.state.selection.main.head, files, upload);
      return true;
    },
    drop(event, view) {
      if (view.state.readOnly) return false;
      const files = extractImageFiles(event.dataTransfer);
      if (files.length === 0) return false;
      const pos =
        view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      uploadFiles(view, pos, files, upload);
      return true;
    },
  });
}
