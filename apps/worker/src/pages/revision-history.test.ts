import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { oauthServerFor } from "../auth/oauth-server";
import { ownerCookie, ownerEnv } from "../test/owner";
import { T0 } from "../test/pages";
import { insertApiToken, insertToken } from "../test/tokens";
import { findRevision, listRevisions, parseActor } from "./revision-history";
import { REVISION_MERGE_WINDOW_MS } from "./revisions";
import { createPage, deletePage, findPageById, setVisibility, updatePage } from "./store";

const ORIGIN = "http://localhost";
const MINUTE = 60 * 1000;

describe("parseActor", () => {
  it("owner、token の 2 つの形、OAuth を読み分け、合わないものは other にする", () => {
    expect(parseActor("owner")).toEqual({ kind: "owner" });
    expect(parseActor("token:7:air-claude")).toEqual({
      kind: "token",
      tokenId: 7,
      name: "air-claude",
    });
    expect(parseActor("token:air-claude")).toEqual({
      kind: "token",
      tokenId: null,
      name: "air-claude",
    });
    // name が数字だけの古い形は、id と name の形と取り違えない
    expect(parseActor("token:12")).toEqual({ kind: "token", tokenId: null, name: "12" });
    expect(parseActor("oauth:client-1")).toEqual({ kind: "oauth", clientId: "client-1" });
    for (const actor of ["", "Owner", "token:", "token:1:", "token:a:b", "oauth:", "system"]) {
      expect(parseActor(actor), actor).toEqual({ kind: "other", actor });
    }
  });
});

async function setup(bindings = ownerEnv()) {
  const app = createApp({ now: () => T0, recordWrite: () => {} });
  const cookie = await ownerCookie(T0);
  const call = (path: string, headers: Record<string, string> = {}) =>
    app.request(path, { headers }, bindings);
  const asOwner = (path: string) => call(path, { Cookie: cookie });
  return { call, asOwner };
}

async function create(actor: string, now: number, title = "Memo", body = "v1") {
  const result = await createPage(env.DB, { title, body, actor, now });
  if (!result.ok) throw new Error(result.reason);
  return result.page;
}

