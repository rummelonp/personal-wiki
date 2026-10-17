import { isOAuthEnabled, oauthServerFor } from "../auth/oauth-server";
import type { Bindings } from "../env";
import { isPageId } from "./id";
import type { Page, Visibility } from "./store";

/*
 * revision の読み取り。読めるのは read の scope を持つ principal（owner、token、OAuth）だけで、
 * 呼び出し側（REST の宣言と /mcp の requireToken）がそれを保証する。draft か public かでは絞らない。
 *
 * 版の番号は飛ぶ。owner の保存は 10 分のまとまりの行の版を進めて上書きし（revisions.ts）、公開範囲の
 * 切り替えは版を進めるが revision を積まない。まとまりの途中の版の番号は、後の保存で消える。
 * created_at は、まとめた revision ではまとまりの最初の保存の時刻（編集を始めた時刻）になる。
 */

/**
 * 版の作成者。actor の文字列（revisions.ts の actorOf）を読み分けた値で、表示の文は呼び出し側が決める。
 * OAuth の name は client の登録の client_name で、登録が消えていれば（使われないまま期限が切れた、
 * OAuth を閉じた環境）null。tokenId は token の行の id で、name が一意だったころの行（`token:<name>`）
 * では null。other は、どの形にも合わない actor をそのまま渡す。
 */
export type RevisionAuthor =
  | { kind: "owner" }
  | { kind: "token"; tokenId: number | null; name: string }
  | { kind: "oauth"; clientId: string; name: string | null }
  | { kind: "other"; actor: string };

type ParsedActor =
  | { kind: "owner" }
  | { kind: "token"; tokenId: number | null; name: string }
  | { kind: "oauth"; clientId: string }
  | { kind: "other"; actor: string };

/** token の name は `:` を含まないので、`token:` の後の `:` の有無で `<id>:<name>` と古い `<name>` を分ける */
export function parseActor(actor: string): ParsedActor {
  if (actor === "owner") return { kind: "owner" };
  const oauth = /^oauth:(.+)$/s.exec(actor);
  if (oauth !== null) return { kind: "oauth", clientId: oauth[1] as string };
  const token = /^token:(?:([1-9][0-9]{0,15}):)?([^:]+)$/s.exec(actor);
  if (token !== null) {
    return {
      kind: "token",
      tokenId: token[1] === undefined ? null : Number(token[1]),
      name: token[2] as string,
    };
  }
  return { kind: "other", actor };
}

/** OAuth の client_id から接続の名前を引く。引けなければ null。 */
export type ClientNameLookup = (clientId: string) => Promise<string | null>;

/**
 * 接続の名前は KV の client の登録から引く（読み取り 1 回）。OAuth を閉じた環境では KV に触らず null。
 * CIMD（URL の client_id を取りに行く）は oauthServerFor で有効にしていないので、引くのは KV だけ。
 */
export function clientNameLookup(env: Bindings, origin: string): ClientNameLookup {
  return async (clientId) => {
    if (!isOAuthEnabled(env)) return null;
    const client = await oauthServerFor(env, origin).getOAuthApi(env).lookupClient(clientId);
    return client?.clientName ?? null;
  };
}

/**
 * 同じ client の名前を 1 回だけ引く（一覧に同じ接続の版が並ぶ）。
 * 名前は表示の補助なので、KV の読み取りや登録の JSON の破損で引けないときは、登録が消えたときと同じ null に
 * して、履歴の読み取り全体を失敗させない。
 */
async function authorsOf(
  actors: readonly string[],
  lookup: ClientNameLookup,
): Promise<RevisionAuthor[]> {
  const parsed = actors.map(parseActor);
  const clientIds = new Set<string>();
  for (const actor of parsed) if (actor.kind === "oauth") clientIds.add(actor.clientId);
  const names = new Map(
    await Promise.all(
      [...clientIds].map(async (id) => {
        try {
          return [id, await lookup(id)] as const;
        } catch (error) {
          // JSON.parse のエラーの文は壊れた登録の断片を含むので、種類だけを残す
          const kind = error instanceof Error ? error.name : "unknown";
          console.error(JSON.stringify({ event: "revisions.client_lookup_failed", error: kind }));
          return [id, null] as const;
        }
      }),
    ),
  );
  return parsed.map((actor) =>
    actor.kind === "oauth" ? { ...actor, name: names.get(actor.clientId) ?? null } : actor,
  );
}

export interface RevisionSummary {
  version: number;
  title: string;
  /** その版の編集を始めた時刻（owner の保存では、まとまりの最初の保存の時刻） */
  createdAt: number;
  author: RevisionAuthor;
}

export interface Revision extends RevisionSummary {
  body: string;
}

export interface RevisionList {
  /** 版の降順（新しい順） */
  revisions: RevisionSummary[];
  /** 続きがあれば、次の呼び出しに渡す値。無ければ null */
  nextCursor: string | null;
}

/** 版の番号の形。REST の If-Match と同じ 15 桁までで、Number で誤差なく表せる */
const VERSION_PATTERN = /^[1-9][0-9]{0,14}$/;

export function parseVersion(value: string): number | null {
  return VERSION_PATTERN.test(value) ? Number(value) : null;
}

/**
 * 一覧の cursor は、返した最後の版の番号の文字列。版の降順に読むので、まとめで最新の行の版が進んでも
 * cursor より古い行は動かず、続きを取る間に行が抜けたり重なったりしない。
 */
