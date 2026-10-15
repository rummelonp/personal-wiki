import { type AttachmentContentType, attachmentExtensionForType } from "@personal-wiki/domain";

/** `Content-Type` の値から、パラメータ（`; charset=` など）を落として小文字にした media type を返す。 */
export function mediaTypeOf(header: string | undefined): string | undefined {
  return header?.split(";")[0]?.trim().toLowerCase();
}

/**
 * アップロードの `Content-Type` を、受け付ける添付の content type にする。受けない type は null。
 * domain の関数は正規化しない契約なので、ここで小文字にしてパラメータを落とす。CSRF の検査
 * （auth/middleware.ts）と保存のハンドラが同じ判定を使う。
 */
export function uploadContentTypeOf(header: string | undefined): AttachmentContentType | null {
  const type = mediaTypeOf(header);
  if (type === undefined || attachmentExtensionForType(type) === null) return null;
  return type as AttachmentContentType;
}
