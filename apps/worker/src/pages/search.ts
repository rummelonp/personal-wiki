import {
  foldKeepingUnderscore,
  normalizeTitleKey,
  SEARCH_MAX_QUERY_CHARS,
  type SearchQuery,
  TRIGRAM_MIN_CHARS,
} from "@personal-wiki/domain";
import type { ReadableVisibility } from "../auth/principal";
import { publicOnlyFlag, type Visibility } from "./store";

/*
 * 検索、最近の更新、backlink、タグの読み取り。どれも readable（readableVisibilityOf の値）を必須で
 * 受け取り、public なら draft を SQL の段階で除く。取得後に配列から除くと、LIMIT と nextCursor が
 * 除く前の行で決まり、件数が欠けたり cursor に draft の id が入ったりする。
 */

export interface PageSummary {
  id: string;
  title: string;
  visibility: Visibility;
  updatedAt: number;
}

/** 最近の更新の 1 件。 */
export interface ListedPage extends PageSummary {
  /**
   * 本文の先頭の抜粋。保存時に作った派生データで、それより前から在るページは rebuild するまで無い。
   * 本文が空のページにも無い。
   */
  excerpt?: string;
  /** タグの表記。本文に最初に現れた表記で、tag_key の順 */
  tags: string[];
}

export interface SearchHit extends PageSummary {
  /**
   * 一致した位置の周辺の抜粋。ListedPage.excerpt（本文の先頭）と違い、検索語がどこに当たったかを見せる。
   * NFKC 後の plainText から作るので、元の本文の表記（全角英数や半角カナ）と異なりうる
   */
  excerpt: string;
  tags: string[];
}

export interface PageList<T extends PageSummary = PageSummary> {
  pages: T[];
  /** 続きがあれば、次のリクエストの cursor に渡す不透明な文字列。無ければ null */
  nextCursor: string | null;
}

interface SummaryRow {
  id: string;
  title: string;
  visibility: Visibility;
  updated_at: number;
}

interface ExcerptRow extends SummaryRow {
  /** page_excerpts の行が無いページは null */
  excerpt: string | null;
}

const toSummary = (row: SummaryRow): PageSummary => ({
  id: row.id,
  title: row.title,
  visibility: row.visibility,
  updatedAt: row.updated_at,
});

export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 100;
/**
 * title の一覧の 1 回の上限。1 件は id（22 文字）と title、visibility、updatedAt だけで、title は
 * 平均で数十バイト、上限の MAX_TITLE_BYTES（1024）でも 500 件のレスポンスは 1MB 程度（JSON のエスケープで最大 2 倍になる分を含む）に収まる。
 * Worker の CPU（Workers Free は 1 リクエスト 10ms）を使うのは 500 件の JSON 化くらいで、
 * 抜粋とタグを引く LIST_MAX_LIMIT の一覧のように件数を絞る理由が無い。
 * 並びは pages_alive_updated のインデックスをたどるので、読む行数は limit（と、匿名なら読み飛ばす draft の数）で決まる。
 */
export const TITLES_MAX_LIMIT = 500;
/**
 * タグの一覧の limit の上限。件数は GROUP BY の後の相関副問い合わせで全タグ分を数えてから切るので、
 * limit を小さくしても読む行数は減らず、上限は応答の大きさを抑えるためのもの。
 */
export const TAGS_MAX_LIMIT = 1000;
export const SEARCH_DEFAULT_LIMIT = 20;
/** 抜粋を作る分、一覧より 1 件あたりの CPU が重いので小さく抑える */
export const SEARCH_MAX_LIMIT = 50;

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

/**
 * cursor より後ろ（並び (updated_at DESC, id DESC) で先）の行に絞る条件。?1 と ?2 に cursor を bind する。
 * cursor が無いときは条件を足さない。`?1 IS NULL OR ...` の 1 本の SQL にすると、SQLite は bind する値を
 * 見ずに計画を立てるのでインデックスを範囲の検索に使えず、cursor の位置までインデックスを先頭から読み飛ばす。
 */
