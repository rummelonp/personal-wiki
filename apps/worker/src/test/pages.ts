import { env } from "cloudflare:workers";
import { createApp } from "../app";
import type { WriteMetric } from "../pages/operations";
import { insertApiToken } from "./tokens";

export const T0 = Date.UTC(2026, 9, 1);

export interface PageJson {
  id: string;
  title: string;
  body: string;
  visibility: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** write のトークンで API を呼ぶ。書き込みの計測値は metrics に溜まる。 */
export async function buildClient(options: { scopes?: "read" | "read write"; name?: string } = {}) {
  const { token, actor } = await insertApiToken({
    name: options.name ?? "agent",
    scopes: options.scopes ?? "read write",
  });
  const clock = { now: T0 };
  const metrics: WriteMetric[] = [];
  const app = createApp({ now: () => clock.now, recordWrite: (m) => metrics.push(m) });
  const request = (
    path: string,
    init: { method?: string; headers?: Record<string, string>; json?: unknown; body?: string } = {},
  ) =>
    app.request(
      path,
      {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.json === undefined ? {} : { "Content-Type": "application/json" }),
          ...init.headers,
        },
        body: init.json === undefined ? (init.body ?? null) : JSON.stringify(init.json),
      },
      env,
    );
  async function create(title: string, body = ""): Promise<PageJson> {
    const res = await request("/api/pages", { method: "POST", json: { title, body } });
    if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
    return res.json<PageJson>();
  }
  async function update(page: { id: string; version: number }, title: string, body: string) {
    return request(`/api/pages/${page.id}`, {
      method: "PUT",
      headers: { "If-Match": `"${page.version}"` },
      json: { title, body },
    });
  }
  return { request, create, update, clock, metrics, actor };
}

/** DB 全体の派生データとページを丸ごと取り、書き込みが一切起きなかったことの比較に使う。 */
export async function snapshotDb() {
  const all = async (sql: string) => (await env.DB.prepare(sql).all()).results;
  return {
    pages: await all("SELECT * FROM pages ORDER BY seq"),
    revisions: await all("SELECT * FROM revisions ORDER BY page_id, version"),
    links: await all("SELECT * FROM links ORDER BY source_page_id, target_title_key"),
    tags: await all("SELECT * FROM tags ORDER BY page_id, tag_key"),
    attachmentRefs: await all("SELECT * FROM attachment_refs ORDER BY page_id, name"),
    excerpts: await all("SELECT * FROM page_excerpts ORDER BY page_id"),
    fts: await all("SELECT rowid, title, body FROM pages_fts ORDER BY rowid"),
    guard: await all("SELECT * FROM save_guard"),
  };
}

/** 派生データだけ（作り直しの前後の比較用）。 */
export async function snapshotDerived() {
  const { links, tags, attachmentRefs, excerpts, fts } = await snapshotDb();
  return { links, tags, attachmentRefs, excerpts, fts };
}

export async function linksFrom(pageId: string) {
  const { results } = await env.DB.prepare(
    "SELECT target_title_key AS key, target_page_id AS target FROM links WHERE source_page_id = ?1 ORDER BY key",
  )
    .bind(pageId)
    .all<{ key: string; target: string | null }>();
  return results;
}

export async function tagsOf(pageId: string) {
  const { results } = await env.DB.prepare(
    "SELECT tag_key AS key, tag FROM tags WHERE page_id = ?1 ORDER BY key",
  )
    .bind(pageId)
    .all<{ key: string; tag: string }>();
  return results;
}

/** FTS で引いた結果をページの id で返す。query は trigram の MATCH に渡すため 3 文字以上にする。 */
export async function searchFts(query: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.id FROM pages_fts JOIN pages AS p ON p.seq = pages_fts.rowid
     WHERE pages_fts MATCH ?1 ORDER BY p.id`,
  )
    .bind(`"${query.replaceAll('"', '""')}"`)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function attachmentRefsOf(pageId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM attachment_refs WHERE page_id = ?1 ORDER BY name",
  )
    .bind(pageId)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}