async function save(id: string, body: string, actor: string, now: number, title?: string) {
  const current = await findPageById(env.DB, id);
  if (current === null) throw new Error("page not found");
  const result = await updatePage(env.DB, {
    id,
    expectedVersion: current.version,
    title: title ?? current.title,
    body,
    actor,
    now,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.page;
}

async function publish(id: string, now: number) {
  const result = await setVisibility(env.DB, { id, visibility: "public", now });
  if (!result.ok) throw new Error(result.reason);
}

interface ListJson {
  revisions: { version: number; title: string; createdAt: number; author: unknown }[];
  nextCursor: string | null;
}

describe("GET /api/pages/:id/revisions", () => {
  it("版を新しい順に、まとめた版は編集を始めた時刻で返す", async () => {
    const { asOwner } = await setup();
    const { actor } = await insertApiToken({ name: "agent", scopes: "read write" });
    const page = await create("owner", T0);
    await save(page.id, "v2", "owner", T0 + MINUTE);
    await save(page.id, "v3", actor, T0 + 2 * MINUTE);
    await save(page.id, "v4", "owner", T0 + 3 * MINUTE, "Renamed");
    await save(page.id, "v5", "owner", T0 + 4 * MINUTE, "Renamed");

    const res = await asOwner(`/api/pages/${page.id}/revisions`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const tokenId = Number(actor.split(":")[1]);
    expect(await res.json<ListJson>()).toEqual({
      revisions: [
        { version: 5, title: "Renamed", createdAt: T0 + 3 * MINUTE, author: { kind: "owner" } },
        {
          version: 3,
          title: "Memo",
          createdAt: T0 + 2 * MINUTE,
          author: { kind: "token", tokenId, name: "agent" },
        },
        { version: 2, title: "Memo", createdAt: T0, author: { kind: "owner" } },
      ],
      nextCursor: null,
    });
  });

  it("limit で区切り、nextCursor で続きを重ならずに取る。まとめで最新の版が進んでも続きは変わらない", async () => {
    const { asOwner } = await setup();
    const page = await create("token:agent", T0);
    for (let i = 2; i <= 5; i++) await save(page.id, `v${i}`, "token:agent", T0 + i * MINUTE);
    const versionsOf = (list: ListJson) => list.revisions.map((r) => r.version);

    const first = await (await asOwner(`/api/pages/${page.id}/revisions?limit=2`)).json<ListJson>();
    expect(versionsOf(first)).toEqual([5, 4]);
    expect(first.nextCursor).not.toBeNull();
    // 続きを取る前に owner が保存し、最新の行の版が進む
    await save(page.id, "v6", "owner", T0 + 6 * MINUTE);
    await save(page.id, "v7", "owner", T0 + 7 * MINUTE);
    const cursor = encodeURIComponent(first.nextCursor ?? "");
    const second = await (
      await asOwner(`/api/pages/${page.id}/revisions?limit=2&cursor=${cursor}`)
    ).json<ListJson>();
    expect(versionsOf(second)).toEqual([3, 2]);
    const last = await (
      await asOwner(
        `/api/pages/${page.id}/revisions?limit=2&cursor=${encodeURIComponent(second.nextCursor ?? "")}`,
      )
    ).json<ListJson>();
    expect(last).toEqual({
      revisions: [expect.objectContaining({ version: 1 })],
      nextCursor: null,
    });
  });

  it("limit と cursor の誤りは 400", async () => {
    const { asOwner } = await setup();
    const page = await create("owner", T0);
    for (const query of ["limit=0", "limit=101", "limit=x", "cursor=0", "cursor=abc", "cursor="]) {
      const res = await asOwner(`/api/pages/${page.id}/revisions?${query}`);
      expect(res.status, query).toBe(400);
    }
  });

  it("無い id、形の違う id、削除したページは同じ 404", async () => {
    const { asOwner } = await setup();
    const gone = await create("owner", T0, "Gone");
    const deleted = await deletePage(env.DB, {
      id: gone.id,
      expectedVersion: gone.version,
      actor: "owner",
      now: T0,
    });
    expect(deleted.ok).toBe(true);
    for (const id of ["A".repeat(22), "short", gone.id]) {
      const res = await asOwner(`/api/pages/${id}/revisions`);
      expect(res.status, id).toBe(404);
      expect(await res.json(), id).toEqual({ error: "not_found" });
    }
  });
});

describe("GET /api/pages/:id/revisions/:version", () => {
  it("その版の title と本文と作成者を返す", async () => {
    const { asOwner } = await setup();
    const page = await create("owner", T0, "Memo", "first");
    await publish(page.id, T0 + MINUTE);
    await save(page.id, "second", "token:agent", T0 + 2 * MINUTE, "Renamed");

    const res = await asOwner(`/api/pages/${page.id}/revisions/1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual({
      pageId: page.id,
      version: 1,
      title: "Memo",
      body: "first",
      createdAt: T0,
      author: { kind: "owner" },
    });
    // 公開範囲の切り替えは版を進めるが revision を積まないので、その番号の版は無い
    const skipped = await asOwner(`/api/pages/${page.id}/revisions/2`);
    expect(skipped.status).toBe(404);
    expect(await skipped.json()).toEqual({ error: "revision_not_found" });
  });

  it("まとめで版が進んだ番号は revision_not_found", async () => {
    const { asOwner } = await setup();
    const page = await create("owner", T0);
    await save(page.id, "v2", "owner", T0 + MINUTE);
    expect((await asOwner(`/api/pages/${page.id}/revisions/1`)).status).toBe(404);
    expect((await asOwner(`/api/pages/${page.id}/revisions/2`)).status).toBe(200);
  });

  it("別のページにしかない版の番号は、そのページの版としては読めない", async () => {
    const { asOwner } = await setup();
    const short = await create("owner", T0, "Short", "short page");
    const long = await create("token:agent", T0, "Long", "long page");
    for (let i = 2; i <= 3; i++) await save(long.id, `long v${i}`, "token:agent", T0 + i * MINUTE);

    const res = await asOwner(`/api/pages/${short.id}/revisions/3`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("long");
  });

  it("無い id、形の違う id と版、削除したページは同じ 404", async () => {
    const { asOwner } = await setup();
    const page = await create("owner", T0);
    const gone = await create("owner", T0, "Gone");
    await deletePage(env.DB, { id: gone.id, expectedVersion: 1, actor: "owner", now: T0 });
    for (const path of [
      `/api/pages/${"A".repeat(22)}/revisions/1`,
      "/api/pages/short/revisions/1",
      `/api/pages/${gone.id}/revisions/1`,
      `/api/pages/${page.id}/revisions/0`,
      `/api/pages/${page.id}/revisions/01`,
      `/api/pages/${page.id}/revisions/x`,
      `/api/pages/${page.id}/revisions/${"9".repeat(16)}`,
    ]) {
      const res = await asOwner(path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: "not_found" });
    }
  });
});

describe("履歴を読める principal", () => {
  async function pages() {
    const open = await create("owner", T0, "Open Note", "open body");
    await publish(open.id, T0 + MINUTE);
    const draft = await create("owner", T0, "Hidden Plan", "hidden body");
    return { open, draft };
  }

  it("匿名には、public でも draft でも無い id でも同じ 401 を返す", async () => {
    const { call } = await setup();
    const { open, draft } = await pages();
    const responses = [];
    for (const id of [open.id, draft.id, "A".repeat(22), "short"]) {
      for (const path of [`/api/pages/${id}/revisions`, `/api/pages/${id}/revisions/1`]) {
        const res = await call(path);
        expect(res.status, path).toBe(401);
        responses.push(await res.text());
      }
    }
    expect(new Set(responses).size).toBe(1);
  });

  it("read の scope の無い token には、id に関係なく同じ 403 を返す", async () => {
    const { call } = await setup();
    const { open, draft } = await pages();
    // 未知の scope だけの token は、どの scope も持たない（api-tokens.ts）
    const token = await insertToken({ name: "odd", scopes: "admin" as "read" });
    const responses = [];
    for (const id of [open.id, draft.id, "A".repeat(22)]) {
      for (const path of [`/api/pages/${id}/revisions`, `/api/pages/${id}/revisions/1`]) {
        const res = await call(path, { Authorization: `Bearer ${token}` });
        expect(res.status, path).toBe(403);
        responses.push(await res.text());
      }
    }
    expect(new Set(responses).size).toBe(1);
  });

  it("read の token は draft の履歴も読める", async () => {
    const { call } = await setup();
    const { draft } = await pages();
    const token = await insertToken({ name: "reader", scopes: "read" });
    const auth = { Authorization: `Bearer ${token}` };
    expect((await call(`/api/pages/${draft.id}/revisions`, auth)).status).toBe(200);
    const res = await call(`/api/pages/${draft.id}/revisions/1`, auth);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await res.json<{ body: string }>()).body).toBe("hidden body");
  });
});

describe("OAuth の接続の名前", () => {
  async function oauthRevision(clientId: string, title = "Memo") {
    const page = await create("owner", T0, title);
    await save(page.id, "from connector", `oauth:${clientId}`, T0 + REVISION_MERGE_WINDOW_MS);
    return page;
  }

  async function registerClient(name: string) {
    const bindings = ownerEnv();
    return oauthServerFor(bindings, ORIGIN)
      .getOAuthApi(bindings)
      .createClient({
        clientName: name,
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
        tokenEndpointAuthMethod: "none",
      });
  }

  it("接続の名前を引き、同じ接続の版は 1 回だけ引く", async () => {
    const { asOwner } = await setup();
    const client = await registerClient("Claude");
    const page = await oauthRevision(client.clientId);
    await save(page.id, "again", `oauth:${client.clientId}`, T0 + 2 * REVISION_MERGE_WINDOW_MS);

    const list = await (await asOwner(`/api/pages/${page.id}/revisions`)).json<ListJson>();
    const author = { kind: "oauth", clientId: client.clientId, name: "Claude" };
    expect(list.revisions.map((r) => r.author)).toEqual([author, author, { kind: "owner" }]);
    const one = await (await asOwner(`/api/pages/${page.id}/revisions/2`)).json<ListJson>();
    expect(one).toMatchObject({ author });

    const looked: string[] = [];
    await listRevisions(env.DB, page.id, {
      limit: 20,
      before: null,
      clientName: async (id) => {
        looked.push(id);
        return null;
      },
    });
    expect(looked).toEqual([client.clientId]);
  });

  it("登録が消えた接続と、OAuth を閉じた環境では name が null", async () => {
    const client = await registerClient("Gone");
    const page = await oauthRevision(client.clientId);
    const bindings = ownerEnv();
    await oauthServerFor(bindings, ORIGIN).getOAuthApi(bindings).deleteClient(client.clientId);
    const missing = { kind: "oauth", clientId: client.clientId, name: null };

    const { asOwner } = await setup();
    const list = await (await asOwner(`/api/pages/${page.id}/revisions`)).json<ListJson>();
    expect(list.revisions[0]?.author).toEqual(missing);

    const other = await registerClient("Closed");
    const closedPage = await oauthRevision(other.clientId, "Closed");
    const withoutKv = ownerEnv();
    delete withoutKv.OAUTH_KV;
    const closed = await setup(withoutKv);
    const res = await closed.asOwner(`/api/pages/${closedPage.id}/revisions`);
    expect((await res.json<ListJson>()).revisions[0]?.author).toEqual({
      ...missing,
      clientId: other.clientId,
    });
  });

  it("名前を引く途中で例外が出ても、履歴は読めて name が null", async () => {
    const page = await oauthRevision("broken-client");
    const failing = () => Promise.reject(new Error("kv unavailable"));
    const list = await listRevisions(env.DB, page.id, {
      limit: 20,
      before: null,
      clientName: failing,
    });
    const missing = { kind: "oauth", clientId: "broken-client", name: null };
    expect(list?.revisions.map((r) => r.author)).toEqual([missing, { kind: "owner" }]);
    const one = await findRevision(env.DB, page.id, 2, failing);
    expect(one).toMatchObject({ ok: true, revision: { author: missing } });
  });
});
