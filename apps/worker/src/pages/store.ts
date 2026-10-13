import { normalizeTitleKey, singleLineTitle } from "@personal-wiki/domain";
import { clearDerivedStatements, derivedStatements, deriveValues } from "./derived";
import { generatePageId } from "./id";
import { revisionStatements } from "./revisions";

/*
 * ページの書き込みは、すべて D1 の batch 1 回で行う。batch は 1 つのトランザクションで、途中の文が
 * 失敗すると先行する書き込みも戻る。D1 には対話的なトランザクションが無いので、版の照合は batch の
 * 先頭の guard 文で行い、版が合わなければ save_guard の trigger で batch 全体を失敗させる。
 *
 * 文の順序: guard、revision、派生データ、pages の UPDATE（最後）。
 * title_key の UNIQUE 違反は最後の UPDATE で起き、それまでの書き込みごと戻る。
 */

export type Visibility = "public" | "draft";

export interface Page {
  id: string;
  title: string;
  body: string;
  visibility: Visibility;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 本文の上限（UTF-8 のバイト数）。保存のたびに本文の Markdown を解析して派生データを作るので、
 * Workers Free の CPU 10ms で決める。dev の Mac（Node、warm）で解析を測った値:
 *   リンクと強調の多い本文: 28KB で 8.5ms、100KB で 24.8ms、286KB で 69ms、1MB で約 260〜300ms
 *   平文: 22KB で 3.4ms、219KB で 21ms
 * リンクの多い本文では 64KiB でも 10ms を超えうる。本番の CPU 時間を測ってから見直す。
 * D1 の 1 行 2MB（revisions の行は title と body を両方持つ）には、この上限なら十分収まる。
 */
export const MAX_BODY_BYTES = 65_536;

/**
 * title の上限（UTF-8 のバイト数）。title は一覧やリンクの解決で何度も読み書きし、title_key の
 * 索引にも入るので、本文と別に小さく抑える。
 */
export const MAX_TITLE_BYTES = 1024;

export type InputError =
  | { ok: false; reason: "invalid_title" }
  | { ok: false; reason: "title_too_long" }
  | { ok: false; reason: "body_too_large" };

export type WriteError =
  | InputError
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_conflict"; currentVersion: number }
  | { ok: false; reason: "title_conflict" };

export interface WriteSuccess {
  ok: true;
  page: Page;
  /** batch の各文の D1 meta.rows_written の合計。保存 1 回あたりの書き込み量の記録用 */
  rowsWritten: number;
}

const PAGE_COLUMNS = "id, title, body, visibility, version, created_at, updated_at";

interface PageRow {
  id: string;
  title: string;
  body: string;
  visibility: Visibility;
  version: number;
  created_at: number;
  updated_at: number;
}

function toPage(row: PageRow): Page {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    visibility: row.visibility,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 削除されていないページを id で引く。visibility では絞らず draft も返すので、token の読み取り用。
 * anonymous に返す経路では使わない。
 */
export async function findPageById(db: D1Database, id: string): Promise<Page | null> {
  const row = await db
    .prepare(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(id)
    .first<PageRow>();
  return row === null ? null : toPage(row);
}

/**
 * 削除されていないページを、title を title_key に正規化して引く。title_key にできない title は null。
 * findPageById と同じく visibility では絞らないので、token の読み取り用。
 */
export async function findPageByTitle(db: D1Database, title: string): Promise<Page | null> {
  const key = normalizeTitleKey(title);
  if (!key.ok) return null;
  const row = await db
    .prepare(`SELECT ${PAGE_COLUMNS} FROM pages WHERE title_key = ?1 AND deleted_at IS NULL`)
    .bind(key.value)
    .first<PageRow>();
  return row === null ? null : toPage(row);
}

interface PreparedContent {
  ok: true;
  title: string;
  titleKey: string;
  body: string;
}

function prepareContent(rawTitle: string, body: string): PreparedContent | InputError {
  const title = singleLineTitle(rawTitle);
  const key = normalizeTitleKey(title);
  if (!key.ok) return { ok: false, reason: "invalid_title" };
  const encoder = new TextEncoder();
  if (encoder.encode(title).length > MAX_TITLE_BYTES) {
    return { ok: false, reason: "title_too_long" };
  }
  if (encoder.encode(body).length > MAX_BODY_BYTES) {
    return { ok: false, reason: "body_too_large" };
  }
  return { ok: true, title, titleKey: key.value, body };
}

function guardStatement(db: D1Database, id: string, expectedVersion: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO save_guard (page_id) SELECT ?1 WHERE NOT EXISTS
         (SELECT 1 FROM pages WHERE id = ?1 AND version = ?2 AND deleted_at IS NULL)`,
    )
    .bind(id, expectedVersion);
}

function sumRowsWritten(results: D1Result[]): number {
  return results.reduce((sum, result) => sum + (result.meta.rows_written ?? 0), 0);
}

/** D1 は失敗した文の SQLite のメッセージを Error の message か cause に入れる。 */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : "";
  return `${error.message} ${cause}`;
}

const isVersionConflict = (error: unknown) => errorText(error).includes("version_conflict");
const isTitleConflict = (error: unknown) =>
  errorText(error).includes("UNIQUE constraint failed: pages.title_key");

/** guard で batch が失敗したあと、ページが無いのか版が違うのかを読み分ける。 */
async function notFoundOrConflict(db: D1Database, id: string): Promise<WriteError> {
  const row = await db
    .prepare("SELECT version FROM pages WHERE id = ?1 AND deleted_at IS NULL")
    .bind(id)
    .first<{ version: number }>();
  if (row === null) return { ok: false, reason: "not_found" };
  return { ok: false, reason: "version_conflict", currentVersion: row.version };
}

/**
 * batch の最後の文が RETURNING で返したページを取り出す。guard を通ったあとに pages の UPDATE が
 * 0 行になることは無いはずで、起きたら派生データだけが書かれている。409 にせず例外にして気づけるようにする
 * （本番で trigger の RAISE が効かない場合も、ここで検出される）。
 */
function returnedPage(results: D1Result[]): Page {
  const rows = results.at(-1)?.results as PageRow[] | undefined;
  const row = rows?.[0];
  if (rows?.length !== 1 || row === undefined) {
    throw new Error("pages の書き込みが 1 行にならなかった");
  }
  return toPage(row);
}

export interface CreatePageInput {
  title: string;
  body: string;
  actor: string;
  now: number;
}

/** visibility は受け取らず、常に draft で作る（公開できるのは owner だけ）。 */
export async function createPage(
  db: D1Database,
  input: CreatePageInput,
): Promise<WriteSuccess | WriteError> {
  const content = prepareContent(input.title, input.body);
  if (!content.ok) return content;
  const id = generatePageId();
  const statements = [
    db
      .prepare(
        `INSERT INTO pages (id, title, title_key, body, visibility, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'draft', 1, ?5, ?5)`,
      )
      .bind(id, content.title, content.titleKey, content.body, input.now),
    ...revisionStatements(db, {
      pageId: id,
      version: 1,
      title: content.title,
      body: content.body,
      actor: input.actor,
      now: input.now,
    }),
    ...derivedStatements(db, id, content.titleKey, deriveValues(content.title, content.body)),
    db.prepare(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?1`).bind(id),
  ];
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (isTitleConflict(error)) return { ok: false, reason: "title_conflict" };
    throw error;
  }
  return { ok: true, page: returnedPage(results), rowsWritten: sumRowsWritten(results) };
}