function afterCursor(cursor: Cursor | null, alias: string): string {
  return cursor === null ? "" : `AND (${alias}updated_at, ${alias}id) < (?1, ?2)`;
}

/** limit + 1 件取った行から、limit 件と続きの cursor を作る。 */
function pageOf<T extends PageSummary>(
  rows: SummaryRow[],
  limit: number,
  map: (row: SummaryRow) => T,
): PageList<T> {
  const pages = rows.slice(0, limit).map(map);
  const last = pages.at(-1);
  return {
    pages,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null,
  };
}

/** 複数のページのタグの表記を 1 クエリで引く。タグの無いページは Map に入らない。 */
async function tagsByPage(db: D1Database, pageIds: string[]): Promise<Map<string, string[]>> {
  const byPage = new Map<string, string[]>();
  if (pageIds.length === 0) return byPage;
  // id を個別に bind すると D1 の bind 100 個の上限に近づくので、JSON 1 個で渡す
  const { results } = await db
    .prepare(
      `SELECT page_id, tag FROM tags
       WHERE page_id IN (SELECT value FROM json_each(?1)) ORDER BY page_id, tag_key`,
    )
    .bind(JSON.stringify(pageIds))
    .all<{ page_id: string; tag: string }>();
  for (const row of results) {
    const tags = byPage.get(row.page_id);
    if (tags === undefined) byPage.set(row.page_id, [row.tag]);
    else tags.push(row.tag);
  }
  return byPage;
}

/** タグの絞り込みに渡す tag_key。 */
export type TagFilter = { ok: true; key: string } | { ok: false; reason: "empty" | "too_long" };

/**
 * tag_key の長さ（UTF-16 単位）の上限。本文のタグは長くても数十字で、検索語と同様に照合量を抑える。
 * 判定は畳んだ後の key で行う。照合に使うのは畳んだ値で、抑えたいのはその長さだから。
 * 畳む前に 200 字でも、NFKC で伸びる文字（`㌀` は 4 文字）を含めば 400 になる。
 */
const TAG_MAX_LENGTH = 200;

/**
 * 表記を tags.tag_key と同じ畳み方（foldKeepingUnderscore）にする。ページをまたぐ照合はこの値で行う。
 * 先頭の `#` は畳んだ後に 1 つだけ剥がす（frontmatter の tags と同じ許容）。畳む前に剥がすと、
 * 前に空白がある ` #a` や全角の `＃a` が、`#` を含む key になって何にも一致しない。
 */
export function prepareTagFilter(raw: string): TagFilter {
  const folded = foldKeepingUnderscore(raw);
  const key = folded.startsWith("#") ? folded.slice(1) : folded;
  if (key === "") return { ok: false, reason: "empty" };
  if (key.length > TAG_MAX_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, key };
}

const TAG_FILTER_MESSAGES: Record<Extract<TagFilter, { ok: false }>["reason"], string> = {
  empty: "tag が空か、`#` だけになっている",
  too_long: `tag が長すぎる（表記をそろえた後の UTF-16 の単位で上限 ${TAG_MAX_LENGTH}）`,
};

/** タグの絞り込みのエラーに添える項目。上限は too_long のときだけ返す。 */
export function tagFilterErrorFields(reason: Extract<TagFilter, { ok: false }>["reason"]) {
  return {
    reason,
    ...(reason === "too_long" ? { max: TAG_MAX_LENGTH } : {}),
    message: TAG_FILTER_MESSAGES[reason],
  };
}

/**
 * 削除されていないページを更新日時の降順で返す。
 *
 * tagKey（prepareTagFilter の値）を渡すと、そのタグが付いたページに絞る。ネストタグは親で子も拾い、
 * `a` は `a/b`、`a/b/c` が付いたページにも一致する（Obsidian の検索と同じ）。tag_key は `/` 区切りの
 * 文字列なので、子は `a/` 以上 `a0` 未満（`/` の次の文字が `0`）の範囲になり、tags_tag_key のインデックスを
 * 使える。LIKE は大文字小文字を畳むためインデックスを使えず、tag_key の畳み方とも合わない。
 * 子のタグを複数持つページは 1 件にまとめる。
 *
 * visibility を渡すと、その公開範囲のページに絞る。readable との AND で、readable が public なら
 * draft を指定しても 1 件も返らない（読めない範囲を絞り込みで広げない）。
 *
 * keyset のページングなので、走査中に更新されたページは先頭へ移り、後続のページでは返らない。
 * 差分の同期には使えず、先頭から取り直す。
 * タグで絞らない一覧は pages_alive_updated のインデックスを新しい順にたどり、limit + 1 件で止まる。
 * visibility と readable の条件はインデックスでなく行ごとに照合するので、合う行が少ないと多くの行を読む。
 */
