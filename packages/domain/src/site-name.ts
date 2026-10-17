/** サイト名の既定。deploy.env の SITE_NAME が無いときに web と Worker が使う。 */
export const DEFAULT_SITE_NAME = "personal-wiki";

/** サイト名の長さの上限。サロゲートペアを 1 字と数える（code point 単位）。 */
export const SITE_NAME_MAX_CHARS = 40;

/*
 * サイト名に混ぜない文字。HTML の title、MCP の表示名、OAuth の画面に 1 行で出すので、
 * 制御文字（Cc）、行区切りと段落区切り（U+2028、U+2029）、書式文字（Cf。RTL override などの
 * 向きを変える文字を含む）を拒む。書式文字のうち U+200C と U+200D は、絵文字の結合や
 * ペルシア語の分かち書きに要るので通す。タグ文字（Cf）で組む地域の旗は通らない。
 * ただし U+200C と U+200D は何も描かないので、これらと空白だけの名前は空の名前と同じく拒む（VISIBLE_CHAR）。
 * deploy.env の検査（apps/worker/scripts/deploy-config.mjs）は同じ規則を .mjs に写しており、
 * 両者が食い違わないことを apps/worker/scripts/deploy-config.test.ts が確かめる。
 */
const FORBIDDEN_CHAR = /[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200c\u200d])\p{Cf}/u;

const VISIBLE_CHAR = /[^\s\u200c\u200d]/u;

/** 前後の空白を除いた名前が、上限と使える文字の規則を満たすか。見える文字が 1 字も無い名前は満たさない。 */
export function isValidSiteName(name: string): boolean {
  return (
    VISIBLE_CHAR.test(name) && [...name].length <= SITE_NAME_MAX_CHARS && !FORBIDDEN_CHAR.test(name)
  );
}
