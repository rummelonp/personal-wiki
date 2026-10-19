import { MAX_BODY_BYTES, utf8ByteLength, wikiLinkUnsafeChars } from "@personal-wiki/domain";
import { rewriteWikiLinkTargets } from "@personal-wiki/markdown";
import { type DerivedValues, derivedStatements, deriveValues } from "./derived";
import { revisionStatements } from "./revisions";
import { guardStatement, isVersionConflict, sumRowsWritten, type Visibility } from "./store";

/*
 * title の変更でキューに入れた書き換え（link_rewrites）を、1 回の呼び出しで 1 ページずつ本文に反映する。
 * rename の batch の中で書き換えないのは、リンク元の数だけ本文の解析と書き込みが要り、D1 の
 * 1 invocation 50 クエリと CPU 10ms に収まらないため。
 *
 * 書き換え先は処理する時点の対象ページの title で、links が今どこへ解決しているかは見ない。
 * A → B → C と続けて改名しても、旧 key a のリンクは C に 1 回で書き換わる。旧 title で別のページが
 * 作られていても、rename のあとに新しく書いた `[[旧 title]]` も、キューに入れた対象ページの title に書き換える。
 *
 * 読んだ状態で判断して書く（または捨てる）ので、その batch では読んだときの状態を guard で確かめる。
 * リンク元の版と、対象ページの title_key（と削除されていないこと）のどちらかが変わっていれば、
 * キューのジョブを残して conflict を返す。対象を読んだあとに改名されると、rename の batch は旧 key の
 * links から対象が外れているのでキューに入れ直せず、ここで古い title を書くと誰も指さないリンクが残る。
 */

/** このリンク元を処理しようとした回数の上限。超えたら解析せずに failed として捨てる */
export const LINK_REWRITE_MAX_ATTEMPTS = 3;

export interface LinkRewriteStepInput {
  /** 指定すると、このページを対象とする書き換えが残っているリンク元から選ぶ */
  targetPageId: string | null;
  now: number;
  /**
   * リンク元を選んだ直後に呼ぶ。以降の処理が例外で終わったとき、呼び出し側がどのリンク元だったかを
   * ログに残せる（例外の型は変えない）。追加のクエリは使わない
   */
  onPicked?: (sourcePageId: string) => void;
}

export interface LinkRewriteStepResult {
  /** 本文を書き換えたリンク元。書き換えずにキューのジョブを捨てたときも null */
  processed: {
    sourcePageId: string;
    title: string;
    visibility: Visibility;
    /** 書き換えたあとの版 */
    version: number;
    /** 書き換えたリンクの数 */
    rewritten: number;
  } | null;
  /**
   * 読んだあとにリンク元が保存されたか、対象ページが改名されたか削除された。キューのジョブは残るので、
   * もう一度呼べば読み直して進む
   */
  conflict: boolean;
  /**
   * 書き換えると本文のリンクやタグが意図せず変わる、本文の上限を超える、または処理が
   * LINK_REWRITE_MAX_ATTEMPTS 回続けて終わらなかったので書かなかったリンク元。
   * 同じ本文と title なら何度試しても同じ結果になるので、キューのジョブは捨てる（本文には旧 title のリンクが残る）
   */
  failed: string[];
  /**
   * failed と同じリンク元を、画面に出す title と組にしたもの。failed は形を変えない（スクリプトが
   * 文字列の配列として読む）ので、別の項目にする。title は、ページを読む前に捨てた（試行の上限）ときは null
   */
  failedPages: FailedLinkRewrite[];
  /** 処理を待つリンク元の数（targetPageId を指定したときは、その対象の分だけ） */
  remaining: number;
  rowsWritten: number;
}

export interface FailedLinkRewrite {
  id: string;
  title: string | null;
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
  attempts: number;
}

interface PageRow {
  id: string;
  title: string;
  title_key: string;
  /** リンク元の行だけ読む */
  body: string | null;
  visibility: Visibility;
  version: number;
  deleted_at: number | null;
}

interface Rename {
  title: string;
  titleKey: string;
}

/**
 * 読んだ分だけを消す。created_at も照らすので、読んだあとにキューに入れ直された行は消えずに残る。
 */
function deleteJobsStatement(db: D1Database, sourcePageId: string, jobs: JobRow[]) {
  return db
    .prepare(
      `DELETE FROM link_rewrites WHERE source_page_id = ?1 AND EXISTS (
         SELECT 1 FROM json_each(?2) AS j
         WHERE j.value ->> '$[0]' = target_page_id AND j.value ->> '$[1]' = old_title_key
           AND j.value ->> '$[2]' = created_at)`,
    )
    .bind(
      sourcePageId,
      JSON.stringify(jobs.map((job) => [job.target_page_id, job.old_title_key, job.created_at])),
    );
}