export async function listRecentPages(
  db: D1Database,
  {
    limit,
    cursor,
    tagKey = null,
    visibility = null,
    readable,
  }: {
    limit: number;
    cursor: Cursor | null;
    tagKey?: string | null;
    visibility?: Visibility | null;
    readable: ReadableVisibility;
  },
): Promise<PageList<ListedPage>> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.title, p.visibility, p.updated_at, e.excerpt
       FROM pages AS p LEFT JOIN page_excerpts AS e ON e.page_id = p.id
       WHERE p.deleted_at IS NULL AND (?7 = 0 OR p.visibility = 'public')
         AND (?8 IS NULL OR p.visibility = ?8)
         ${afterCursor(cursor, "p.")}
         AND (?4 IS NULL OR p.id IN (
           SELECT page_id FROM tags WHERE tag_key = ?4 OR (tag_key >= ?5 AND tag_key < ?6)))
       ORDER BY p.updated_at DESC, p.id DESC LIMIT ?3`,
    )
    .bind(
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      limit + 1,
      tagKey,
      tagKey === null ? null : `${tagKey}/`,
      tagKey === null ? null : `${tagKey}0`,
      publicOnlyFlag(readable),
      visibility,
    )
    .all<ExcerptRow>();
  const list = pageOf(results, limit, toSummary);
  const excerpts = new Map(results.map((row) => [row.id, row.excerpt]));
  const tags = await tagsByPage(
    db,
    list.pages.map((page) => page.id),
  );
  return {
    pages: list.pages.map((page) => {
      const excerpt = excerpts.get(page.id);
      return {
        ...page,
        ...(excerpt ? { excerpt } : {}),
        tags: tags.get(page.id) ?? [],
      };
    }),
    nextCursor: list.nextCursor,
  };
}

/**
 * 削除されていないページの id と title を更新日時の降順で返す。`[[` の候補のように title だけが要る
 * 呼び出し向けで、listRecentPages と違い抜粋とタグを引かない。cursor と並び順は listRecentPages と同じで、
 * 走査中の更新が後続のページで返らないことも同じ。
 */
export async function listPageTitles(
  db: D1Database,
  {
    limit,
    cursor,
    readable,
  }: { limit: number; cursor: Cursor | null; readable: ReadableVisibility },
): Promise<PageList> {
  const { results } = await db
    .prepare(
      `SELECT id, title, visibility, updated_at FROM pages
       WHERE deleted_at IS NULL AND (?4 = 0 OR visibility = 'public')
         ${afterCursor(cursor, "")}
       ORDER BY updated_at DESC, id DESC LIMIT ?3`,
    )
    .bind(cursor?.updatedAt ?? null, cursor?.id ?? null, limit + 1, publicOnlyFlag(readable))
    .all<SummaryRow>();
  return pageOf(results, limit, toSummary);
}

/** タグの表記と、そのタグ（子のタグを含む）が付いたページの数。 */
export interface TagCount {
  tag: string;
  count: number;
}

export interface TagCountList {
  tags: TagCount[];
  /** limit で切り、後ろに残りがあるとき true */
  truncated: boolean;
}

/**
 * 削除されていないページに付いたタグを、ページ数の降順で返す。同数は tag_key の順（大文字小文字を畳んだ順）。
 *
 * count は listRecentPages の tagKey に同じ表記を渡したときの件数に合わせ、子のタグが付いたページを含む
 * （重複は 1 と数える）。ページに書かれた子のタグ `a/b` から作った親 `a` は、ページに直接書かれていなければ
 * 一覧に出ない。tag は、そのタグが付いたページの表記のうち文字コード順で先頭のもの。
 * tags の削除済みページの行は削除時（と派生データの作り直し）で消える。readable が public のときと
 * visibility を指定したときは、ページを pages から引く副問い合わせで削除済みも除き、行が消え損ねても出さない。
 * readable が all で visibility の指定が無いときは pages を読まず、行が消えることに頼る（owner の一覧のたびに
 * 全ページを読む副問い合わせを足さない）。
 *
 * 一覧に出すタグ、件数、表記のどれも、readable と visibility の両方に合うページだけから作る。
 * readable が public なら draft にしか付いていないタグは出さず、draft の表記（`Beta` と `beta` の違いなど）も
 * 表に出さない。readable が public で visibility が draft なら、必ず空になる。
 * count は listRecentPages に同じ visibility を渡したときの件数に合う。
 *
 * limit を渡すと上の並びの上位 limit 件で切り、残りがあれば truncated を true にする。
 * 件数の集計はページ間で動くので、cursor は持たない。limit が null なら全件で、truncated は常に false。
 */
export async function listTagCounts(
  db: D1Database,
  readable: ReadableVisibility,
  visibility: Visibility | null = null,
  limit: number | null = null,
): Promise<TagCountList> {
  const { results } = await db
    .prepare(
      `WITH visible AS (
         SELECT page_id, tag_key, tag FROM tags
         WHERE (?1 = 0 AND ?2 IS NULL) OR page_id IN (
           SELECT id FROM pages
           WHERE deleted_at IS NULL AND (?1 = 0 OR visibility = 'public')
             AND (?2 IS NULL OR visibility = ?2))
       )
       SELECT min(t.tag) AS tag,
         (SELECT count(DISTINCT c.page_id) FROM visible AS c
          WHERE c.tag_key = t.tag_key
             OR (c.tag_key >= t.tag_key || '/' AND c.tag_key < t.tag_key || '0')) AS count
       FROM visible AS t GROUP BY t.tag_key ORDER BY count DESC, t.tag_key
       LIMIT ?3`,
    )
    // 切り詰めたかを知るため 1 件多く読む。SQLite は負の LIMIT を無制限と読む
    .bind(publicOnlyFlag(readable), visibility, limit === null ? -1 : limit + 1)
    .all<TagCount>();
  if (limit === null || results.length <= limit) return { tags: results, truncated: false };
  return { tags: results.slice(0, limit), truncated: true };
}

/**
 * pageId を指す links を持つ、削除されていないページを更新日時の降順で返す。
 * pageId のページが無いか削除済みなら null。自分自身へのリンクは含めない。
 * readable が public なら、リンク元を public のページに絞る。pageId 自体は draft でもよい
 * （id を知っていれば draft を読めるのと同じ扱いで、返すのは public のページだけ）。
 *
 * links.target_page_id は保存と削除のたびに付け直されるので、改題や削除の後は古い title で書かれた
 * リンクが外れ、新しい title で書かれたリンクが入る。
 */
export async function listBacklinks(
  db: D1Database,
  pageId: string,
  {
    limit,
    cursor,
    readable,
  }: { limit: number; cursor: Cursor | null; readable: ReadableVisibility },
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
         AND (?5 = 0 OR p.visibility = 'public')
         AND (?2 IS NULL OR p.updated_at < ?2 OR (p.updated_at = ?2 AND p.id < ?3))
       ORDER BY p.updated_at DESC, p.id DESC LIMIT ?4`,
    )
    .bind(
      pageId,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      limit + 1,
      publicOnlyFlag(readable),
    )
    .all<SummaryRow>();
  return pageOf(results, limit, toSummary);
}

