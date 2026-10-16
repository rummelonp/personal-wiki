import { DEFAULT_SITE_NAME } from "@personal-wiki/domain";

/**
 * 画面のブランドと document.title の末尾に出すサイト名。
 * 初回の描画から正しい名前を出すため、ビルド時に埋める（deploy.mjs が deploy.env の SITE_NAME を
 * VITE_SITE_NAME に渡す）。実行時に API で取ると、取得までの間に名前が入れ替わる。
 */
export const SITE_NAME: string = import.meta.env.VITE_SITE_NAME?.trim() || DEFAULT_SITE_NAME;