export interface UpdatePageInput {
  id: string;
  expectedVersion: number;
  title: string;
  body: string;
  actor: string;
  now: number;
}

/** title と body を置き換える。visibility は変えない。 */
export async function updatePage(
  db: D1Database,
  input: UpdatePageInput,
): Promise<WriteSuccess | WriteError> {
  const content = prepareContent(input.title, input.body);
  if (!content.ok) return content;
  const { id, expectedVersion } = input;
  const statements = [
    guardStatement(db, id, expectedVersion),
    ...revisionStatements(db, {
      pageId: id,
      version: expectedVersion + 1,
      title: content.title,
      body: content.body,
      actor: input.actor,
      now: input.now,
    }),
    ...derivedStatements(db, id, content.titleKey, deriveValues(content.title, content.body)),
    db
      .prepare(
        `UPDATE pages SET title = ?3, title_key = ?4, body = ?5, version = version + 1, updated_at = ?6
         WHERE id = ?1 AND version = ?2 AND deleted_at IS NULL
         RETURNING ${PAGE_COLUMNS}`,
      )
      .bind(id, expectedVersion, content.title, content.titleKey, content.body, input.now),
  ];
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (isVersionConflict(error)) return notFoundOrConflict(db, id);
    if (isTitleConflict(error)) return { ok: false, reason: "title_conflict" };
    throw error;
  }
  return { ok: true, page: returnedPage(results), rowsWritten: sumRowsWritten(results) };
}

/**
 * 追記の競合で読み直す回数の上限。D1 は 1 invocation あたりのクエリ数に上限（Free で 50）があり、
 * 1 回の試行で読み 2 文と batch の約 12 文を使う。
 */
export const APPEND_MAX_ATTEMPTS = 3;

export interface AppendInput {
  id: string;
  text: string;
  actor: string;
  now: number;
}

export type AppendError = WriteError | { ok: false; reason: "append_conflict" };

/**
 * 最新版の本文の末尾に text を足す。呼び出し側は版を知らなくてよい。
 * 保存は更新と同じ版の照合を通し、その間に別の保存が入ったら読み直して足し直す。
 */
