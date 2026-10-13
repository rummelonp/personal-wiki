import { foldForSearch } from "./derived";
import type { Visibility } from "./store";

/*
 * 検索・最近の更新・backlink の読み取り。どれも visibility で絞らず draft も返すので、
 * token の読み取り用。anonymous に返す経路では使わない。
 */

export interface PageSummary {
  id: string;
  title: string;
  visibility: Visibility;
  updatedAt: number;
}

export interface SearchHit extends PageSummary {
  excerpt: string;
}

export interface PageList {
  pages: PageSummary[];
  /** 続きがあれば、次のリクエストの cursor に渡す不透明な文字列。無ければ null */
  nextCursor: string | null;
}

interface SummaryRow {
  id: string;
  title: string;
  visibility: Visibility;
  updated_at: number;
}

const toSummary = (row: SummaryRow): PageSummary => ({
  id: row.id,
  title: row.title,
  visibility: row.visibility,
  updatedAt: row.updated_at,
});

export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 100;
export const SEARCH_DEFAULT_LIMIT = 20;
/** 抜粋を作る分、一覧より 1 件あたりの CPU が重いので小さく抑える */
export const SEARCH_MAX_LIMIT = 50;
/** 長い phrase は trigram の数だけ照合が増えるので、検索語の長さ（文字数）に上限を置く */
export const SEARCH_MAX_QUERY_CHARS = 200;

/** 抜粋の長さ（文字数）。FTS5 の snippet() は trigram を 1 token と数え、64 が上限 */
const EXCERPT_CHARS = 64;
/** LIKE の抜粋で、一致位置の手前に残す文字数 */
const EXCERPT_LEAD_CHARS = 20;
const ELLIPSIS = "…";

/** 並び順 (updated_at DESC, id DESC) の続きの位置。同じ updated_at のページを取りこぼさないよう id も持つ。 */
const CURSOR_PATTERN = /^([0-9]{1,16})\.([A-Za-z0-9_-]{22})$/;

export interface Cursor {
  updatedAt: number;
  id: string;
}

function encodeCursor(page: Pick<PageSummary, "updatedAt" | "id">): string {
  return `${page.updatedAt}.${page.id}`;
}

export function parseCursor(value: string): Cursor | null {
  const match = CURSOR_PATTERN.exec(value);
  if (match === null) return null;
  return { updatedAt: Number(match[1]), id: match[2] as string };
}

/** limit + 1 件取った行から、limit 件と続きの cursor を作る。 */
function pageOf(rows: SummaryRow[], limit: number): PageList {
  const pages = rows.slice(0, limit).map(toSummary);
  const last = pages.at(-1);
  return {
    pages,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null,
  };
}

/**
 * 削除されていないページを更新日時の降順で返す。visibility では絞らず draft も返すので、token の読み取り用。
 * pages に updated_at の索引は無く、全ページを走査して並べ替える。ページ数が数千を超えて
 * 読み取り行数が気になったら (updated_at, id) の部分索引を足す。保存ごとに書き込みが 1〜2 行増える。
 */
export async function listRecentPages(
  db: D1Database,
  { limit, cursor }: { limit: number; cursor: Cursor | null },
): Promise<PageList> {
  const { results } = await db
    .prepare(
      `SELECT id, title, visibility, updated_at FROM pages
       WHERE deleted_at IS NULL
         AND (?1 IS NULL OR updated_at < ?1 OR (updated_at = ?1 AND id < ?2))
       ORDER BY updated_at DESC, id DESC LIMIT ?3`,
    )
    .bind(cursor?.updatedAt ?? null, cursor?.id ?? null, limit + 1)
    .all<SummaryRow>();
  return pageOf(results, limit);
}

/**
 * pageId を指す links を持つ、削除されていないページを更新日時の降順で返す。
 * pageId のページが無い・削除済みなら null。visibility では絞らず draft も返すので、token の読み取り用。
 * 自分自身へのリンクは含めない。
 *
 * links.target_page_id は保存と削除のたびに付け直されるので、改題や削除の後は古い title で書かれた
 * リンクが外れ、新しい title で書かれたリンクが入る。
 */
