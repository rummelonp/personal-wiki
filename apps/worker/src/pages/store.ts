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
 * D1 の 1 行の上限は 2MB で、revisions の行は title と body を両方持つ。UTF-8 のバイト数で数える。
 * 保存時の Markdown の解析も本文の長さに比例して CPU を使う。
 */
export const MAX_BODY_BYTES = 1_000_000;

export type InputError =
  | { ok: false; reason: "invalid_title" }
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

export async function findPageById(db: D1Database, id: string): Promise<Page | null> {
  const row = await db
    .prepare(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(id)
    .first<PageRow>();
  return row === null ? null : toPage(row);
}

/** title を title_key に正規化して引く。title_key にできない title は null。 */
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
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
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