export async function appendToPage(
  db: D1Database,
  input: AppendInput,
): Promise<(WriteSuccess & { attempts: number }) | AppendError> {
  for (let attempt = 1; attempt <= APPEND_MAX_ATTEMPTS; attempt++) {
    const current = await findPageById(db, input.id);
    if (current === null) return { ok: false, reason: "not_found" };
    const result = await updatePage(db, {
      id: input.id,
      expectedVersion: current.version,
      title: current.title,
      body: appendText(current.body, input.text),
      actor: input.actor,
      now: input.now,
    });
    if (result.ok) return { ...result, attempts: attempt };
    if (result.reason !== "version_conflict") return result;
  }
  return { ok: false, reason: "append_conflict" };
}

/**
 * 行の途中に続けないことだけを保証する。段落を分ける空行を入れるかは呼び出し側が決める
 * （リストの項目を足すときは空行を入れたくない）。
 */
export function appendText(body: string, text: string): string {
  if (body === "" || body.endsWith("\n")) return body + text;
  return `${body}\n${text}`;
}

export interface DeletePageInput {
  id: string;
  expectedVersion: number;
  now: number;
}

/**
 * 論理削除。行と revision は残し、派生データは消す（削除済みのページは backlink や検索に出さない）。
 * 版は進めない。削除済みのページへの書き込みは版に関係なく not_found になる。
 */
export async function deletePage(
  db: D1Database,
  input: DeletePageInput,
): Promise<{ ok: true; rowsWritten: number } | WriteError> {
  const { id, expectedVersion } = input;
  const statements = [
    guardStatement(db, id, expectedVersion),
    ...clearDerivedStatements(db, id),
    db
      .prepare(
        `UPDATE pages SET deleted_at = ?3, updated_at = ?3
         WHERE id = ?1 AND version = ?2 AND deleted_at IS NULL
         RETURNING ${PAGE_COLUMNS}`,
      )
      .bind(id, expectedVersion, input.now),
  ];
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (isVersionConflict(error)) return notFoundOrConflict(db, id);
    throw error;
  }
  returnedPage(results);
  return { ok: true, rowsWritten: sumRowsWritten(results) };
}

/**
 * 1 回の呼び出しで作り直すページ数の上限。上限近い本文 1 ページの解析だけで CPU 10ms に届きうる
 * （MAX_BODY_BYTES の計測値）ので、1 ページずつにする。
 */
export const REBUILD_MAX_LIMIT = 1;

export interface RebuildInput {
  /** 前回の呼び出しが返した next。最初は null */
  after: string | null;
  limit: number;
}

export interface RebuildResult {
  /** 作り直したページ（削除済みで派生データを消したものを含む） */
  rebuilt: number;
  /** 読んだあとに別の保存が入ったページ。その保存が新しい本文で派生データを書いている */
  skipped: number;
  /** 作り直しが例外で失敗したページの id。派生データはそのページの作り直し前のまま残る */
  failed: string[];
  /** 次の呼び出しに渡す cursor。null なら全ページを終えた */
  next: string | null;
  rowsWritten: number;
}

interface RebuildRow {
  id: string;
  title: string;
  title_key: string;
  body: string;
  version: number;
  deleted_at: number | null;
}

/**
 * 派生データを pages の title と body から作り直す。id 順に limit 件ずつ進むので、呼び出し側は
 * next が null になるまで繰り返す。版も revision も変えない。
 *
 * 1 ページの失敗で全体を止めないよう、版の競合以外の例外は failed に入れて cursor を進める。
 * ただし CPU の上限で invocation ごと打ち切られると例外として捕まえられず、応答も返らない。
 * そのときは同じ after で何度呼んでも同じページで止まるので、呼び出し側は after より後ろで最初の
 * id（`SELECT id FROM pages WHERE id > ? ORDER BY id LIMIT 1`）を after に渡して、そのページを飛ばす。
 */
export async function rebuildDerived(db: D1Database, input: RebuildInput): Promise<RebuildResult> {
  const { results: rows } = await db
    .prepare(
      `SELECT id, title, title_key, body, version, deleted_at FROM pages
       WHERE id > ?1 ORDER BY id LIMIT ?2`,
    )
    .bind(input.after ?? "", input.limit)
    .all<RebuildRow>();
  let rebuilt = 0;
  let skipped = 0;
  const failed: string[] = [];
  let rowsWritten = 0;
  for (const row of rows) {
    try {
      // 削除済みのページは書き込み経路が無く、版の照合は要らない
      const statements =
        row.deleted_at === null
          ? [
              guardStatement(db, row.id, row.version),
              ...derivedStatements(db, row.id, row.title_key, deriveValues(row.title, row.body)),
            ]
          : clearDerivedStatements(db, row.id);
      rowsWritten += sumRowsWritten(await db.batch(statements));
      rebuilt += 1;
    } catch (error) {
      if (isVersionConflict(error)) {
        skipped += 1;
        continue;
      }
      console.error(
        JSON.stringify({ event: "pages.rebuild_failed", pageId: row.id, error: errorText(error) }),
      );
      failed.push(row.id);
    }
  }
  const last = rows.at(-1);
  return {
    rebuilt,
    skipped,
    failed,
    next: rows.length === input.limit && last !== undefined ? last.id : null,
    rowsWritten,
  };
}