/**
 * title で書かれた links を持つ、削除されていないページを更新日時の降順で返す。並びと cursor は
 * listBacklinks と同じ。title が title_key にできなければ null。
 * まだ無いページ（と匿名から見た draft）の画面で使う。target_page_id もリンク先の有無も見ないので、
 * 匿名には、リンク先が draft でも無くても同じ public のリンク元が返る。
 * リンク先のページがあれば、そのページ自身を title_key で除く（自分へのリンクを含めない）。
 */
export async function listBacklinksByTitle(
  db: D1Database,
  title: string,
  {
    limit,
    cursor,
    readable,
  }: { limit: number; cursor: Cursor | null; readable: ReadableVisibility },
): Promise<PageList | null> {
  const key = normalizeTitleKey(title);
  if (!key.ok) return null;
  const { results } = await db
    .prepare(
      `SELECT p.id, p.title, p.visibility, p.updated_at
       FROM links AS l JOIN pages AS p ON p.id = l.source_page_id
       WHERE l.target_title_key = ?1 AND p.title_key <> ?1 AND p.deleted_at IS NULL
         AND (?5 = 0 OR p.visibility = 'public')
         AND (?2 IS NULL OR p.updated_at < ?2 OR (p.updated_at = ?2 AND p.id < ?3))
       ORDER BY p.updated_at DESC, p.id DESC LIMIT ?4`,
    )
    .bind(
      key.value,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      limit + 1,
      publicOnlyFlag(readable),
    )
    .all<SummaryRow>();
  return pageOf(results, limit, toSummary);
}

