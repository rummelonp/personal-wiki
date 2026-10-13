import { normalizeTitleKey } from "@personal-wiki/domain";
import { isAttachmentTarget } from "./embed";
import { extractWikiLinks, wikiLinkTargetSpan } from "./wikilink";

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
 * 新 title が `[[...]]` に書ける文字だけで出来ていること（`wikiLinkUnsafeChars`）は
 * 呼び出し側が確かめる。ここでは検査しない。
 *
 * @param renames 旧 title の TitleKey から新 title への対応
 * @returns 書き換えた本文と、書き換えた link の数
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
    const span = wikiLinkTargetSpan(body.slice(ref.from + 2, ref.to - 2)) as {
      from: number;
      to: number;
    };
    result += body.slice(cursor, ref.from + 2 + span.from) + newTitle;
    cursor = ref.from + 2 + span.to;
    rewritten += 1;
  }
  return { body: result + body.slice(cursor), rewritten };
}
