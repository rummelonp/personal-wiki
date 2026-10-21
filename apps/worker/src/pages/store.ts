import {
  type CharAt,
  checkPageInput,
  findNul,
  MAX_TITLE_BYTES,
  normalizeTitleKey,
  type PageInputProblem,
  utf8ByteLength,
  wikiLinkUnsafeChars,
} from "@personal-wiki/domain";
import type { ReadableVisibility } from "../auth/principal";
import { clearDerivedStatements, derivedStatements, deriveValues } from "./derived";
import { generatePageId } from "./id";
import { revisionStatements } from "./revisions";

/*
 * ページの書き込みは、すべて D1 の batch 1 回で行う。batch は 1 つのトランザクションで、途中の文が
 * 失敗すると先行する書き込みも戻る。D1 には対話的なトランザクションが無いので、版の照合は batch の
 * 先頭の guard 文で行い、版が合わなければ save_guard の trigger で batch 全体を失敗させる。
 *
 * 文の順序: guard、（updatePage では）リンクの書き換えのキューへの追加、revision、派生データ、pages の UPDATE（最後）。
 * title_key の UNIQUE 違反は最後の UPDATE で起き、それまでの書き込みごと戻る。
 */

export type Visibility = "public" | "draft";

/** SQL の `(?n = 0 OR visibility = 'public')` に bind する値。 */
export function publicOnlyFlag(readable: ReadableVisibility): 0 | 1 {
  return readable === "public" ? 1 : 0;
}

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
 * 入力のエラー。上限と位置は domain の checkPageInput の値をそのまま持つ。追記ではエラーを追記した text に
 * 結びつけ、本文の超過には追記前の本文のバイト数も添える（どれだけ短くすればよいかを呼び出し元が決められる）。
 */
export type InputError =
  | { ok: false; reason: "invalid_title" }
  | { ok: false; reason: "control_char"; field: "title" | "body" | "text"; at: CharAt }
  | { ok: false; reason: "title_too_long"; bytes: number; max: number }
  | { ok: false; reason: "body_too_large"; field: "body"; bytes: number; max: number }
  | {
      ok: false;
      reason: "body_too_large";
      field: "text";
      bytes: number;
      currentBytes: number;
      max: number;
    };

export type WriteError =
  | InputError
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_conflict"; currentVersion: number }
  | {
      ok: false;
      reason: "title_conflict";
      /** 重なった既存のページ。書いた主体が読めるときだけ operations が添える */
      existing?: ResolvedPage;
    };

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
 * 削除されていないページを id で引く。readable が public なら draft は null（無いページと区別できない
 * ようにする）。
 */
export async function findPageById(
  db: D1Database,
  id: string,
  readable: ReadableVisibility,
): Promise<Page | null> {
  const row = await db
    .prepare(
      `SELECT ${PAGE_COLUMNS} FROM pages
       WHERE id = ?1 AND deleted_at IS NULL AND (?2 = 0 OR visibility = 'public')`,
    )
    .bind(id, publicOnlyFlag(readable))
    .first<PageRow>();
  return row === null ? null : toPage(row);
}

/**
 * 削除されていないページが id にあるかを返す。visibility では絞らないので、draft を読める principal の
 * 経路（MCP）だけで使う。本文を読まないので、存在だけを確かめたいときに使う。
 */
export async function pageExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM pages WHERE id = ?1 AND deleted_at IS NULL")
    .bind(id)
    .first();
  return row !== null;
}

/**
 * 削除されていないページを、title を title_key に正規化して引く。title_key にできない title は null。
 * readable が public なら draft は null（無いページと区別できないようにする）。
 */
export async function findPageByTitle(
  db: D1Database,
  title: string,
  readable: ReadableVisibility,
): Promise<Page | null> {
  const key = normalizeTitleKey(title);
  if (!key.ok) return null;
  const row = await db
    .prepare(
      `SELECT ${PAGE_COLUMNS} FROM pages
       WHERE title_key = ?1 AND deleted_at IS NULL AND (?2 = 0 OR visibility = 'public')`,
    )
    .bind(key.value, publicOnlyFlag(readable))
    .first<PageRow>();
  return row === null ? null : toPage(row);
}

export interface ResolvedPage {
  id: string;
  title: string;
  visibility: Visibility;
}

/**
 * 複数の title を 1 回のクエリで引き、入力と同じ順、同じ件数で返す。重複や、正規化で同じになる
 * title も入力ごとに答える。MAX_TITLE_BYTES を超える title、title_key にできない title、削除済み、
 * readable の外にあるページは null。readable が public なら draft は null（無いページと区別できない
 * ようにする）。
 * pages を直接引き、links の target_page_id は使わない。保存前の本文のリンクも解決するので、
 * links に行があるとは限らない。
 */
