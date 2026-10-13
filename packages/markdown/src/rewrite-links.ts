import { normalizeTitleKey } from "@personal-wiki/domain";
import { isAttachmentTarget } from "./embed";
import { extractWikiLinks, type WikiLinkTargetSpan, wikiLinkTargetSpan } from "./wikilink";

/**
 * page の title 変更に合わせて、本文の `[[旧]]` の target を新 title に書き換える。
 *
 * link の解析は `extractWikiLinks` と同じなので、コードや frontmatter の中は書き換えない。
 * 添付の embed は page への参照ではないので対象外（`extractDerived` と同じ）。
 * 書き換えるのは target 本体だけで、`!`、label と区切り（`\|` を含む）、見出し、block id、
 * target の前後の空白は元のまま残す。旧 title の表記ゆれ（大文字小文字、全角半角）は
 * renames のキー（`normalizeTitleKey` の結果）で同一視し、新 title の表記に揃える。
 * target が空の `[[#見出し]]` は同じ page を指すので触らない。
 *
 * target が既に新 title と同じ文字列の link は置き換えず、数にも入れない。
 * 呼び出し側は rewritten が 0 のとき本文が変わっていないものとして扱える。
 *
 * 新 title が `[[...]]` に書ける文字だけで出来ていること（`wikiLinkUnsafeChars`）は
 * 呼び出し側が確かめる。ここでは検査しない。ただし、それを満たす新 title でも link が消えることがある。
 * 同じ段落の前方から始まる inline の構文（バッククォートや `<` の autolink）に新 title の文字が
 * 閉じを与えたり、`![[新]]` の新 title が添付の拡張子で終わったりする場合である。
 * 呼び出し側は書き換え後の本文を解析し直し、旧 key が消えて新 key が現れたことを確かめる。
 *
 * @param renames キーは旧 title の `normalizeTitleKey` の結果、値は新 title
 * @returns 書き換えた本文と、実際に置き換えた link の数
 */
export function rewriteWikiLinkTargets(
  body: string,
  renames: ReadonlyMap<string, string>,
): { body: string; rewritten: number } {
  if (renames.size === 0) return { body, rewritten: 0 };

  let result = "";
  let cursor = 0;
  let rewritten = 0;
  for (const ref of extractWikiLinks(body)) {
    if (ref.isEmbed && isAttachmentTarget(ref.target)) continue;
    const key = normalizeTitleKey(ref.target);
    if (!key.ok) continue;
    const newTitle = renames.get(key.value);
    if (newTitle === undefined) continue;
    // extractWikiLinks が成立させた link なので span は非 null。`[[` の 2 文字を足して本文の位置にする。
    if (ref.target === newTitle) continue;
    const span = wikiLinkTargetSpan(body.slice(ref.from + 2, ref.to - 2)) as WikiLinkTargetSpan;
    result += body.slice(cursor, ref.from + 2 + span.from) + newTitle;
    cursor = ref.from + 2 + span.to;
    rewritten += 1;
  }
  return { body: result + body.slice(cursor), rewritten };
}
