import { collapseConfusables, isOneEditAway } from "./title-similarity";

export interface PageCandidate {
  readonly id: string;
  readonly title: string;
}

/**
 * WikiLink autocomplete の候補解決。
 *
 * `search` は同期で返す。Promise にすると `[[` の 1 文字目から候補が出るまでに
 * round trip が挟まり、ネットワークが文字入力の critical path に入る。
 * サーバー由来の追加候補が要る場合は、別経路で後から merge する。
 *
 * 通常一致が無い query には、見た目の近い既存ページも弱い候補として混ぜる
 * （`createMemoryPageIndex` の実装）。
 * NFKC 正規化では統合されない表記ゆれによって、意図せず新しいページを作る前に気付けるようにするため。
 */
export interface PageIndex {
  search(query: string): PageCandidate[];
  /**
   * 候補を取る 1 回目が済んだか（成功でも失敗でもよい）。false の間の「候補なし」は、
   * 無いのではなくまだ取れていないので、補完は「作成」の候補を出さない。
   * 全件を最初から持つ索引は実装しなくてよい（済んでいる扱い）。
   */
  settled?(): boolean;
}

export interface MemoryPageIndexOptions {
  /** 返す候補の上限。既定 20 */
  readonly limit?: number;
  /**
   * title と query を比較可能な形へ畳む関数。
   * title_key の正規化規則（`@personal-wiki/domain/title` の `foldTitle` 等）と揃える必要があるため、
   * 呼び出し側から注入させる。
   */
  readonly normalize: (text: string) => string;
}

interface Entry {
  readonly candidate: PageCandidate;
  readonly key: string;
  readonly order: number;
}

/** 大きいほど上位。一致しなければ null。 */
function score(key: string, query: string): number | null {
  if (query.length === 0) return 0;
  if (key === query) return 4_000_000;
  if (key.startsWith(query)) return 3_000_000 - key.length;
  const at = key.indexOf(query);
  if (at >= 0) return 2_000_000 - at * 1_000 - key.length;
  // fuzzy: query の文字が順序どおりに現れるか。散らばり（最初と最後の距離）が小さいほど上位。
  let first = -1;
  let cursor = 0;
  for (const ch of query) {
    const found = key.indexOf(ch, cursor);
    if (found < 0) return null;
    if (first < 0) first = found;
    cursor = found + ch.length;
  }
  return 1_000_000 - (cursor - first) * 1_000 - key.length;
}

/** 通常の score が拾えなかった候補にだけ出す、見た目の近さによる弱い候補の上限件数。 */
const SIMILAR_LIMIT = 3;

/**
 * NFKC で統合されない表記ゆれ（波ダッシュ等）と、1 文字の
 * 編集距離だけ離れた title を「見た目の近い既存ページ」として拾う。
 * score と同じ 0 〜 4,000,000 のレンジ内で計算し、通常の score より必ず下位（1,000,000 未満）に
 * 収まるよう縮小する。通常の score が非 null を返す候補には呼ばない（呼び出し側で分岐する）。
 */
function similarScore(key: string, query: string): number | null {
  if (query.length < 2) return null;

  const loose = score(collapseConfusables(key), collapseConfusables(query));
  if (loose !== null) return Math.floor((loose / 4_000_000) * 999_999);

  return isOneEditAway(key, query) ? 1 : null;
}

/** client 側に配信された title index を想定した、線形走査の実装。 */
export function createMemoryPageIndex(
  pages: readonly PageCandidate[],
  options: MemoryPageIndexOptions,
): PageIndex {
  const { limit = 20, normalize } = options;
  const entries: Entry[] = pages.map((candidate, order) => ({
    candidate,
    key: normalize(candidate.title),
    order,
  }));
  return {
    search(query) {
      const q = normalize(query);
      const hits: { entry: Entry; score: number }[] = [];
      const similar: { entry: Entry; score: number }[] = [];
      for (const entry of entries) {
        const s = score(entry.key, q);
        if (s !== null) {
          hits.push({ entry, score: s });
          continue;
        }
        const s2 = similarScore(entry.key, q);
        if (s2 !== null) similar.push({ entry, score: s2 });
      }
      const byScore = (a: { score: number; entry: Entry }, b: { score: number; entry: Entry }) =>
        b.score - a.score || a.entry.order - b.entry.order;
      hits.sort(byScore);
      similar.sort(byScore);
      return hits
        .concat(similar.slice(0, SIMILAR_LIMIT))
        .slice(0, limit)
        .map((hit) => hit.entry.candidate);
    },
  };
}
