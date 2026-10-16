import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { ownerCookie, ownerEnv } from "../test/owner";
import { linksFrom, snapshotDb, T0, tagsOf } from "../test/pages";
import { insertApiToken, insertToken } from "../test/tokens";
import type { WriteMetric } from "./operations";
import { REVISION_MERGE_WINDOW_MS } from "./revisions";
import { createPage, deletePage, setVisibility } from "./store";

const ORIGIN = "http://localhost";
const MINUTE = 60 * 1000;

async function setup() {
  let clock = T0;
  const metrics: WriteMetric[] = [];
  const app = createApp({ now: () => clock, recordWrite: (m) => metrics.push(m) });
  const bindings = ownerEnv();
  const cookie = await ownerCookie(T0);
  const ownerHeaders = { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json" };
  const send = (path: string, init: RequestInit) => app.request(path, init, bindings);
  const restore = (
    id: string,
    version: number | string,
    ifMatch: number,
    headers: Record<string, string> = ownerHeaders,
  ) =>
    send(`/api/pages/${id}/revisions/${version}/restore`, {
      method: "POST",
      headers: { ...headers, "If-Match": `"${ifMatch}"` },
      body: "{}",
    });
  const put = (
    id: string,
    version: number,
    title: string,
    body: string,
    headers: Record<string, string> = ownerHeaders,
  ) =>
    send(`/api/pages/${id}`, {
      method: "PUT",
      headers: { ...headers, "If-Match": `"${version}"` },
      body: JSON.stringify({ title, body }),
    });
  return {
    metrics,
    send,
    restore,
    put,
    ownerHeaders,
    at: (time: number) => {
      clock = time;
    },
  };
}

async function create(title: string, body: string, actor = "owner", now = T0) {
  const result = await createPage(env.DB, { title, body, actor, now });
  if (!result.ok) throw new Error(result.reason);
  return result.page;
}

async function revisionsOf(pageId: string) {
  const { results } = await env.DB.prepare(
    "SELECT version, title, body, actor, created_at FROM revisions WHERE page_id = ?1 ORDER BY version",
  )
    .bind(pageId)
    .all<{ version: number; title: string; body: string; actor: string; created_at: number }>();
  return results;
}

interface PageJson {
  id: string;
  title: string;
  body: string;
  version: number;
  updatedAt: number;
}

describe("POST /api/pages/:id/revisions/:version/restore", () => {
  it("本文を戻し、title は今のまま、タグとリンクは戻した本文から作る", async () => {
    const { restore, put, metrics, at } = await setup();
    const page = await create("Memo", "first #alpha [[Alpha]]", "token:agent");
    at(T0 + MINUTE);
    expect((await put(page.id, 1, "Renamed", "second #beta [[Beta]]")).status).toBe(200);

    at(T0 + 2 * MINUTE);
    const res = await restore(page.id, 1, 2);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"3"');
    expect(await res.json()).toEqual({
      id: page.id,
      title: "Renamed",
      body: "first #alpha [[Alpha]]",
      visibility: "draft",
      version: 3,
      createdAt: T0,
      updatedAt: T0 + 2 * MINUTE,
    });
    expect((await tagsOf(page.id)).map((t) => t.tag)).toEqual(["alpha"]);
    expect((await linksFrom(page.id)).map((l) => l.key)).toEqual(["alpha"]);
    expect((await revisionsOf(page.id)).at(-1)).toEqual({
      version: 3,
      title: "Renamed",
      body: "first #alpha [[Alpha]]",
      actor: "owner",
      created_at: T0 + 2 * MINUTE,
    });
    expect(metrics.at(-1)).toEqual({
      op: "restore",
      actor: "owner",
      pageId: page.id,
      rowsWritten: expect.any(Number),
    });
  });

  it("owner が戻しても直前の owner の revision にまとめず、戻す前の本文が残る", async () => {
    const { restore, put, at } = await setup();
    const page = await create("Memo", "v1", "token:agent");
    at(T0 + MINUTE);
    await put(page.id, 1, "Memo", "v2");
    at(T0 + 2 * MINUTE);
    await put(page.id, 2, "Memo", "v3 typed");

    at(T0 + 3 * MINUTE);
    expect((await restore(page.id, 1, 3)).status).toBe(200);
    expect(
      (await revisionsOf(page.id)).map(({ version, body, actor }) => ({ version, body, actor })),
    ).toEqual([
      { version: 1, body: "v1", actor: "token:agent" },
      { version: 3, body: "v3 typed", actor: "owner" },
      { version: 4, body: "v1", actor: "owner" },
    ]);
  });

  it("戻した後の owner の保存は、10 分の内なら戻した revision にまとまる", async () => {
    const { restore, put, at } = await setup();
    const page = await create("Memo", "v1", "token:agent");
    at(T0 + MINUTE);
    await put(page.id, 1, "Memo", "v2");

    at(T0 + 2 * MINUTE);
    await restore(page.id, 1, 2);
    at(T0 + 3 * MINUTE);
    expect((await put(page.id, 3, "Memo", "v1 edited")).status).toBe(200);
    at(T0 + 2 * MINUTE + REVISION_MERGE_WINDOW_MS - 1);
    expect((await put(page.id, 4, "Memo", "v1 edited more")).status).toBe(200);

    const rows = await revisionsOf(page.id);
    expect(rows.map(({ version, body }) => ({ version, body }))).toEqual([
      { version: 1, body: "v1" },
      { version: 2, body: "v2" },
      { version: 5, body: "v1 edited more" },
    ]);
    // まとめた行の時刻は、戻した時刻のまま
    expect(rows.at(-1)?.created_at).toBe(T0 + 2 * MINUTE);
  });

  it("write の token は戻せる。token の書き込みは、戻した後も保存ごとに revision を積む", async () => {
    const { restore, put, at } = await setup();
    const { token, actor } = await insertApiToken({ name: "agent", scopes: "read write" });
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const page = await create("Memo", "v1");
    at(T0 + MINUTE);
    await put(page.id, 1, "Memo", "v2", auth);

    at(T0 + 2 * MINUTE);
    expect((await restore(page.id, 1, 2, auth)).status).toBe(200);
    at(T0 + 3 * MINUTE);
    expect((await put(page.id, 3, "Memo", "v1 by agent", auth)).status).toBe(200);
    expect(
      (await revisionsOf(page.id)).map(({ version, body, actor }) => ({ version, body, actor })),
    ).toEqual([
      { version: 1, body: "v1", actor: "owner" },
      { version: 2, body: "v2", actor },
      { version: 3, body: "v1", actor },
      { version: 4, body: "v1 by agent", actor },
    ]);
  });

  it("read の token は 403、匿名は 401 で、何も書かない", async () => {
    const { restore, put, at } = await setup();
    const reader = await insertToken({ name: "reader", scopes: "read" });
    const draft = await create("Hidden", "v1", "token:agent");
    const open = await create("Open", "v1", "token:agent");
    at(T0 + MINUTE);
    await put(draft.id, 1, "Hidden", "v2");
    await put(open.id, 1, "Open", "v2");
    await setVisibility(env.DB, { id: open.id, visibility: "public", now: T0 + MINUTE });
    const before = await snapshotDb();

    for (const [id, version] of [
      [draft.id, 2],
      [open.id, 3],
    ] as const) {
      const asReader = await restore(id, 1, version, {
        Authorization: `Bearer ${reader}`,
        "Content-Type": "application/json",
      });
      expect(asReader.status).toBe(403);
      const anonymous = await restore(id, 1, version, { "Content-Type": "application/json" });
      expect(anonymous.status).toBe(401);
    }
    expect(await snapshotDb()).toEqual(before);
  });

  it("write の token は draft のページも戻せる", async () => {
    const { restore, put, at } = await setup();
    const writer = await insertToken({ name: "writer", scopes: "read write" });
    const auth = { Authorization: `Bearer ${writer}`, "Content-Type": "application/json" };
    const draft = await create("Hidden", "v1");
    at(T0 + MINUTE);
    await put(draft.id, 1, "Hidden", "v2", auth);
    const res = await restore(draft.id, 1, 2, auth);
    expect(res.status).toBe(200);
    expect((await res.json<PageJson>()).body).toBe("v1");
  });

  it("If-Match の版が古ければ 409 で書かず、無ければ 428", async () => {
    const { restore, put, send, ownerHeaders, at } = await setup();
    const page = await create("Memo", "v1", "token:agent");
    at(T0 + MINUTE);
    await put(page.id, 1, "Memo", "v2");
    const before = await snapshotDb();

    const stale = await restore(page.id, 1, 1);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "version_conflict", currentVersion: 2 });
    // 本文が今と同じで書かずに済む版でも、古い版からの要求は通さない
    const sameBody = await restore(page.id, 2, 1);
    expect(sameBody.status).toBe(409);

    const missing = await send(`/api/pages/${page.id}/revisions/1/restore`, {
      method: "POST",
      headers: ownerHeaders,
      body: "{}",
    });
    expect(missing.status).toBe(428);
    expect(await snapshotDb()).toEqual(before);
  });

  it("無い版は revision_not_found、無いページと削除したページは not_found", async () => {
    const { restore, put, at } = await setup();
    const page = await create("Memo", "v1");
    at(T0 + MINUTE);
    await put(page.id, 1, "Memo", "v2");
    const gone = await create("Gone", "v1");
    await deletePage(env.DB, { id: gone.id, expectedVersion: 1, actor: "owner", now: T0 });

    // owner の保存がまとまり、版 1 の行は版 2 に進んでいる
    const merged = await restore(page.id, 1, 2);
    expect(merged.status).toBe(404);
    expect(await merged.json()).toEqual({ error: "revision_not_found" });
    for (const [id, version] of [
      [gone.id, 1],
      ["A".repeat(22), 1],
      ["short", 1],
    ] as const) {
      const res = await restore(id, version, 1);
      expect(res.status, id).toBe(404);
      expect(await res.json(), id).toEqual({ error: "not_found" });
    }
    for (const version of ["0", "x", "9".repeat(16)]) {
      const res = await restore(page.id, version, 2);
      expect(res.status, version).toBe(404);
      expect(await res.json(), version).toEqual({ error: "not_found" });
    }
  });

  it("本文が今と同じなら書かず、今のページを返す", async () => {
    const { restore, put, metrics, at } = await setup();
    const page = await create("Memo", "same", "token:agent");
    at(T0 + MINUTE);
    await put(page.id, 1, "Renamed", "same");
    const before = await snapshotDb();
    const count = metrics.length;

    const res = await restore(page.id, 1, 2);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"2"');
    expect(await res.json()).toMatchObject({ title: "Renamed", body: "same", version: 2 });
    expect(await snapshotDb()).toEqual(before);
    expect(metrics.length).toBe(count);
  });

  it("cookie の書き込みは JSON の Content-Type が無ければ CSRF として断る", async () => {
    const { send, ownerHeaders, put, at } = await setup();
    const page = await create("Memo", "v1", "token:agent");
    at(T0 + MINUTE);
    await put(page.id, 1, "Memo", "v2");
    const { "Content-Type": _, ...withoutType } = ownerHeaders;
    const res = await send(`/api/pages/${page.id}/revisions/1/restore`, {
      method: "POST",
      headers: { ...withoutType, "If-Match": '"2"' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "csrf_rejected" });
  });
});
