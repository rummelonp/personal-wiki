/**
 * 添付（R2 に置く画像）の規則。Worker の保存と配信、web の貼り付けが同じ規則を見る。
 *
 * 受ける形式に svg を入れないのは意図による。svg を直接開くと同一オリジンでスクリプトが動く。
 * `@personal-wiki/markdown` の `IMAGE_EXTENSIONS` に svg があるのは Obsidian の表示側の都合で、
 * 保存してよい形式とは別の集合である。表示側に揃えて足さない。
 */

/** 添付の content type と拡張子の対応。名前の拡張子と保存する content type はこの表で決める。 */
const EXTENSION_BY_TYPE = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
} as const;

export type AttachmentContentType = keyof typeof EXTENSION_BY_TYPE;
export type AttachmentExtension = (typeof EXTENSION_BY_TYPE)[AttachmentContentType];

const TYPE_BY_EXTENSION: Readonly<Record<AttachmentExtension, AttachmentContentType>> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

export const ATTACHMENT_CONTENT_TYPES: readonly AttachmentContentType[] = Object.keys(
  EXTENSION_BY_TYPE,
) as AttachmentContentType[];

/** 添付 1 件の上限（バイト）。 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** 乱数 22 文字（base64url、128 ビット分）と拡張子。拡張子は小文字だけで、大文字は別の名前として受けない。 */
const ATTACHMENT_NAME_PATTERN = /^[A-Za-z0-9_-]{22}\.(png|jpg|gif|webp|avif)$/;

export function isAttachmentName(name: string): boolean {
  return ATTACHMENT_NAME_PATTERN.test(name);
}

/**
 * 申告された content type から拡張子を引く。受けない type は null。
 * type は小文字でパラメータ（`; charset=` など）を含まない前提で、ここでは正規化しない。
 * `Content-Type` ヘッダーの値は呼び出し側（Worker）が整えてから渡す。
 */
export function attachmentExtensionForType(type: string): AttachmentExtension | null {
  return Object.hasOwn(EXTENSION_BY_TYPE, type)
    ? EXTENSION_BY_TYPE[type as AttachmentContentType]
    : null;
}

/** 添付の名前から配信する content type を引く。名前の形が合わなければ null。 */
export function attachmentTypeForName(name: string): AttachmentContentType | null {
  if (!isAttachmentName(name)) return null;
  return TYPE_BY_EXTENSION[name.slice(name.lastIndexOf(".") + 1) as AttachmentExtension];
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

const AVIF_BRANDS = [ascii("avif"), ascii("avis")];

/**
 * brand を探す範囲の上限（バイト）。ftyp box の大きさは入力が決めるので、0 や巨大な値でも
 * 10 MiB の入力全体を走査しないよう、先頭のここまでで打ち切る。実在する ftyp は数十バイトで収まる。
 */
export const AVIF_BRAND_SEARCH_LIMIT = 4096;

/**
 * ISO BMFF の ftyp box が avif / avis を major brand か compatible brand に持つか。
 * box の先頭 4 バイトが大きさ、その後に "ftyp"、major brand（4）、minor version（4）、
 * compatible brand が 4 バイトずつ続く。minor version は brand ではないので見ない。
 * 渡された bytes が box の途中で切れていれば、読めた範囲で見る。
 */
function matchesAvif(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, ascii("ftyp"), 4)) return false;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const end = Math.min(size === 0 ? bytes.length : size, bytes.length, AVIF_BRAND_SEARCH_LIMIT);
  const isBrand = (offset: number) => AVIF_BRANDS.some((brand) => startsWith(bytes, brand, offset));
  if (end >= 12 && isBrand(8)) return true;
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    if (isBrand(offset)) return true;
  }
  return false;
}

/**
 * 申告された content type と、先頭の bytes（magic bytes）が合うか。
 * 拡張子や申告だけを信じると、別の形式や HTML を画像として保存して配信してしまう。
 *
 * 見るのは先頭の bytes だけで、全体を渡してもよい（avif は先頭 `AVIF_BRAND_SEARCH_LIMIT` バイトまで）。
 * type は小文字でパラメータを含まない前提で、ここでは正規化しない。
 */
export function matchesAttachmentMagic(type: string, bytes: Uint8Array): boolean {
  switch (type) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"));
    case "image/webp":
      return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);
    case "image/avif":
      return matchesAvif(bytes);
    default:
      return false;
  }
}
