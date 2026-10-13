import { normalizeTitleKey } from "@personal-wiki/domain/title";
import { extractDerived, extractWikiLinks, rewriteWikiLinkTargets } from "@personal-wiki/markdown";

/*
 * 本文の WikiLink の書き換えを、Worker の step（apps/worker/src/pages/link-rewrites.ts）と同じ規則で
 * 手元に写す。書き換えてよいのは旧 key のリンクの target だけで、他のリンクやタグが変わる書き換えは
 * Worker も捨てるので、ここでも行わない。
 */

function keysOf(body: string): { links: Set<string>; tags: Set<string> } {
  const derived = extractDerived(body);
  return {
    links: new Set(derived.links.map((link) => link.targetTitleKey)),
    tags: new Set(derived.tags.map((tag) => tag.tagKey)),
  };
}

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((key) => b.has(key));

/** renames（旧 key → 新しい title）で書き換える。他のリンクやタグまで変わるなら null */
function rewriteStrictly(body: string, renames: ReadonlyMap<string, string>): string | null {
  const rewrite = rewriteWikiLinkTargets(body, renames);
  if (rewrite.rewritten === 0) return body;
  const before = keysOf(body);
  const after = keysOf(rewrite.body);
  const expected = new Set<string>();
  for (const key of before.links) {
    const title = renames.get(key);
    const renamed = title === undefined ? null : normalizeTitleKey(title);
    expected.add(renamed?.ok ? renamed.value : key);
  }
  return sameSet(expected, after.links) && sameSet(before.tags, after.tags) ? rewrite.body : null;
}

/**
 * before から after への変化が、リンクの target の書き換えだけで説明できるときの対応（旧 key → 新しい
 * title）。step の書き換えはリンクの数と並びを変えないので、同じ位置のリンク同士を比べて求め、
 * その対応で before を書き換えると after に一致することを確かめる。説明できなければ null。
 */
export function renamesBetween(before: string, after: string): Map<string, string> | null {
  const from = extractWikiLinks(before);
  const to = extractWikiLinks(after);
  if (from.length !== to.length) return null;
  const renames = new Map<string, string>();
  for (const [index, link] of from.entries()) {
    const next = to[index];
    if (next === undefined || link.target === next.target) continue;
    const key = normalizeTitleKey(link.target);
    if (!key.ok) return null;
    const known = renames.get(key.value);
    if (known !== undefined && known !== next.target) return null;
    renames.set(key.value, next.target);
  }
  if (renames.size === 0) return null;
  return rewriteWikiLinkTargets(before, renames).body === after ? renames : null;
}

/**
 * サーバーがリンクの書き換えだけを加えた本文（base → server）に、手元の未保存の編集（base → draft）を
 * 重ねた本文。書き換えだけでは説明できない変化なら null（呼び出し側は衝突として扱う）。
 */
export function rebaseOnLinkRewrite(base: string, server: string, draft: string): string | null {
  if (draft === base) return server;
  const renames = renamesBetween(base, server);
  if (renames === null) return null;
  return rewriteStrictly(draft, renames);
}
