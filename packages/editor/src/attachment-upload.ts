import { type EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { docReplacement } from "./replace-doc";
import { dispatchWhenSettled } from "./settled-dispatch";

export interface UploadedAttachment {
  readonly filename: string;
}

/**
 * 失敗（reject）すると placeholder を黙って取り除く。利用者に知らせたいときは、`upload` の中で
 * 通知してから投げ直す。
 */
export type UploadAttachment = (file: File) => Promise<UploadedAttachment>;

/** アップロード先が受け付ける File か。アップロード先の規則を知る呼び出し側が決める */
export type AcceptAttachment = (file: File) => boolean;

export interface AttachmentUploadOptions {
  /**
   * 既定は `image/*` の緩い事前フィルタ。受け付ける File を 1 つも含まないイベントは既定の貼り付け/drop に
   * 委ねる。含むイベントでは、受け付けない File を捨てて残りをアップロードする。
   */
  readonly accept?: AcceptAttachment;
}

const acceptImage: AcceptAttachment = (file) => file.type.startsWith("image/");

function extractFiles(dataTransfer: DataTransfer | null, accept: AcceptAttachment): File[] {
  if (!dataTransfer) return [];
  return Array.from(dataTransfer.files).filter(accept);
}

let uploadSeq = 0;

/** アップロードごとの識別子。仮の記法の名前に入れ、完了時に doc から探す手がかりにする。 */
export function newUploadToken(): string {
  return `${Date.now()}-${uploadSeq++}`;
}

/**
 * アップロード中を示す一時的な記法の embed の target。
 * アップロード中も自動保存は走るので、拡張子の無い `![[Uploading:…]]` はページ embed として
 * links に偽の title を入れてしまう。画像の拡張子を付けると添付の embed に分類されて links には
 * 入らない。拡張子の前に `.` を入れるのは、サーバーが振る名前（base64url の 22 文字と拡張子）の
 * 文字クラスに無い文字を含め、長さに頼らず添付の参照にもならないようにするため。
 */
export function placeholderTarget(token: string): string {
  return `uploading.${token}.png`;
}

const PLACEHOLDER_TARGET = /^uploading\.(\d+-\d+)\.png$/;

/** `placeholderTarget` が作る形の target から token を取り出す。その形でなければ null。 */
export function uploadTokenOf(target: string): string | null {
  return PLACEHOLDER_TARGET.exec(target)?.[1] ?? null;
}

function placeholderText(token: string): string {
  return `![[${placeholderTarget(token)}]]`;
}

const startUpload = StateEffect.define<string>();
const finishUpload = StateEffect.define<string>();

/**
 * この view で進行中のアップロードの token。仮の記法の名前だけでは、途中で閉じて本文に残ったものや
 * 別の端末から届いたものを、進行中のものと見分けられない。state に持つので、開き直した view は空から
 * 始まり、残った仮の記法は未解決の画像として描かれる。
 */
const uploadingTokens = StateField.define<ReadonlySet<string>>({
  create: () => new Set(),
  update(tokens, transaction) {
    let next: Set<string> | null = null;
    for (const effect of transaction.effects) {
      if (effect.is(startUpload)) {
        next ??= new Set(tokens);
        next.add(effect.value);
      } else if (effect.is(finishUpload)) {
        next ??= new Set(tokens);
        next.delete(effect.value);
      }
    }
    return next ?? tokens;
  },
});

/** `target` が、この state でアップロード中の仮の記法か。 */
export function isUploadingTarget(state: EditorState, target: string): boolean {
  const token = uploadTokenOf(target);
  return token !== null && (state.field(uploadingTokens, false)?.has(token) ?? false);
}

/**
 * 進行中のアップロードの集合が、この update で変わったか。完了は、仮の記法が書き換わって doc から
 * 探せないと doc を変えない transaction になるので、「添付中」の描き直しを doc の変化に頼れない。
 */
export function uploadsChanged(update: ViewUpdate): boolean {
  return (
    update.startState.field(uploadingTokens, false) !== update.state.field(uploadingTokens, false)
  );
}

function insertPlaceholder(view: EditorView, pos: number, token: string): number {
  const text = placeholderText(token);
  view.dispatch({
    changes: { from: pos, to: pos, insert: text },
    selection: { anchor: pos + text.length },
    effects: startUpload.of(token),
  });
  return text.length;
}

/**
 * アップロード完了時、挿入した placeholder を doc 内で検索して置き換える。CodeMirror の
 * 変更に対する位置追跡（RangeSet.map 等）を使わないのは、非同期待ちの間の任意の編集を
 * 気にせず済むため。編集で placeholder 自体が消えていれば何もしない（元に戻す操作等）。
 *
 * 完了は非同期の callback から来るので、変換が落ち着くまで待つ（IME 不変条件 1）。
 * 保留は key ごとに最後の 1 件だけなので、同時のアップロードが互いを潰さないよう
 * アップロードごとの Symbol を key にする。検索は dispatch の直前に行う。
 */
function resolvePlaceholder(
  view: EditorView,
  key: symbol,
  token: string,
  replacement: string,
): void {
  dispatchWhenSettled(view, key, () => {
    const text = placeholderText(token);
    const index = view.state.doc.toString().indexOf(text);
    // 編集で消えていても、token は進行中から外す（元に戻す操作で仮の記法が戻ったときに「添付中」と出さない）
    const effects = finishUpload.of(token);
    if (index === -1) {
      view.dispatch({ effects });
      return;
    }
    view.dispatch({
      changes: { from: index, to: index + text.length, insert: replacement },
      effects,
    });
  });
}

function uploadFiles(view: EditorView, pos: number, files: File[], upload: UploadAttachment): void {
  let insertPos = pos;
  for (const file of files) {
    const token = newUploadToken();
    const key = Symbol(token);
    insertPos += insertPlaceholder(view, insertPos, token);
    upload(file).then(
      (result) => resolvePlaceholder(view, key, token, `![[${result.filename}]]`),
      () => resolvePlaceholder(view, key, token, ""),
    );
  }
}

/**
 * クリップボード貼り付け / ドラッグ&ドロップで画像ファイルを受け取り、`upload`
 * の完了後にカーソル位置へ `![[filename]]` を挿入する。
 * 受け付ける File を含まないイベントは処理せず、既定の貼り付け/drop に委ねる。
 *
 * placeholder の挿入は paste/drop の handler の中で同期に dispatch する。ユーザー操作の最中の
 * 編集で、通常の入力と同じ経路なので、変換を待たない。
 */
export function attachmentUpload(
  upload: UploadAttachment,
  options: AttachmentUploadOptions = {},
): Extension {
  const accept = options.accept ?? acceptImage;
  return [
    // 完了時の置換に要る。createEditor の view は持っているが、単独で使っても投げないようにする。
    // 同じ extension の重複は CodeMirror が 1 つにまとめる。
    docReplacement,
    uploadingTokens,
    EditorView.domEventHandlers({
      paste(event, view) {
        // domEventHandlers は CodeMirror 自身の builtin handler（`readOnly` を見る）より先に
        // 走るので、ここで見ないと読み取り専用でもアップロードが進んでしまう。
        if (view.state.readOnly) return false;
        const files = extractFiles(event.clipboardData, accept);
        if (files.length === 0) return false;
        uploadFiles(view, view.state.selection.main.head, files, upload);
        return true;
      },
      drop(event, view) {
        if (view.state.readOnly) return false;
        const files = extractFiles(event.dataTransfer, accept);
        if (files.length === 0) return false;
        const pos =
          view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
          view.state.selection.main.head;
        uploadFiles(view, pos, files, upload);
        return true;
      },
    }),
  ];
}