export async function listBacklinks(
  db: D1Database,
  pageId: string,
  { limit, cursor }: { limit: number; cursor: Cursor | null },
): Promise<PageList | null> {
  const exists = await db
    .prepare("SELECT 1 AS found FROM pages WHERE id = ?1 AND deleted_at IS NULL")
    .bind(pageId)
    .first();
  if (exists === null) return null;
  const { results } = await db
    .prepare(
      `SELECT p.id, p.title, p.visibility, p.updated_at
       FROM links AS l JOIN pages AS p ON p.id = l.source_page_id
       WHERE l.target_page_id = ?1 AND p.id <> ?1 AND p.deleted_at IS NULL
         AND (?2 IS NULL OR p.updated_at < ?2 OR (p.updated_at = ?2 AND p.id < ?3))
       ORDER BY p.updated_at DESC, p.id DESC LIMIT ?4`,
    )
    .bind(pageId, cursor?.updatedAt ?? null, cursor?.id ?? null, limit + 1)
    .all<SummaryRow>();
  return pageOf(results, limit);
}

export type SearchQuery = { ok: true; query: string } | { ok: false; reason: "empty" | "too_long" };

/** 検索語を pages_fts と同じ NFKC にそろえ、前後の空白を除く。 */
export function prepareSearchQuery(raw: string): SearchQuery {
  const query = foldForSearch(raw).trim();
  if (query === "") return { ok: false, reason: "empty" };
  if ([...query].length > SEARCH_MAX_QUERY_CHARS) return { ok: false, reason: "too_long" };
  return { ok: true, query };
}

/** trigram は 3 文字未満の語を引けない（MATCH しても 0 件になる）ので、短い語は LIKE に回す。 */
const TRIGRAM_MIN_CHARS = 3;

interface FtsRow extends SummaryRow {
  excerpt: string;
}

interface LikeRow extends SummaryRow {
  excerpt: string;
  start: number;
  length: number;
}

/** 抜粋の改行や連続する空白を 1 つの空白にまとめる。 */
const compact = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * 削除されていないページを title と本文の部分一致で探す。query は prepareSearchQuery を通した値。
 * visibility では絞らず draft も返すので、token の読み取り用。
 *
 * - 3 文字以上: FTS5 の MATCH。query 全体を `"` で囲んだ phrase として渡し、`"` は二重にする。
 *   FTS5 の構文（`*`、`OR`、`NEAR(`、列指定）として解釈させないため。
 *   関連度（bm25）の順に返す。title の一致は本文の 4 倍に重み付けする。語が title に入っている
 *   ページは探している対象であることが多い。同点は更新が新しい順。
 * - 2 文字以下: LIKE（`%`、`_`、`\` はエスケープ）。関連度が無いので更新が新しい順。索引が使えず
 *   全ページを走査するが、一人用の wiki の規模では許容する。LIKE が畳む大文字小文字は ASCII だけで、
 *   MATCH（Unicode の大文字小文字を畳む）とは差がある。
 * 抜粋は本文から取る。title にだけ一致したときは本文の先頭になる。
 */
export async function searchPages(
  db: D1Database,
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  if ([...query].length >= TRIGRAM_MIN_CHARS) {
    const { results } = await db
      .prepare(
        `SELECT p.id, p.title, p.visibility, p.updated_at,
                snippet(pages_fts, 1, '', '', ?3, ?4) AS excerpt
         FROM pages_fts JOIN pages AS p ON p.seq = pages_fts.rowid
         WHERE pages_fts MATCH ?1 AND p.deleted_at IS NULL
         ORDER BY bm25(pages_fts, 4.0, 1.0), p.updated_at DESC, p.id DESC LIMIT ?2`,
      )
      .bind(`"${query.replaceAll('"', '""')}"`, limit, ELLIPSIS, EXCERPT_CHARS)
      .all<FtsRow>();
    return results.map((row) => ({ ...toSummary(row), excerpt: compact(row.excerpt) }));
  }

  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const { results } = await db
    .prepare(
      `SELECT id, title, visibility, updated_at, start, length,
              substr(body, start, ?4) AS excerpt
       FROM (
         SELECT p.id, p.title, p.visibility, p.updated_at, f.body AS body,
                max(1, instr(lower(f.body), lower(?2)) - ?5) AS start,
                length(f.body) AS length
         FROM pages_fts AS f JOIN pages AS p ON p.seq = f.rowid
         WHERE (f.title LIKE ?1 ESCAPE '\\' OR f.body LIKE ?1 ESCAPE '\\') AND p.deleted_at IS NULL
         ORDER BY p.updated_at DESC, p.id DESC LIMIT ?3
       )
       ORDER BY updated_at DESC, id DESC`,
    )
    .bind(pattern, query, limit, EXCERPT_CHARS, EXCERPT_LEAD_CHARS)
    .all<LikeRow>();
  return results.map((row) => {
    const head = row.start > 1 ? ELLIPSIS : "";
    const tail = row.start + EXCERPT_CHARS - 1 < row.length ? ELLIPSIS : "";
    return { ...toSummary(row), excerpt: `${head}${compact(row.excerpt)}${tail}` };
  });
}