/** 行き先の無いリンク 1 種類（title_key 1 つ）と、そのリンク元。 */
export interface UnresolvedLink {
  /**
   * リンクの title を normalizeTitleKey で畳んだ値。`[[...]]` に書かれた表記（大文字小文字、全角半角、`_`）は
   * links に残らないので、元の表記はリンク元の本文から読む。
   */
  titleKey: string;
  /** リンク元のページ数（読める範囲）。sources はこのうち新しい順の先頭 UNRESOLVED_SOURCES_PER_TITLE 件 */
  sourceCount: number;
  sources: PageSummary[];
}

export interface UnresolvedLinkList {
  links: UnresolvedLink[];
  /** 続きがあれば、次のリクエストの after に渡す値。無ければ null */
  nextCursor: string | null;
}

/** UnresolvedLink.sources に載せるリンク元の数。全部は list_backlinks に title を渡して取る */
export const UNRESOLVED_SOURCES_PER_TITLE = 5;

/**
 * links.target_page_id が NULL の行（削除されていないページの本文にある、行き先のページが無いリンク）を
 * title_key ごとにまとめて返す。target_page_id は保存、改題、削除のたびに付け直されるので、
 * 作ったページへのリンクは外れ、改題や削除で行き先を失ったリンクは入る。改題の直後は、書き換えを待つ
 * 旧 title のリンクも入る（rewrite_links が進めると消える）。
 *
 * 並びは title_key の昇順なので、cursor は updated_at の並びではなく最後の title_key にする。
 * readable が public なら、リンク元を public のページに絞る（件数も絞った後の数）。
 * sourceId を渡すと、そのページが書いたリンクだけにする（sourceCount は 1）。
 *
 * 匿名に見せる経路では使わない。行き先が draft のリンクは target_page_id が付いて一覧から外れるので、
 * public のページの本文にある `[[X]]` が一覧に無いことから、X という draft の存在がわかってしまう。
 */
