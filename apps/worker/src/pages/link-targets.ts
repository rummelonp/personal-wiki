/** listPublicLinkTargets の 1 件。 */
export interface LinkTarget {
  id: string;
  title: string;
}

/**
 * pageId のページの本文がリンクする、public で削除されていないページを、多くて limit 件返す。
 * JS を実行しない読み手に向けた、ページの HTML のリンクの一覧に使う。自分自身へのリンクは含めない。
 * principal を受け取らず、owner にも draft を含めない。ページの HTML を principal で変えないことで、
 * 本文とトップの一覧と同じく、キャッシュと公開範囲の前提（security-headers.ts）がそのまま当てはまる。
 *
 * 並びはリンクの title_key の順で、links の主キーをそのままたどる（並べ替えない）。
 * links の行はリンク元と title_key ごとに 1 つで、削除されていないページの title_key は一意なので、
 * 同じページは 2 度出ない。`p.title_key = l.target_title_key` は、派生データを作り直す前の食い違い
 * （target_page_id が改題前の title_key の行に残ったもの）を除き、この一意性を links の付け直しに頼らずに保つ。
 */
export async function listPublicLinkTargets(
  db: D1Database,
  pageId: string,
  { limit }: { limit: number },
): Promise<LinkTarget[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.title FROM links AS l JOIN pages AS p ON p.id = l.target_page_id
       WHERE l.source_page_id = ?1 AND p.id <> ?1 AND p.title_key = l.target_title_key
         AND p.deleted_at IS NULL AND p.visibility = 'public'
       ORDER BY l.target_title_key LIMIT ?2`,
    )
    .bind(pageId, limit)
    .all<LinkTarget>();
  return results;
}
