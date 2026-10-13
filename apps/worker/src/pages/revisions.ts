import type { Principal } from "../auth/principal";

/**
 * revisions.actor に入れる値。anonymous は書き込めないので actor を持たない。
 * api_tokens の名前と OAuth の client_id は別々に決まるので、prefix を分けて同じ文字列でも衝突させない。
 * OAuth で client 名ではなく client_id を使うのは、client 名は登録時に client が自称する値で一意でないため。
 */
export function actorOf(principal: Principal): string {
  switch (principal.kind) {
    case "owner":
      return "owner";
    case "token":
      return principal.issuer === "oauth" ? `oauth:${principal.name}` : `token:${principal.name}`;
    case "anonymous":
      throw new Error("anonymous は書き込めない");
  }
}

export interface RevisionInput {
  pageId: string;
  /** 保存後の版 */
  version: number;
  title: string;
  body: string;
  actor: string;
  now: number;
}

/**
 * 保存 1 回分の revision を記録する文。いまは毎回 1 件積む（AI の書き込みは毎回 1 件残す方針で、
 * owner の書き込み経路はまだ無い）。
 *
 * owner の連続保存をまとめるときは、ここを「同じ actor が一定時間内に作った直前の版の revision を
 * 新しい版に書き換え、書き換えなかったときだけ挿入する」文に差し替える。batch の他の文は revision の
 * 件数に依存しないので、変更はこの関数の中で閉じる。
 */
export function revisionStatements(db: D1Database, input: RevisionInput): D1PreparedStatement[] {
  return [
    db
      .prepare(
        "INSERT INTO revisions (page_id, version, title, body, actor, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
      .bind(input.pageId, input.version, input.title, input.body, input.actor, input.now),
  ];
}