export async function listUnresolvedLinks(
  db: D1Database,
  {
    limit,
    after,
    sourceId,
    readable,
  }: { limit: number; after: string | null; sourceId: string | null; readable: ReadableVisibility },
): Promise<UnresolvedLinkList> {
  const publicOnly = publicOnlyFlag(readable);
  const { results: keys } = await db
    .prepare(
      `SELECT l.target_title_key AS title_key, count(*) AS source_count
       FROM links AS l JOIN pages AS p ON p.id = l.source_page_id
       WHERE l.target_page_id IS NULL AND p.deleted_at IS NULL AND (?1 = 0 OR p.visibility = 'public')
         AND (?2 IS NULL OR l.target_title_key > ?2) AND (?4 IS NULL OR l.source_page_id = ?4)
       GROUP BY l.target_title_key ORDER BY l.target_title_key LIMIT ?3`,
    )
    .bind(publicOnly, after, limit + 1, sourceId)
    .all<{ title_key: string; source_count: number }>();
  const shown = keys.slice(0, limit);
  if (shown.length === 0) return { links: [], nextCursor: null };
  // リンク元は、取ったリンクの title_key をまとめて 1 クエリで引く（key を個別に bind すると bind 100 個の上限に近づく）
  const { results: rows } = await db
    .prepare(
      `SELECT title_key, id, title, visibility, updated_at FROM (
         SELECT l.target_title_key AS title_key, p.id, p.title, p.visibility, p.updated_at,
                row_number() OVER (
                  PARTITION BY l.target_title_key ORDER BY p.updated_at DESC, p.id DESC) AS rank
         FROM links AS l JOIN pages AS p ON p.id = l.source_page_id
         WHERE l.target_page_id IS NULL AND p.deleted_at IS NULL AND (?1 = 0 OR p.visibility = 'public')
           AND l.target_title_key IN (SELECT value FROM json_each(?2))
           AND (?4 IS NULL OR l.source_page_id = ?4)
       ) WHERE rank <= ?3
       ORDER BY title_key, updated_at DESC, id DESC`,
    )
    .bind(
      publicOnly,
      JSON.stringify(shown.map((row) => row.title_key)),
      UNRESOLVED_SOURCES_PER_TITLE,
      sourceId,
    )
    .all<SummaryRow & { title_key: string }>();
  const sourcesByKey = new Map<string, PageSummary[]>();
  for (const row of rows) {
    const sources = sourcesByKey.get(row.title_key);
    if (sources === undefined) sourcesByKey.set(row.title_key, [toSummary(row)]);
    else sources.push(toSummary(row));
  }
  return {
    links: shown.map((row) => ({
      titleKey: row.title_key,
      sourceCount: row.source_count,
      sources: sourcesByKey.get(row.title_key) ?? [],
    })),
    nextCursor: keys.length > limit ? (shown.at(-1)?.title_key ?? null) : null,
  };
}

const SEARCH_QUERY_MESSAGES: Record<Extract<SearchQuery, { ok: false }>["reason"], string> = {
  empty: "検索語が空か、空白だけになっている",
  too_long: `検索語が長すぎる（上限 ${SEARCH_MAX_QUERY_CHARS} 文字）`,
  control_char: "検索語に制御文字を含められない",
};

