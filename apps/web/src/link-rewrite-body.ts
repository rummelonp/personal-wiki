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
 *
 * 片方の本文が base のままなら、もう片方をそのまま採る（本文の 3-way merge）。手元の本文が base なら
 * server の変更が書き換え以外でも採る。重ねる編集が無く、どちらの側からも失うものが無いため。
 * title の食い違いはここでは見ないので、呼び出し側で先に確かめる。
 */
export function rebaseOnLinkRewrite(base: string, server: string, draft: string): string | null {
  if (server === base) return draft;
  if (draft === base) return server;
  const renames = renamesBetween(base, server);
  if (renames === null) return null;
  return rewriteStrictly(draft, renames);
}

/**
 * 離脱で退避した内容（saved）が、離脱の保存（keepalive）で既にサーバーへ入り、その後 step がリンクを
 * 書き換えて server になったのか。真なら退避は保存済みなので、復元を選ばせず消してよい。
 * keepalive は応答を受け取れないので、保存が成立したかは手元で分からず、サーバーの内容から推す。
 * 判断に迷うときは false を返す（退避を消すと、保存されていない編集を黙って失うため）。
 *
 * - server の本文が saved の本文へのリンクの書き換えだけで説明できなければ false。
 * - title を変えて退避し、server がその title なら true。title と本文は 1 回の保存で入るので、
 *   title が入っていれば本文も入っている。自ページの `[[旧 title]]` は改名の保存の後に step が書き換える。
 * - title が同じなら、本文だけでは保存の成否が分からない。server の本文が保存前の本文（baseBody）から
 *   書き換えだけで説明できるなら、保存されていなくても同じ見た目になるので false。
 *   手元の編集がリンクの付け替えだけだった場合に、その編集を失わないため。
 */
export function savedBeforeLeaving(
  saved: { title: string; body: string; baseTitle?: string; baseBody?: string },
  server: { title: string; body: string },
): boolean {
  const { baseTitle, baseBody } = saved;
  if (baseTitle === undefined || baseBody === undefined || server.title !== saved.title) {
    return false;
  }
  if (saved.body !== server.body && renamesBetween(saved.body, server.body) === null) return false;
  if (saved.title !== baseTitle) return true;
  return server.body !== baseBody && renamesBetween(baseBody, server.body) === null;
}