/**
 * 対象ページが読んだときの title_key のまま、削除されていないことを確かめる guard。違えば save_guard の
 * trigger が batch 全体を version_conflict で戻す。読んだ時点で削除済みの対象や行の無い対象は戻らない
 * （削除を取り消す経路が無い）ので確かめない。
 */
function targetsGuardStatement(db: D1Database, targets: PageRow[]) {
  return db
    .prepare(
      `INSERT INTO save_guard (page_id)
       SELECT j.value ->> '$[0]' FROM json_each(?1) AS j
       WHERE NOT EXISTS (SELECT 1 FROM pages AS p
         WHERE p.id = j.value ->> '$[0]' AND p.title_key = j.value ->> '$[1]' AND p.deleted_at IS NULL)`,
    )
    .bind(
      JSON.stringify(
        targets.filter((t) => t.deleted_at === null).map((target) => [target.id, target.title_key]),
      ),
    );
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
 * 同じ旧 key に複数の対象があれば、先にキューに入れた方を採る。本文の旧 key のリンクはそれで消えるので、
 * 後の分は書き換えるものが無くなる。
 */
function renamesOf(
  jobs: JobRow[],
  targets: Map<string, PageRow>,
): { renames: Map<string, Rename>; actor: string | null } {
  const renames = new Map<string, Rename>();
  let actor: string | null = null;
  for (const job of jobs) {
    const target = targets.get(job.target_page_id);
    if (target === undefined || target.deleted_at !== null) continue;
    if (target.title_key === job.old_title_key || renames.has(job.old_title_key)) continue;
    if (wikiLinkUnsafeChars(target.title).length > 0) continue;
    renames.set(job.old_title_key, { title: target.title, titleKey: target.title_key });
    // jobs はキューに入れた順なので、最後にキューに入れた（キューに入れ直した）rename の actor になる
    actor = job.actor;
  }
  return { renames, actor };
}

interface DerivedKeys {
  links: Set<string>;
  tags: Set<string>;
}

function keysOf(values: DerivedValues): DerivedKeys {
  return {
    links: new Set(JSON.parse(values.linksJson) as string[]),
    tags: new Set((JSON.parse(values.tagsJson) as { key: string }[]).map((tag) => tag.key)),
  };
}

/**
 * 書き換えで変わってよいのは、旧 key のリンクが新しい key になることだけ。新しい title の文字
 * （`` ` `` など）で前後の構文が組み変わると、他のリンクやタグも変わるので、それを検出する。
 */
function unexpectedChange(
  before: DerivedKeys,
  after: DerivedKeys,
  renames: Map<string, Rename>,
): boolean {
  const expected = new Set<string>();
  for (const key of before.links) {
    const rename = renames.get(key);
    expected.add(rename === undefined ? key : rename.titleKey);
  }
  const sameSet = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every((key) => b.has(key));
  return !sameSet(expected, after.links) || !sameSet(before.tags, after.tags);
}

async function readDerivedKeys(db: D1Database, pageId: string): Promise<DerivedKeys> {
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
 * キューに入れた書き換えを 1 ページ分進める。リンク元を 1 件選び、そのリンク元のジョブを（targetPageId に
 * 関係なく）まとめて 1 つの revision で書き換える。呼び出し側は remaining が 0 になるまで繰り返す。
 */
export async function stepLinkRewrites(
  db: D1Database,
  input: LinkRewriteStepInput,
): Promise<LinkRewriteStep> {
  const { targetPageId } = input;
  // 選ぶのと試行回数を数えるのを 1 文で行い、解析より前に確定させる。CPU の上限で invocation ごと
  // 打ち切られるリンク元が、キューの先頭に居座り続けないようにする
  const picked = await db
    .prepare(
      `UPDATE link_rewrites SET attempts = attempts + 1
       WHERE source_page_id = (
         SELECT source_page_id FROM link_rewrites WHERE ?1 IS NULL OR target_page_id = ?1
         ORDER BY created_at, source_page_id LIMIT 1)
       RETURNING source_page_id, target_page_id, old_title_key, actor, created_at, attempts`,
    )
    .bind(targetPageId)
    .all<JobRow & { source_page_id: string }>();
  const idle = {
    processed: null,
    conflict: false,
    failed: [] as string[],
    failedPages: [] as FailedLinkRewrite[],
  };
  const first = picked.results[0];
  if (first === undefined)
    return { result: { ...idle, remaining: 0, rowsWritten: 0 }, actor: null };
  const sourcePageId = first.source_page_id;
  input.onPicked?.(sourcePageId);
  const jobs = picked.results.sort(
    (a, b) =>
      a.created_at - b.created_at ||
      compare(a.target_page_id, b.target_page_id) ||
      compare(a.old_title_key, b.old_title_key),
  );
  let rowsWritten = picked.meta.rows_written ?? 0;

  const conflicted = async (): Promise<LinkRewriteStep> => {
    // batch まで進んだので解析は終わっている。試行回数は CPU の上限で打ち切られた回数を数えるもので、
    // 保存が続くリンク元を競合の回数で捨てないよう数え直す
    const reset = await db
      .prepare("UPDATE link_rewrites SET attempts = 0 WHERE source_page_id = ?1")
      .bind(sourcePageId)
      .run();
    rowsWritten += reset.meta.rows_written ?? 0;
    return {
      result: {
        ...idle,
        conflict: true,
        remaining: await countRemaining(db, targetPageId),
        rowsWritten,
      },
      actor: null,
    };
  };

  /** 書き込まずにキューのジョブを捨てる。guards が読んだ状態と違えば捨てずに conflict を返す */
  const discard = async (
    failedPages: FailedLinkRewrite[],
    guards: D1PreparedStatement[],
  ): Promise<LinkRewriteStep> => {
    let results: D1Result[];
    try {
      results = await db.batch([...guards, deleteJobsStatement(db, sourcePageId, jobs)]);
    } catch (error) {
      if (!isVersionConflict(error)) throw error;
      return conflicted();
    }
    return {
      result: {
        ...idle,
        failed: failedPages.map((page) => page.id),
        failedPages,
        remaining: await countRemaining(db, targetPageId),
        rowsWritten: rowsWritten + sumRowsWritten(results),
      },
      actor: null,
    };
  };
  const fail = (reason: string, title: string | null, guards: D1PreparedStatement[]) => {
    console.error(JSON.stringify({ event: "link_rewrites.failed", sourcePageId, reason }));
    return discard([{ id: sourcePageId, title }], guards);
  };

  // 本文にも対象にもよらない判断なので、読んだ状態を確かめずに捨てる。title を引くためだけに
  // ページを読むと、CPU の上限で打ち切られ続けたリンク元にクエリを足すことになるので、title は持たない
  if (jobs.some((job) => job.attempts > LINK_REWRITE_MAX_ATTEMPTS)) {
    return fail("attempts_exceeded", null, []);
  }

  const { results: pages } = await db
    .prepare(
      `SELECT id, title, title_key, CASE WHEN id = ?1 THEN body END AS body, visibility, version,
         deleted_at
       FROM pages WHERE id = ?1 OR id IN (SELECT value FROM json_each(?2))`,
    )
    .bind(sourcePageId, JSON.stringify(jobs.map((job) => job.target_page_id)))
    .all<PageRow>();
  const byId = new Map(pages.map((page) => [page.id, page]));
  const source = byId.get(sourcePageId);
  const targets = [...new Set(jobs.map((job) => job.target_page_id))]
    .map((id) => byId.get(id))
    .filter((page) => page !== undefined);
  const guards = [
    ...(source === undefined || source.deleted_at !== null
      ? []
      : [guardStatement(db, source.id, source.version)]),
    targetsGuardStatement(db, targets),
  ];

  if (source === undefined || source.deleted_at !== null || source.body === null) {
    return discard([], guards);
  }
  const { renames, actor } = renamesOf(jobs, byId);
  if (renames.size === 0 || actor === null) return discard([], guards);
  const rewrite = rewriteWikiLinkTargets(
    source.body,
    new Map([...renames].map(([key, rename]) => [key, rename.title])),
  );
  if (rewrite.rewritten === 0) return discard([], guards);

  if (utf8ByteLength(rewrite.body) > MAX_BODY_BYTES) {
    return fail("body_too_large", source.title, guards);
  }
  const values = await deriveValues(source.title, rewrite.body);
  const after = keysOf(values);
  // 書き換え前の値は、まず派生データのテーブルから読む（解析を 1 回減らして CPU を抑える）。テーブルが古いと
  // 食い違うので、そのときだけ本文を解析し直して比べ直し、古いテーブルのせいで捨てないようにする
  if (
    unexpectedChange(await readDerivedKeys(db, sourcePageId), after, renames) &&
    unexpectedChange(keysOf(await deriveValues(source.title, source.body)), after, renames)
  ) {
    return fail("unexpected_derived_change", source.title, guards);
  }

  const statements = [
    ...guards,
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
    // それ以外の失敗はキューのジョブを残して 500 にする。一時的な D1 の失敗で書き換えを失わないため
    if (!isVersionConflict(error)) throw error;
    return conflicted();
  }
  // guard を通ったあとに UPDATE が 0 行なら、派生データだけが書かれている（store.ts の returnedPage と同じ）
  if (results.at(-2)?.meta.changes !== 1) throw new Error("pages の書き込みが 1 行にならなかった");
  return {
    result: {
      processed: {
        sourcePageId,
        title: source.title,
        visibility: source.visibility,
        version: source.version + 1,
        rewritten: rewrite.rewritten,
      },
      conflict: false,
      failed: [],
      failedPages: [],
      remaining: await countRemaining(db, targetPageId),
      rowsWritten: rowsWritten + sumRowsWritten(results),
    },
    actor,
  };
}

/** 照合順序によらない比較。localeCompare は実行環境の locale で順序が変わる */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
