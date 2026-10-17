import type { Principal } from "../auth/principal";

/**
 * revisions.actor に入れる値。anonymous は書き込めないので actor を持たない。
 * api_tokens の token と OAuth の client_id は別々に決まるので、prefix を分けて同じ文字列でも衝突させない。
 * OAuth で client 名ではなく client_id を使うのは、client 名は登録時に client が自称する値で一意でないため。
 *
 * api_tokens の token は `token:<id>:<name>`。識別するのは id で、重複してよいラベルの name は、
 * ログや D1 の行を人が読むときに api_tokens を引かずに済むよう付ける。
 * name が一意だったころに書いた行は `token:<name>` のまま残る（0009_api_token_names.sql）。name は
 * `:` を含まないので、2 つ目の `:` の有無で形を見分けられる。
 */
export function actorOf(principal: Principal): string {
  switch (principal.kind) {
    case "owner":
      return "owner";
    case "token":
      return principal.issuer === "oauth"
        ? `oauth:${principal.name}`
        : `token:${principal.id}:${principal.name}`;
    case "anonymous":
      throw new Error("anonymous は書き込めない");
  }
}

const OWNER_ACTOR = "owner";

/**
 * owner の保存をまとめる間隔（ミリ秒）。まとめた revision の created_at（最初の保存の時刻）から数える。
 * 直前の保存から数えると、書き続ける間は何時間でも 1 つの revision に吸い込まれ、途中の版に戻れなくなる。
 */
export const REVISION_MERGE_WINDOW_MS = 10 * 60 * 1000;

export interface RevisionInput {
  pageId: string;
  /** 保存後の版 */
  version: number;
  title: string;
  body: string;
  actor: string;
  now: number;
  /**
   * true なら、owner の保存を直前の版の owner の revision にまとめる。自動保存で積もる版を減らすためで、
   * AI（token、OAuth）の書き込みは何をしたかを追えるよう毎回 1 件残す。リンクの書き換えのように
   * 保存の操作ではない書き込みと、版を戻す書き込みのように直前の塊と分けて残すべき書き込みは渡さない。
   */
  mergeOwnerSaves?: boolean;
}

/**
 * 保存 1 回分の revision を記録する文。まとめるときは、直前の版（保存前の版）の revision が owner のもので、
 * まとめる間隔の内に始まっていれば、その行を新しい版と内容に書き換える。書き換えなかったときだけ挿入する。
 *
 * 照合を直前の版に限るので、間に別の actor の保存が入ると（直前の版の revision がその actor のもの）、
 * 公開範囲を切り替えると（版を進めるが revision を積まないので、直前の版の revision が無い）、そこが
 * まとめの境目になる。公開した時点の本文は、後の保存に上書きされず残る。
 * owner の rename によるリンクの書き換えの revision は、テーブルの上で owner の保存と見分けられないので、
 * 続く owner の保存にはまとめられる（その保存の本文は書き換えを含む）。
 *
 * 挿入は、新しい版の行が既にあるか（書き換えたか）で条件付ける。D1 の batch で、前の文の changes() を
 * 後の文から読めることに頼らないため。
 *
 * 返す文の数は、まとめるかどうかで 1 か 2 に変わる。呼び出し元は、batch の結果のうちこれより後ろの文の
 * 結果を位置で引かない（末尾から数える）。
 */
export function revisionStatements(db: D1Database, input: RevisionInput): D1PreparedStatement[] {
  const insert = (unlessMerged: boolean) =>
    db
      .prepare(
        `INSERT INTO revisions (page_id, version, title, body, actor, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         ${unlessMerged ? "WHERE NOT EXISTS (SELECT 1 FROM revisions WHERE page_id = ?1 AND version = ?2)" : ""}`,
      )
      .bind(input.pageId, input.version, input.title, input.body, input.actor, input.now);
  if (input.mergeOwnerSaves !== true || input.actor !== OWNER_ACTOR) return [insert(false)];
  return [
    db
      .prepare(
        `UPDATE revisions SET version = ?2, title = ?3, body = ?4
         WHERE page_id = ?1 AND version = ?2 - 1 AND actor = ?5 AND created_at >= ?6 - ?7`,
      )
      .bind(
        input.pageId,
        input.version,
        input.title,
        input.body,
        input.actor,
        input.now,
        REVISION_MERGE_WINDOW_MS,
      ),
    insert(true),
  ];
}
