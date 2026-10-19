/** bodySha256 を返す tool の description に共通で載せる、計算の手順 */
export const BODY_SHA256_NOTE =
  "bodySha256 は保存されている本文（frontmatter を含む全体。title は含まない）を UTF-8 のバイト列にした SHA-256 で、小文字の 16 進 64 文字。改行の変換、末尾の改行の補い、frontmatter の除去はしない。ローカルの Markdown を UTF-8 のまま `shasum -a 256` などでハッシュした値と比べれば、本文を読み直さずに一致を確かめられる（ローカル側の CRLF や末尾の改行の有無が違うと別の値になる）。";

/** 一覧の tool の description に載せる、各件の bodySha256 の扱い */
export const LISTED_BODY_SHA256_NOTE =
  "各件の bodySha256 は read_page の bodySha256 と同じ値で、計算の手順は read_page の説明にある。多数のページをローカルの写しと照合するときは、read_page で 1 件ずつ読まずに、この値をローカルのファイルのハッシュと比べる。bodySha256 は中身が同じかを見分け、version は写しを取ってから wiki 側で保存されたかを見分けるので、上書きする前には version も比べる。まだハッシュを持たないページには無い（本文が空のページにはある）。無いページは read_page で確かめる。";
