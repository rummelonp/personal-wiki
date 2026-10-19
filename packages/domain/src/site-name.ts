/** サイト名の既定。deploy.env の SITE_NAME が無いときに web と Worker が使う。 */
export const DEFAULT_SITE_NAME = "personal-wiki";

/** サイト名の長さの上限。サロゲートペアを 1 字と数える（code point 単位）。 */
export const SITE_NAME_MAX_CHARS = 40;

/**
 * サイトの説明文（deploy.env の SITE_DESCRIPTION）の長さの上限。数え方はサイト名と同じ。
 * llms.txt の blockquote に置く 1〜2 文の概要に足りる長さにし、ページの一覧より前に長い文章を置かせない。
 */
export const SITE_DESCRIPTION_MAX_CHARS = 200;

/*
 * サイト名と説明文に混ぜない文字。HTML の title、MCP の表示名、OAuth の画面、llms.txt の blockquote に
 * 1 行で出すので、制御文字（Cc）、行区切りと段落区切り（U+2028、U+2029）、書式文字（Cf。RTL override
 * などの向きを変える文字を含む）を拒む。書式文字のうち U+200C と U+200D は、絵文字の結合や
 * ペルシア語の分かち書きに要るので通す。タグ文字（Cf）で組む地域の旗は通らない。
 * ただし U+200C と U+200D は何も描かないので、これらと空白だけの名前は空の名前と同じく拒む（VISIBLE_CHAR）。
 * deploy.env の検査（apps/worker/scripts/deploy-config.mjs）は同じ規則を .mjs に写しており、
 * 両者が食い違わないことを apps/worker/scripts/deploy-config.test.ts が確かめる。
 */
const FORBIDDEN_CHAR = /[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200c\u200d])\p{Cf}/u;

const VISIBLE_CHAR = /[^\s\u200c\u200d]/u;

function isValidSiteText(text: string, maxChars: number): boolean {
  return VISIBLE_CHAR.test(text) && [...text].length <= maxChars && !FORBIDDEN_CHAR.test(text);
}

/** 前後の空白を除いた名前が、上限と使える文字の規則を満たすか。見える文字が 1 字も無い名前は満たさない。 */
export function isValidSiteName(name: string): boolean {
  return isValidSiteText(name, SITE_NAME_MAX_CHARS);
}

/** 前後の空白を除いた説明文が、上限と使える文字（サイト名と同じ規則）を満たすか。 */
export function isValidSiteDescription(description: string): boolean {
  return isValidSiteText(description, SITE_DESCRIPTION_MAX_CHARS);
}