export async function resolvePagesByTitle(
  db: D1Database,
  titles: readonly string[],
  readable: ReadableVisibility,
): Promise<(ResolvedPage | null)[]> {
  const keys = titles.map((title) => {
    // 保存できる title の上限を超える入力は解決しない。空白を詰めれば一致する入力もありうるが、
    // 正規化（NFKC）の前に除いて長い入力に CPU を使わせない方を採る。UTF-16 の長さは UTF-8 の
    // バイト数以下なので、先にそれで弾けば長い入力を数える手間も省ける
    if (title.length > MAX_TITLE_BYTES || utf8ByteLength(title) > MAX_TITLE_BYTES) {
      return null;
    }
    const key = normalizeTitleKey(title);
    return key.ok ? key.value : null;
  });
  const distinct = [...new Set(keys.filter((key) => key !== null))];
  const found = new Map<string, ResolvedPage>();
  if (distinct.length > 0) {
    const { results } = await db
      .prepare(
        `SELECT id, title, title_key, visibility FROM pages
         WHERE title_key IN (SELECT value FROM json_each(?1))
           AND deleted_at IS NULL AND (?2 = 0 OR visibility = 'public')`,
      )
      .bind(JSON.stringify(distinct), publicOnlyFlag(readable))
      .all<ResolvedPage & { title_key: string }>();
    for (const { id, title, title_key, visibility } of results) {
      found.set(title_key, { id, title, visibility });
    }
  }
  return keys.map((key) => (key === null ? null : (found.get(key) ?? null)));
}

interface PreparedContent {
  ok: true;
  title: string;
  titleKey: string;
  body: string;
}

function inputErrorOf(problem: PageInputProblem): InputError {
  return problem.reason === "body_too_large"
    ? { ok: false, ...problem, field: "body" }
    : { ok: false, ...problem };
}

/**
 * 保存する title と本文を整え、規則に合うか調べる。エラーは checkPageInput の先頭の 1 件を返す。
 * checkControlChars の意味は checkPageInput と同じで、追記だけが false を渡す。
 */
function prepareContent(
  rawTitle: string,
  body: string,
  options: { checkControlChars: boolean },
): PreparedContent | InputError {
  const check = checkPageInput(rawTitle, body, options);
  const [problem] = check.problems;
  if (problem !== undefined) return inputErrorOf(problem);
  if (check.titleKey === null) return { ok: false, reason: "invalid_title" };
  return { ok: true, title: check.title, titleKey: check.titleKey, body };
}

