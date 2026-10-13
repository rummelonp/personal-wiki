import { extractDerived } from "@personal-wiki/markdown";

/** 派生テーブルに入れる値。可変長の links と tags は JSON 1 個にまとめ、D1 の bind 100 個の上限を避ける。 */
export interface DerivedValues {
  /** links.target_title_key の配列の JSON */
  linksJson: string;
  /** `{ key, tag }` の配列の JSON */
  tagsJson: string;
  ftsTitle: string;
  ftsBody: string;
}

/**
 * pages_fts に入れる文字列と検索語に掛ける正規化。trigram は全角英数や半角カナを畳まないので、
 * 保存側と検索側で必ず同じ関数を通す。
 */
export function foldForSearch(text: string): string {
  return text.normalize("NFKC");
}

export function deriveValues(title: string, body: string): DerivedValues {
  const derived = extractDerived(body);
  return {
    linksJson: JSON.stringify(derived.links.map((link) => link.targetTitleKey)),
    tagsJson: JSON.stringify(derived.tags.map(({ tagKey, tag }) => ({ key: tagKey, tag }))),
    ftsTitle: foldForSearch(title),
    ftsBody: foldForSearch(derived.plainText),
  };
}

/**
 * ページ 1 件の派生データ（links、tags、pages_fts）を、そのページの body から作った値に合わせる文。
 * 作成・更新・作り直しで同じ文を使い、どの経路で書いても同じ行になるようにする。
 *
 * - pages の行がすでにあり、id と seq が変わらないことを前提にする。pages の title や version には依存しない
 *   ので、更新の batch では pages の UPDATE より前に置ける（版の照合は先頭の guard が済ませる）。
 * - links と tags は差分で書く。消して入れ直すより書き込み行数が大幅に少ない。upsert は値が変わった
 *   行だけを書き換え、tag の表記や target_page_id の食い違いも作り直しで直る。
 * - このページを target とする他のページの links を、新しい title_key で付け直す。title が変わらない
 *   保存でも毎回流す。変わったかを知るには pages を読む文が別に要り、変わらなければ索引を引くだけで
 *   行を書かないため。
 */
export function derivedStatements(
  db: D1Database,
  pageId: string,
  titleKey: string,
  values: DerivedValues,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `DELETE FROM links
         WHERE source_page_id = ?1 AND target_title_key NOT IN (SELECT value FROM json_each(?2))`,
      )
      .bind(pageId, values.linksJson),
    // SELECT のあとの ON CONFLICT は、WHERE が無いと SQLite が JOIN の構文と区別できず構文エラーになる
    db
      .prepare(
        `INSERT INTO links (source_page_id, target_title_key, target_page_id)
         SELECT ?1, j.value,
           (SELECT p.id FROM pages AS p WHERE p.title_key = j.value AND p.deleted_at IS NULL)
         FROM json_each(?2) AS j WHERE true
         ON CONFLICT (source_page_id, target_title_key) DO UPDATE
           SET target_page_id = excluded.target_page_id
           WHERE target_page_id IS NOT excluded.target_page_id`,
      )
      .bind(pageId, values.linksJson),
    // 上の文は pages の古い title_key で解決するので、title を変えたページ自身へのリンクもここで直す
    db
      .prepare(
        "UPDATE links SET target_page_id = NULL WHERE target_page_id = ?1 AND target_title_key <> ?2",
      )
      .bind(pageId, titleKey),
    db
      .prepare(
        "UPDATE links SET target_page_id = ?1 WHERE target_title_key = ?2 AND target_page_id IS NOT ?1",
      )
      .bind(pageId, titleKey),
    db
      .prepare(
        `DELETE FROM tags
         WHERE page_id = ?1 AND tag_key NOT IN (SELECT j.value ->> '$.key' FROM json_each(?2) AS j)`,
      )
      .bind(pageId, values.tagsJson),
    db
      .prepare(
        `INSERT INTO tags (page_id, tag_key, tag)
         SELECT ?1, j.value ->> '$.key', j.value ->> '$.tag' FROM json_each(?2) AS j WHERE true
         ON CONFLICT (page_id, tag_key) DO UPDATE SET tag = excluded.tag WHERE tag <> excluded.tag`,
      )
      .bind(pageId, values.tagsJson),
    db
      .prepare("DELETE FROM pages_fts WHERE rowid = (SELECT seq FROM pages WHERE id = ?1)")
      .bind(pageId),
    db
      .prepare(
        "INSERT INTO pages_fts (rowid, title, body) SELECT seq, ?2, ?3 FROM pages WHERE id = ?1",
      )
      .bind(pageId, values.ftsTitle, values.ftsBody),
  ];
}

/** 削除したページの派生データを消し、このページを指していた links を未解決に戻す文。 */
export function clearDerivedStatements(db: D1Database, pageId: string): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM links WHERE source_page_id = ?1").bind(pageId),
    db.prepare("UPDATE links SET target_page_id = NULL WHERE target_page_id = ?1").bind(pageId),
    db.prepare("DELETE FROM tags WHERE page_id = ?1").bind(pageId),
    db
      .prepare("DELETE FROM pages_fts WHERE rowid = (SELECT seq FROM pages WHERE id = ?1)")
      .bind(pageId),
  ];
}