/** REST と MCP が検索語のエラーに添える項目。上限は too_long のときだけ返す。 */
export function searchQueryErrorFields(reason: Extract<SearchQuery, { ok: false }>["reason"]) {
  return {
    reason,
    ...(reason === "too_long" ? { max: SEARCH_MAX_QUERY_CHARS } : {}),
    message: SEARCH_QUERY_MESSAGES[reason],
  };
}

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
 * readable が public なら draft を除く。
 *
 * - 3 文字以上: FTS5 の MATCH。query 全体を `"` で囲んだ phrase として渡し、`"` は二重にする。
 *   FTS5 の構文（`*`、`OR`、`NEAR(`、列指定）として解釈させないため。
 *   title に語を含むページを先に、その中と残りをそれぞれ関連度（bm25）の順に返す。語が title に入っている
 *   ページは探している対象であることが多い。title の一致を bm25 の重みだけで上に出そうとしても、
 *   bm25 は title と本文を合わせた長さで正規化するので、本文が長いページは title に一致しても、
 *   本文が短くタグにだけ語を含むページより下になる（title の重みを 4 倍にしても逆転しない）。
 *   title の重み（本文の 4 倍）は、title に含むページどうしを title の一致の多さで並べる。同点は更新が新しい順。
 * - 2 文字以下: LIKE（`%`、`_`、`\` はエスケープ）。関連度が無いので、title に含むページを先に、
 *   その中と残りをそれぞれ更新が新しい順に返す。インデックスが使えず全ページを走査するが、一人用の wiki の規模では許容する。
 *   匿名の短い語は REST が ANONYMOUS_SEARCH_MIN_CHARS で拒むので、ここで走査するのは owner と token のリクエストだけ。
 *   LIKE が畳む大文字小文字は ASCII だけで、MATCH（Unicode の大文字小文字を畳む）とは差がある。
 * 抜粋は本文から取る。title にだけ一致したときは本文の先頭になる。
 */
export async function searchPages(
  db: D1Database,
  query: string,
  limit: number,
  readable: ReadableVisibility,
): Promise<SearchHit[]> {
  const publicOnly = publicOnlyFlag(readable);
  if ([...query].length >= TRIGRAM_MIN_CHARS) {
    const phrase = `"${query.replaceAll('"', '""')}"`;
    // snippet() は一致した全行で作ると高くつくので、内側で並べて LIMIT した行にだけ外側で作る。
    // snippet() は MATCH の走査の中でしか使えないので、外側では pages_fts を rowid と MATCH の両方で
    // 引き直す（EXPLAIN QUERY PLAN では INDEX 0:=M2）。CROSS JOIN は、planner が pages_fts を外側のループに
    // 置き、MATCH の全件を走査する結合の順にしないために付ける。
    const { results } = await db
      .prepare(
        `SELECT hit.id, hit.title, hit.visibility, hit.updated_at,
                snippet(pages_fts, 1, '', '', ?3, ?4) AS excerpt
         FROM (
           SELECT p.seq, p.id, p.title, p.visibility, p.updated_at,
                  pages_fts.rowid IN (SELECT rowid FROM pages_fts WHERE pages_fts MATCH ?6) AS in_title,
                  bm25(pages_fts, 4.0, 1.0) AS score
           FROM pages_fts JOIN pages AS p ON p.seq = pages_fts.rowid
           WHERE pages_fts MATCH ?1 AND p.deleted_at IS NULL
             AND (?5 = 0 OR p.visibility = 'public')
           ORDER BY in_title DESC, score, p.updated_at DESC, p.id DESC LIMIT ?2
         ) AS hit
         CROSS JOIN pages_fts ON pages_fts.rowid = hit.seq
         WHERE pages_fts MATCH ?1
         ORDER BY hit.in_title DESC, hit.score, hit.updated_at DESC, hit.id DESC`,
      )
      .bind(
        phrase,
        limit,
        ELLIPSIS,
        EXCERPT_CHARS,
        publicOnly,
        // 列指定（`{title}:`）は FTS5 の構文。phrase は `"` で閉じてあるので、query が式に混ざらない
        `{title}: ${phrase}`,
      )
      .all<FtsRow>();
    const tags = await tagsByPage(
      db,
      results.map((row) => row.id),
    );
    return results.map((row) => ({
      ...toSummary(row),
      excerpt: compact(row.excerpt),
      tags: tags.get(row.id) ?? [],
    }));
  }

  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const { results } = await db
    .prepare(
      `SELECT id, title, visibility, updated_at, start, length,
              substr(body, start, ?4) AS excerpt
       FROM (
         SELECT p.id, p.title, p.visibility, p.updated_at, f.body AS body,
                f.title LIKE ?1 ESCAPE '\\' AS in_title,
                max(1, instr(lower(f.body), lower(?2)) - ?5) AS start,
                length(f.body) AS length
         FROM pages_fts AS f JOIN pages AS p ON p.seq = f.rowid
         WHERE (f.title LIKE ?1 ESCAPE '\\' OR f.body LIKE ?1 ESCAPE '\\') AND p.deleted_at IS NULL
           AND (?6 = 0 OR p.visibility = 'public')
         ORDER BY in_title DESC, p.updated_at DESC, p.id DESC LIMIT ?3
       )
       ORDER BY in_title DESC, updated_at DESC, id DESC`,
    )
    .bind(pattern, query, limit, EXCERPT_CHARS, EXCERPT_LEAD_CHARS, publicOnly)
    .all<LikeRow>();
  const tags = await tagsByPage(
    db,
    results.map((row) => row.id),
  );
  return results.map((row) => {
    const head = row.start > 1 ? ELLIPSIS : "";
    const tail = row.start + EXCERPT_CHARS - 1 < row.length ? ELLIPSIS : "";
    return {
      ...toSummary(row),
      excerpt: `${head}${compact(row.excerpt)}${tail}`,
      tags: tags.get(row.id) ?? [],
    };
  });
}
