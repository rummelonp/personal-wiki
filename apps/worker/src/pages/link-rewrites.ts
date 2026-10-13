import { wikiLinkUnsafeChars } from "@personal-wiki/domain";
import { rewriteWikiLinkTargets } from "@personal-wiki/markdown";
import { derivedStatements, deriveValues } from "./derived";
import { revisionStatements } from "./revisions";
import {
  guardStatement,
  isVersionConflict,
  MAX_BODY_BYTES,
  sumRowsWritten,
  type Visibility,
} from "./store";

/*
 * title の変更で積んだ書き換え（link_rewrites）を、1 回の呼び出しで 1 ページずつ本文に反映する。
 * rename の batch の中で書き換えないのは、リンク元の数だけ本文の解析と書き込みが要り、D1 の
 * 1 invocation 50 クエリと CPU 10ms に収まらないため。
 *
 * 書き換え先は処理する時点の対象ページの title で、links が今どこへ解決しているかは見ない。
 * A → B → C と続けて改名しても、旧 key a のリンクは C に 1 回で書き換わる。旧 title で別のページが
 * 作られていても、積んだ時点の対象ページの title に書き換える。
 */

export interface LinkRewriteStepInput {
  /** 指定すると、このページを対象とする書き換えが残っているリンク元から選ぶ */
  targetPageId: string | null;
  now: number;
}

export interface LinkRewriteStepResult {
  /** 本文を書き換えたリンク元。書き換えずに積んだ分を捨てたときも null */
  processed: {
    sourcePageId: string;
    title: string;
    visibility: Visibility;
    /** 書き換えたリンクの数 */
    rewritten: number;
  } | null;
  /** 読んだあとにリンク元が保存された。積んだ分は残るので、もう一度呼べば読み直して進む */
  conflict: boolean;
  /**
   * 書き換えると本文のリンクやタグが意図せず変わる、または本文の上限を超えるので書かなかったリンク元。
   * 同じ本文と title なら何度試しても同じ結果になるので、積んだ分は捨てる（本文には旧 title のリンクが残る）
   */
  failed: string[];
  /** 処理を待つリンク元の数（targetPageId を指定したときは、その対象の分だけ） */
  remaining: number;
  rowsWritten: number;
}

export interface LinkRewriteStep {
  result: LinkRewriteStepResult;
  /** 本文を書き換えたときの revision の actor。書き換えなかったときは null */
  actor: string | null;
}

interface JobRow {
  target_page_id: string;
  old_title_key: string;
  actor: string;
  created_at: number;
  /** 以下は対象ページの今の値。対象ページの行が無ければ null */
  title: string | null;
  title_key: string | null;
  deleted_at: number | null;
}

interface SourceRow {
  id: string;
  title: string;
  title_key: string;
  body: string;
  visibility: Visibility;
  version: number;
  deleted_at: number | null;
}

interface Rename {
  title: string;
  titleKey: string;
}

/** 読んだ分だけを消す。読んだあとに積まれた分を、処理しないまま消さないようにする */
function deleteJobsStatement(db: D1Database, sourcePageId: string, jobs: JobRow[]) {
  return db
    .prepare(
      `DELETE FROM link_rewrites WHERE source_page_id = ?1 AND EXISTS (
         SELECT 1 FROM json_each(?2) AS j
         WHERE j.value ->> '$[0]' = target_page_id AND j.value ->> '$[1]' = old_title_key)`,
    )
    .bind(sourcePageId, JSON.stringify(jobs.map((job) => [job.target_page_id, job.old_title_key])));
}

async function countRemaining(db: D1Database, targetPageId: string | null): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(DISTINCT source_page_id) AS n FROM link_rewrites
       WHERE ?1 IS NULL OR target_page_id = ?1`,
    )
    .bind(targetPageId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * 書き換え先が決まる分を、旧 key から新しい title への対応にする。対象ページが削除済み、title を
 * 元に戻した、今の title がリンクに書けない分は対応に入れない（捨てる）。
 * 同じ旧 key に複数の対象があれば、先に積んだ方を採る。本文の旧 key のリンクはそれで消えるので、
 * 後の分は書き換えるものが無くなる。
 */
function renamesOf(jobs: JobRow[]): { renames: Map<string, Rename>; actor: string | null } {
  const renames = new Map<string, Rename>();
  let actor: string | null = null;
  for (const job of jobs) {
    if (job.title === null || job.title_key === null || job.deleted_at !== null) continue;
    if (job.title_key === job.old_title_key || renames.has(job.old_title_key)) continue;
    if (wikiLinkUnsafeChars(job.title).length > 0) continue;
    renames.set(job.old_title_key, { title: job.title, titleKey: job.title_key });
    // jobs は積んだ順なので、最後に積んだ rename の actor になる
    actor = job.actor;
  }
  return { renames, actor };
}

/**
 * 書き換えで変わってよいのは、旧 key のリンクが新しい key になることだけ。新しい title の文字
 * （`` ` `` など）で前後の構文が組み変わると、他のリンクやタグも変わるので、それを検出する。
 * 書き換え前の値は本文を解析し直さず、派生データの表から読む（解析を 1 回減らして CPU を抑える）。
 */
function unexpectedChange(
  before: { links: Set<string>; tags: Set<string> },
  after: { links: string[]; tags: string[] },
  renames: Map<string, Rename>,
): boolean {
  const expected = new Set<string>();
  for (const key of before.links) {
    const rename = renames.get(key);
    expected.add(rename === undefined ? key : rename.titleKey);
  }
  const sameSet = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every((key) => b.has(key));
  return !sameSet(expected, new Set(after.links)) || !sameSet(before.tags, new Set(after.tags));
}

