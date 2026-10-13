import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  isAttachmentName,
} from "@personal-wiki/domain/attachment";
import type {
  AcceptAttachment,
  AttachmentUrlResolver,
  UploadAttachment,
} from "@personal-wiki/editor";
import { type UploadFailureKind, type UploadResult, uploadAttachment } from "./attachments-api";

/** 画面に出す添付の失敗。 */
export interface UploadNotice {
  kind: UploadFailureKind;
  message: string;
}

const MAX_MIB = ATTACHMENT_MAX_BYTES / (1024 * 1024);

function noticeFor(kind: UploadFailureKind, file: File): UploadNotice {
  const subject = file.name === "" ? "この画像" : `「${file.name}」`;
  switch (kind) {
    case "too_large":
      return {
        kind,
        message: `${subject}は大きすぎるため添付できません（上限は ${MAX_MIB} MiB です）。`,
      };
    case "unsupported_type":
      return {
        kind,
        message: `${subject}は添付できない形式です。PNG、JPEG、GIF、WebP、AVIF の画像だけ添付できます。`,
      };
    case "unauthorized":
      return {
        kind,
        message: `ログインの期限が切れたため、${subject}を添付できませんでした。ログインし直して、もう一度添付してください。`,
      };
    case "unavailable":
      return { kind, message: "この環境では添付を使えません。" };
    case "error":
      return {
        kind,
        message: `${subject}を添付できませんでした。通信を確かめて、もう一度添付してください。`,
      };
  }
}

/** アップロードできる種類か。サーバーも内容を検査するので、ここは事前の振り分け。 */
export const acceptAttachment: AcceptAttachment = (file) =>
  (ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(file.type);

export interface AttachmentUploaderOptions {
  /** 失敗を利用者に知らせる。上げる前に止めたとき（容量超過）も呼ぶ */
  notify: (notice: UploadNotice) => void;
  upload?: (file: File) => Promise<UploadResult>;
}

export interface AttachmentUploader {
  upload: UploadAttachment;
  /**
   * アップロード中は、ページを閉じる・再読み込みする前にブラウザの確認を出す。戻り値で外す。
   * アプリ内の遷移は止められない（遷移すると placeholder が本文に残り、上げた添付は参照されない）。
   */
  bindUnloadGuard: (win: EventTarget) => () => void;
}

/**
 * エディタの `onUploadAttachment` に渡す関数を作る。失敗はここで通知してから投げ直す。
 * エディタは reject で placeholder を黙って取り除くだけなので、理由を伝えるのはこちらの役目。
 */
export function createAttachmentUploader(options: AttachmentUploaderOptions): AttachmentUploader {
  const send = options.upload ?? ((file: File) => uploadAttachment(file));
  let pending = 0;

  const fail = (kind: UploadFailureKind, file: File): never => {
    options.notify(noticeFor(kind, file));
    throw new Error(`添付のアップロードに失敗した: ${kind}`);
  };

  return {
    async upload(file) {
      // サーバーも 413 を返すが、上限を超える本文を送り切る前に止める
      if (file.size > ATTACHMENT_MAX_BYTES) fail("too_large", file);
      pending += 1;
      try {
        const result = await send(file);
        if (!result.ok) return fail(result.kind, file);
        return { filename: result.value.name };
      } finally {
        pending -= 1;
      }
    },
    bindUnloadGuard(win) {
      const onBeforeUnload = (event: Event) => {
        if (pending > 0) event.preventDefault();
      };
      win.addEventListener("beforeunload", onBeforeUnload);
      return () => win.removeEventListener("beforeunload", onBeforeUnload);
    },
  };
}

/** ページ単位の配信 URL。匿名には、そのページの本文が参照している添付だけを Worker が返す。 */
export function attachmentUrl(pageId: string, name: string): string {
  return `/api/pages/${encodeURIComponent(pageId)}/attachments/${encodeURIComponent(name)}`;
}

export interface AttachmentUrlResolverOptions {
  /** `/api/me` の features.attachments。false の間は要求を出さない */
  enabled: boolean;
  /** この resolver を使うページの id */
  pageId: string;
  /** 入れ子の embed の埋め込み先（本文に書かれたままの title）の id。取得前と読めないページは null */
  embedPageId: (target: string) => string | null;
}

/**
 * `![[name]]` の画像の URL を返す。ページ本体の添付はこのページの id で、入れ子の embed の添付は
 * 埋め込み先の id で引く。サーバーが振る名前の形に合わないもの（アップロード中の placeholder を
 * 含む）は、404 になる要求を出さないよう null にする。
 */
export function createAttachmentUrlResolver(
  options: AttachmentUrlResolverOptions,
): AttachmentUrlResolver {
  return (filename, embedTarget) => {
    if (!options.enabled || !isAttachmentName(filename)) return null;
    const pageId = embedTarget === undefined ? options.pageId : options.embedPageId(embedTarget);
    return pageId === null ? null : attachmentUrl(pageId, filename);
  };
}