export const parseRevisionCursor = parseVersion;

interface RevisionRow {
  version: number | null;
  title: string | null;
  actor: string | null;
  created_at: number | null;
}

type FilledRow = { [K in keyof RevisionRow]: NonNullable<RevisionRow[K]> };

/**
 * ページの revision を新しい順に返す。ページが無いか削除済みなら null。
 * pages を外側にして結合し、ページの有無と revision を 1 回のクエリで読む（ページがあれば、範囲に
 * revision が無くても version が NULL の 1 行が返る）。
 */
export async function listRevisions(
  db: D1Database,
  pageId: string,
  options: { limit: number; before: number | null; clientName: ClientNameLookup },
): Promise<RevisionList | null> {
  if (!isPageId(pageId)) return null;
  const { results } = await db
    .prepare(
      `SELECT r.version, r.title, r.actor, r.created_at
       FROM pages AS p
       LEFT JOIN revisions AS r ON r.page_id = p.id AND (?2 IS NULL OR r.version < ?2)
       WHERE p.id = ?1 AND p.deleted_at IS NULL
       ORDER BY r.version DESC
       LIMIT ?3`,
    )
    .bind(pageId, options.before, options.limit + 1)
    .all<RevisionRow>();
  if (results.length === 0) return null;
  const rows = results.filter((row): row is FilledRow => row.version !== null);
  const page = rows.slice(0, options.limit);
  const authors = await authorsOf(
    page.map((row) => row.actor),
    options.clientName,
  );
  return {
    revisions: page.map((row, i) => ({
      version: row.version,
      title: row.title,
      createdAt: row.created_at,
      author: authors[i] as RevisionAuthor,
    })),
    nextCursor: rows.length > options.limit ? String(page.at(-1)?.version) : null,
  };
}

export type RevisionLookup =
  | { ok: true; revision: Revision; page: Omit<Page, "body"> }
  | { ok: false; reason: "page_not_found" | "revision_not_found" };

interface RevisionWithPageRow extends RevisionRow {
  body: string | null;
  page_title: string;
  visibility: Visibility;
  page_version: number;
  page_created_at: number;
  updated_at: number;
}

/**
 * ページの 1 つの版を読む。ページが無いか削除済みなら page_not_found、ページはあるがその版の行が無ければ
 * revision_not_found（まとめで版が進んだ、欠けた番号、別のページの版の番号）。
 * page は今のページ（本文を除く）で、版を読んだ後に書き換えるときの照合と URL に使う。
 */
export async function findRevision(
  db: D1Database,
  pageId: string,
  version: number,
  clientName: ClientNameLookup,
): Promise<RevisionLookup> {
  if (!isPageId(pageId)) return { ok: false, reason: "page_not_found" };
  const row = await db
    .prepare(
      `SELECT p.title AS page_title, p.visibility, p.version AS page_version,
         p.created_at AS page_created_at, p.updated_at,
         r.version, r.title, r.actor, r.created_at, r.body
       FROM pages AS p
       LEFT JOIN revisions AS r ON r.page_id = p.id AND r.version = ?2
       WHERE p.id = ?1 AND p.deleted_at IS NULL`,
    )
    .bind(pageId, version)
    .first<RevisionWithPageRow>();
  if (row === null) return { ok: false, reason: "page_not_found" };
  const { version: found, title, actor, created_at, body } = row;
  if (found === null || title === null || actor === null || created_at === null || body === null) {
    return { ok: false, reason: "revision_not_found" };
  }
  const [author] = await authorsOf([actor], clientName);
  return {
    ok: true,
    revision: {
      version: found,
      title,
      body,
      createdAt: created_at,
      author: author as RevisionAuthor,
    },
    page: {
      id: pageId,
      title: row.page_title,
      visibility: row.visibility,
      version: row.page_version,
      createdAt: row.page_created_at,
      updatedAt: row.updated_at,
    },
  };
}

export type RestoreSourceLookup =
  | { ok: true; page: Page; revisionBody: string }
  | { ok: false; reason: "page_not_found" | "revision_not_found" };

/**
 * 版を戻す前に、今のページ（本文を含む）と戻す版の本文を 1 回のクエリで読む。見分け方は findRevision と同じ。
 * 書き込みの経路なので、作成者の名前（KV）は引かない。
 */
export async function findRestoreSource(
  db: D1Database,
  pageId: string,
  version: number,
): Promise<RestoreSourceLookup> {
  if (!isPageId(pageId)) return { ok: false, reason: "page_not_found" };
  const row = await db
    .prepare(
      `SELECT p.title, p.body, p.visibility, p.version, p.created_at, p.updated_at,
         r.body AS revision_body
       FROM pages AS p
       LEFT JOIN revisions AS r ON r.page_id = p.id AND r.version = ?2
       WHERE p.id = ?1 AND p.deleted_at IS NULL`,
    )
    .bind(pageId, version)
    .first<{
      title: string;
      body: string;
      visibility: Visibility;
      version: number;
      created_at: number;
      updated_at: number;
      revision_body: string | null;
    }>();
  if (row === null) return { ok: false, reason: "page_not_found" };
  if (row.revision_body === null) return { ok: false, reason: "revision_not_found" };
  return {
    ok: true,
    page: {
      id: pageId,
      title: row.title,
      body: row.body,
      visibility: row.visibility,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    revisionBody: row.revision_body,
  };
}