export function guardStatement(
  db: D1Database,
  id: string,
  expectedVersion: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO save_guard (page_id) SELECT ?1 WHERE NOT EXISTS
         (SELECT 1 FROM pages WHERE id = ?1 AND version = ?2 AND deleted_at IS NULL)`,
    )
    .bind(id, expectedVersion);
}

export function sumRowsWritten(results: D1Result[]): number {
  return results.reduce((sum, result) => sum + (result.meta.rows_written ?? 0), 0);
}

/** D1 は失敗した文の SQLite のメッセージを Error の message か cause に入れる。 */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : "";
  return `${error.message} ${cause}`;
}

export const isVersionConflict = (error: unknown) => errorText(error).includes("version_conflict");
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
  const content = prepareContent(input.title, input.body, { checkControlChars: true });
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
    ...derivedStatements(db, id, content.titleKey, await deriveValues(content.title, content.body)),
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
  /** revisions.ts の RevisionInput.mergeOwnerSaves */
  mergeOwnerSaves: boolean;
}

export interface LinkRewritesQueued {
  /** 書き換えをキューに入れたリンク元の数（自ページを含む） */
  queued: number;
  /**
   * 新しい title が WikiLink の target に書けない（wikiLinkUnsafeChars）のでキューに入れなかった。
   * 旧 title へのリンクが他のページに残っているときだけ付く
   */
  skipped?: "unsafe_title";
}

export interface UpdateSuccess extends WriteSuccess {
  linkRewrites: LinkRewritesQueued;
}

/*
 * title_key が変わる保存で、旧 title_key のまま自分を指している links のリンク元。guard が版を照合した
 * あとで、pages の UPDATE より前に読むので、p は保存前の行になる。title が変わらない保存では
 * p.title_key = ?2 で 0 行になる。大文字小文字だけの変更も title_key が同じなのでキューに入れない。
 * 派生データの文がこの links の target_page_id を外すので、それより前に置く。
 */
const LINK_REWRITE_SOURCES = `FROM links AS l JOIN pages AS p ON p.id = ?1
  WHERE l.target_page_id = ?1 AND l.target_title_key = p.title_key AND p.title_key <> ?2`;

/**
 * 書き換えを link_rewrites のキューに入れる文。新しい title がリンクに書けないときはキューに入れずに、残るリンクの
 * 有無だけを数える（title を変えていない保存で skipped を返さないため）。
 *
 * 同じ行が残っていればキューに入れ直す（created_at と actor を新しくし、試行回数を数え直す）。step は読んだ
 * created_at の行だけを消すので、step が読んでから消すまでの間にキューに入れ直された行は残り、次の step が
 * 今の title で処理する。
 */
function linkRewritesStatement(
  db: D1Database,
  input: { id: string; title: string; titleKey: string; actor: string; now: number },
): { statement: D1PreparedStatement; unsafe: boolean } {
  if (wikiLinkUnsafeChars(input.title).length > 0) {
    return {
      statement: db
        .prepare(`SELECT count(*) AS n ${LINK_REWRITE_SOURCES}`)
        .bind(input.id, input.titleKey),
      unsafe: true,
    };
  }
  return {
    statement: db
      .prepare(
        `INSERT INTO link_rewrites
           (source_page_id, target_page_id, old_title_key, actor, created_at)
         SELECT l.source_page_id, ?1, l.target_title_key, ?3, ?4 ${LINK_REWRITE_SOURCES}
         ON CONFLICT (source_page_id, target_page_id, old_title_key) DO UPDATE
           SET created_at = excluded.created_at, actor = excluded.actor, attempts = 0`,
      )
      .bind(input.id, input.titleKey, input.actor, input.now),
    unsafe: false,
  };
}

function linkRewritesOf(result: D1Result, unsafe: boolean): LinkRewritesQueued {
  if (!unsafe) return { queued: result.meta.changes ?? 0 };
  const count = (result.results as { n: number }[])[0]?.n ?? 0;
  return count > 0 ? { queued: 0, skipped: "unsafe_title" } : { queued: 0 };
}

/** 版の照合で batch が戻った。ページが無いのか版が違うのかは、まだ読み分けていない */
const GUARD_REJECTED = Symbol("guard_rejected");

/**
 * title と body を置き換える batch を送る。queueLinkRewrites が false ならキューへの追加の文を入れない
 * （title を変えない追記で、1 回あたりのクエリを減らす）。
 */
async function writeContent(
  db: D1Database,
  input: UpdatePageInput,
  content: PreparedContent,
  queueLinkRewrites: boolean,
): Promise<UpdateSuccess | typeof GUARD_REJECTED | { ok: false; reason: "title_conflict" }> {
  const { id, expectedVersion } = input;
  const linkRewrites = queueLinkRewrites
    ? linkRewritesStatement(db, {
        id,
        title: content.title,
        titleKey: content.titleKey,
        actor: input.actor,
        now: input.now,
      })
    : null;
  const statements = [
    guardStatement(db, id, expectedVersion),
    // 派生データの文より前に置く（LINK_REWRITE_SOURCES）
    ...(linkRewrites === null ? [] : [linkRewrites.statement]),
    ...revisionStatements(db, {
      pageId: id,
      version: expectedVersion + 1,
      title: content.title,
      body: content.body,
      actor: input.actor,
      now: input.now,
      mergeOwnerSaves: input.mergeOwnerSaves,
    }),
    ...derivedStatements(db, id, content.titleKey, await deriveValues(content.title, content.body)),
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
    if (isVersionConflict(error)) return GUARD_REJECTED;
    if (isTitleConflict(error)) return { ok: false, reason: "title_conflict" };
    throw error;
  }
  return {
    ok: true,
    page: returnedPage(results),
    rowsWritten: sumRowsWritten(results),
    // キューへの追加の文は guard の直後（results[1]）
    linkRewrites:
      linkRewrites === null
        ? { queued: 0 }
        : linkRewritesOf(results[1] as D1Result, linkRewrites.unsafe),
  };
}

/**
 * title と body を置き換える。visibility は変えない。
 * title_key が変わるときは、旧 title へのリンクの書き換えを link_rewrites のキューに入れる（書き換えるのは
 * link-rewrites.ts の step）。
 */
export async function updatePage(
  db: D1Database,
  input: UpdatePageInput,
): Promise<UpdateSuccess | WriteError> {
  const content = prepareContent(input.title, input.body, { checkControlChars: true });
  if (!content.ok) return content;
  const result = await writeContent(db, input, content, true);
  return result === GUARD_REJECTED ? notFoundOrConflict(db, input.id) : result;
}

/**
 * 追記の競合で読み直す回数の上限。D1 は 1 invocation あたりのクエリ数に上限（Free で 50）があり、
 * 1 回の試行で読み 1 文と batch の 14 文（owner は revision をまとめる文を足して 15 文）を使う
 * （query-budget.test.ts で数えている）。
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
 * title は変えないので、リンクの書き換えはキューに入れない。
 *
 * 照合で戻ったときに、無いのか版が違うのかを読み分けない（次の試行の読み込みが not_found を返す）。
 * そのため最後の試行の間に削除されたページは、not_found ではなく append_conflict になる。
 */
export async function appendToPage(
  db: D1Database,
  input: AppendInput,
): Promise<(UpdateSuccess & { attempts: number }) | AppendError> {
  const nul = findNul(input.text);
  if (nul !== null) return { ok: false, reason: "control_char", field: "text", at: nul };
  for (let attempt = 1; attempt <= APPEND_MAX_ATTEMPTS; attempt++) {
    const current = await findPageById(db, input.id, "all");
    if (current === null) return { ok: false, reason: "not_found" };
    const update = {
      id: input.id,
      expectedVersion: current.version,
      title: current.title,
      body: appendText(current.body, input.text),
      actor: input.actor,
      now: input.now,
      mergeOwnerSaves: true,
    };
    const content = prepareContent(update.title, update.body, { checkControlChars: false });
    if (!content.ok) {
      return content.reason === "body_too_large"
        ? { ...content, field: "text", currentBytes: utf8ByteLength(current.body) }
        : content;
    }
    const result = await writeContent(db, update, content, false);
    if (result === GUARD_REJECTED) continue;
    if (result.ok) return { ...result, attempts: attempt };
    return result;
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
  actor: string;
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
        `UPDATE pages SET deleted_at = ?3, deleted_by = ?4, updated_at = ?3
         WHERE id = ?1 AND version = ?2 AND deleted_at IS NULL
         RETURNING ${PAGE_COLUMNS}`,
      )
      .bind(id, expectedVersion, input.now, input.actor),
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

export interface SetVisibilityInput {
  id: string;
  visibility: Visibility;
  /** 指定されたときだけ今の版と照合し、違えば version_conflict にする */
  expectedVersion?: number;
  now: number;
}

/**
 * visibility を変える。版の照合は任意にする（本文を書き換えないので、他の保存と競合しても失うものが無い）。
 * 照合を指定できるのは、owner が確かめた版と違う本文を公開しないよう UI 側で防げるようにするため。
 *
 * 変えたときは版を 1 つ進め、updated_at も更新する。visibility を変える前に読んだ版で本文を
 * 書き換えようとした呼び出し元（draft のつもりの AI など）が、409 で読み直して公開範囲に気づけるように
 * するため。revision は積まない（revision は title と本文の履歴で、どちらも変わっていない）。
 * 版と revision の版が 1 対 1 でなくなるが、owner の連続保存をまとめる（revisions.ts）ときも同じく欠番が出る。
 * すでに同じ visibility なら何も書かずに今のページを返す。
 */
export async function setVisibility(
  db: D1Database,
  input: SetVisibilityInput,
): Promise<
  | WriteSuccess
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_conflict"; currentVersion: number }
> {
  const result = await db
    .prepare(
      `UPDATE pages SET visibility = ?2, version = version + 1, updated_at = ?3
       WHERE id = ?1 AND deleted_at IS NULL AND visibility != ?2 AND (?4 IS NULL OR version = ?4)
       RETURNING ${PAGE_COLUMNS}`,
    )
    .bind(input.id, input.visibility, input.now, input.expectedVersion ?? null)
    .all<PageRow>();
  const row = result.results[0];
  if (row !== undefined) {
    return { ok: true, page: toPage(row), rowsWritten: result.meta.rows_written ?? 0 };
  }
  const current = await findPageById(db, input.id, "all");
  if (current === null) return { ok: false, reason: "not_found" };
  if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
    return { ok: false, reason: "version_conflict", currentVersion: current.version };
  }
  return { ok: true, page: current, rowsWritten: 0 };
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
 * ただし CPU の上限で invocation ごと打ち切られると例外として捕まえられず、レスポンスも返らない。
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
              ...derivedStatements(
                db,
                row.id,
                row.title_key,
                await deriveValues(row.title, row.body),
              ),
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
