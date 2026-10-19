/*
 * リンクの文字列で、外側の `[text](url)` を壊す文字。`[`、`]`、`\` は括弧と escape を、`` ` `` と `<` は
 * 括弧より強く結び付く code span、autolink、HTML のタグを作り、リンクを入れ子にして外側を無効にする。
 * `*` や `_` などの強調は、括弧より弱く、見た目が変わるだけなので escape しない。escape の `\` は
 * Markdown として表示しない読み手（llms.txt を読む AI など）にはそのまま見えるので、要るものに限る。
 */
const LINK_TEXT_UNSAFE = /[\\[\]`<]/g;

/*
 * 文字参照（`&amp;`、`&#38;` など）に見える `&`。escape しないと、Markdown として表示する読み手は
 * title の `&amp;` を `&` と表示する。文字参照にならない `&` は、そのまま `&` と表示されるので escape しない。
 */
const ENTITY_AMPERSAND = /&(?=#?[0-9A-Za-z]+;)/g;

/*
 * 宛先で `(` と `)` を percent-encoding にする。CommonMark は対になった括弧を宛先に許すが、対にならない
 * `)` は宛先を途中で終わらせる。対の括弧も、最初の `)` までを URL と読む簡易な読み手（正規表現で
 * llms.txt を読むものなど）には壊れて見える。
 */
const URL_PARENS = /[()]/g;

/**
 * `[text](url)` の inline のリンクを作る。text は表示したい文字列そのもので、url は percent-encoding 済みの
 * 絶対 URL（空白、改行、`<`、`>` を含まない）を渡す。text は改行を含まない 1 行にする。
 */
export function markdownLink(text: string, url: string): string {
  const label = text.replace(LINK_TEXT_UNSAFE, "\\$&").replace(ENTITY_AMPERSAND, "\\&");
  const href = url.replace(URL_PARENS, (ch) => (ch === "(" ? "%28" : "%29"));
  return `[${label}](${href})`;
}
