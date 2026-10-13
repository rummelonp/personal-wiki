import { isBlockReferenceHeading } from "./heading-section";
import type { WikiLinkParts } from "./wikilink";

/**
 * embed（`![[...]]`）の展開方法の種類。
 * target の拡張子だけで決める Obsidian の解釈に合わせ、添付の実在や content_type、page の実在は
 * 見ない（それは表示時の解決の責務で、未解決は表示側が扱う）。
 * `page` は拡張子で添付と分からない target を page の title として展開するもの（ページ embed）。
 */
export type EmbedKind = "image" | "video" | "page";

/** 添付を展開する種類。拡張子だけで決まる。 */
export type MediaEmbedKind = Exclude<EmbedKind, "page">;

/** Obsidian が画像として展開する拡張子（小文字）。 */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "avif",
  "bmp",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

/** Obsidian が動画として展開する拡張子（小文字）。 */
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(["mkv", "mov", "mp4", "ogv", "webm"]);

/**
 * Obsidian が添付として埋め込むが、展開方法を持たない拡張子（PDF と音声）。
 * page の title とは読まず、WikiLink として表示する。page として引くと、実在する添付が
 * 「無い page」の見た目になる。
 */
const OTHER_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "3gp",
  "flac",
  "m4a",
  "mp3",
  "ogg",
  "pdf",
  "wav",
]);

function extensionOf(target: string): string | null {
  const dot = target.lastIndexOf(".");
  return dot < 0 ? null : target.slice(dot + 1).toLowerCase();
}

/** embed の target を拡張子で添付の種類に分類する。添付と分からない target は null。 */
export function embedKindForTarget(target: string): MediaEmbedKind | null {
  const ext = extensionOf(target);
  if (ext === null) return null;
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}

/** embed の target が添付（画像・動画・PDF・音声）を指すか。page への参照ではない。 */
export function isAttachmentTarget(target: string): boolean {
  if (embedKindForTarget(target) !== null) return true;
  const ext = extensionOf(target);
  return ext !== null && OTHER_ATTACHMENT_EXTENSIONS.has(ext);
}

/**
 * embed を展開方法で分類する。展開方法を持たないもの（block を指す embed、PDF と音声）は
 * null で、呼び出し側は通常の WikiLink として扱う。
 * 見出しを指す embed（`![[Note#見出し]]`）は `page` で、見出しの範囲を切り出すのは表示側
 * （`extractHeadingSection`）である。block を指す embed（`![[Note^id]]`、`![[Note#^id]]`）は
 * block の範囲を切り出す手段が無く、page 全体を出すと書いた人の意図と違う内容になるので展開しない。
 */
export function embedKindOf(
  parts: Pick<WikiLinkParts, "target" | "heading" | "blockId">,
): EmbedKind | null {
  const media = embedKindForTarget(parts.target);
  if (media !== null) return media;
  if (parts.blockId !== null) return null;
  if (parts.heading !== null && isBlockReferenceHeading(parts.heading)) return null;
  const ext = extensionOf(parts.target);
  if (ext !== null && OTHER_ATTACHMENT_EXTENSIONS.has(ext)) return null;
  return "page";
}

/**
 * サイズ指定として受け付ける上限（px）。これを超える値は誤記とみなして無視する。
 * 上限が無いと `|99999999999999999999` が `1e+20` のような属性値になる。
 */
export const MAX_EMBED_DIMENSION = 10000;

const SIZE_PATTERN = /^(\d+)(?:x(\d+))?$/;

/**
 * 画像 embed の `|` より後ろ（`splitWikiLinkContent` の label）の解釈。
 *
 * - `size`：`300`（幅）または `300x200`（幅×高さ）
 * - `alt`：サイズの形をしていない label。Obsidian はこれを表示名（alt）として扱う
 * - `none`：label が無い、またはサイズの形をしているが 0 や上限超えで使えない値。
 *   サイズの形をした値を alt に回さないのは、Obsidian がそれをサイズ指定として読むため
 *   （書いた人の意図はサイズであり、誤記を alt として表示しても直す手掛かりにならない）
 */
export type ImageEmbedLabel =
  | { readonly kind: "size"; readonly width: number; readonly height: number | null }
  | { readonly kind: "alt"; readonly text: string }
  | { readonly kind: "none" };

export function parseImageEmbedLabel(label: string | null): ImageEmbedLabel {
  if (label === null) return { kind: "none" };
  const match = SIZE_PATTERN.exec(label);
  if (!match) return { kind: "alt", text: label };
  const width = toDimension(match[1]);
  const height = match[2] === undefined ? null : toDimension(match[2]);
  if (width === null || (match[2] !== undefined && height === null)) return { kind: "none" };
  return { kind: "size", width, height };
}

function toDimension(digits: string | undefined): number | null {
  const value = Number(digits);
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_EMBED_DIMENSION ? value : null;
}