async function readDerivedKeys(db: D1Database, pageId: string) {
  const { results } = await db
    .prepare(
      `SELECT 'link' AS kind, target_title_key AS key FROM links WHERE source_page_id = ?1
       UNION ALL SELECT 'tag', tag_key FROM tags WHERE page_id = ?1`,
    )
    .bind(pageId)
    .all<{ kind: "link" | "tag"; key: string }>();
  const links = new Set<string>();
  const tags = new Set<string>();
  for (const { kind, key } of results) (kind === "link" ? links : tags).add(key);
  return { links, tags };
}

/**
 * 積んだ書き換えを 1 ページ分進める。リンク元を 1 件選び、そのリンク元に積まれた分を（targetPageId に
 * 関係なく）まとめて 1 つの revision で書き換える。呼び出し側は remaining が 0 になるまで繰り返す。
 */
export async function stepLinkRewrites(
  db: D1Database,
  input: LinkRewriteStepInput,
): Promise<LinkRewriteStep> {
  const { targetPageId } = input;
  const next = await db
    .prepare(
      `SELECT source_page_id FROM link_rewrites WHERE ?1 IS NULL OR target_page_id = ?1
       ORDER BY created_at, source_page_id LIMIT 1`,
    )
    .bind(targetPageId)
    .first<{ source_page_id: string }>();
  const idle = { processed: null, conflict: false, failed: [] as string[], rowsWritten: 0 };
  if (next === null) return { result: { ...idle, remaining: 0 }, actor: null };
  const sourcePageId = next.source_page_id;

  const { results: jobs } = await db
    .prepare(
      `SELECT r.target_page_id, r.old_title_key, r.actor, r.created_at,
         t.title, t.title_key, t.deleted_at
       FROM link_rewrites AS r LEFT JOIN pages AS t ON t.id = r.target_page_id
       WHERE r.source_page_id = ?1
       ORDER BY r.created_at, r.target_page_id, r.old_title_key`,
    )
    .bind(sourcePageId)
    .all<JobRow>();
  const source = await db
    .prepare(
      "SELECT id, title, title_key, body, visibility, version, deleted_at FROM pages WHERE id = ?1",
    )
    .bind(sourcePageId)
    .first<SourceRow>();

  /** 書き込まずに積んだ分を捨てる */
  const discard = async (failed: string[]) => {
    const deleted = await deleteJobsStatement(db, sourcePageId, jobs).run();
    return {
      result: {
        ...idle,
        failed,
        remaining: await countRemaining(db, targetPageId),
        rowsWritten: deleted.meta.rows_written ?? 0,
      },
      actor: null,
    };
  };

  if (source === null || source.deleted_at !== null) return discard([]);
  const { renames, actor } = renamesOf(jobs);
  if (renames.size === 0 || actor === null) return discard([]);
  const rewrite = rewriteWikiLinkTargets(
    source.body,
    new Map([...renames].map(([key, rename]) => [key, rename.title])),
  );
  if (rewrite.rewritten === 0) return discard([]);

  const fail = (reason: string) => {
    console.error(JSON.stringify({ event: "link_rewrites.failed", sourcePageId, reason }));
    return discard([sourcePageId]);
  };
  if (new TextEncoder().encode(rewrite.body).length > MAX_BODY_BYTES) {
    return fail("body_too_large");
  }
  const values = deriveValues(source.title, rewrite.body);
  const after = {
    links: JSON.parse(values.linksJson) as string[],
    tags: (JSON.parse(values.tagsJson) as { key: string }[]).map((tag) => tag.key),
  };
  if (unexpectedChange(await readDerivedKeys(db, sourcePageId), after, renames)) {
    return fail("unexpected_derived_change");
  }

  const statements = [
    guardStatement(db, source.id, source.version),
    ...revisionStatements(db, {
      pageId: source.id,
      version: source.version + 1,
      title: source.title,
      body: rewrite.body,
      actor,
      now: input.now,
    }),
    ...derivedStatements(db, source.id, source.title_key, values),
    db
      .prepare(
        `UPDATE pages SET body = ?3, version = version + 1, updated_at = ?4
         WHERE id = ?1 AND version = ?2 AND deleted_at IS NULL`,
      )
      .bind(source.id, source.version, rewrite.body, input.now),
    deleteJobsStatement(db, sourcePageId, jobs),
  ];
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    // それ以外の失敗は積んだ分を残して 500 にする。一時的な D1 の失敗で書き換えを失わないため
    if (!isVersionConflict(error)) throw error;
    return {
      result: { ...idle, conflict: true, remaining: await countRemaining(db, targetPageId) },
      actor: null,
    };
  }
  // guard を通ったあとに UPDATE が 0 行なら、派生データだけが書かれている（store.ts の returnedPage と同じ）
  if (results.at(-2)?.meta.changes !== 1) throw new Error("pages の書き込みが 1 行にならなかった");
  return {
    result: {
      processed: {
        sourcePageId,
        title: source.title,
        visibility: source.visibility,
        rewritten: rewrite.rewritten,
      },
      conflict: false,
      failed: [],
      remaining: await countRemaining(db, targetPageId),
      rowsWritten: sumRowsWritten(results),
    },
    actor,
  };
}
