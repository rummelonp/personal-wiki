import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildClient, type PageJson, snapshotDb, T0 } from "../test/pages";
import { MAX_BODY_BYTES, MAX_TITLE_BYTES } from "./store";

async function revisionsOf(pageId: string) {
  const { results } = await env.DB.prepare(
    "SELECT version, title, body, actor FROM revisions WHERE page_id = ?1 ORDER BY version",
  )
    .bind(pageId)
    .all();
  return results;
}

describe("POST /api/pages", () => {
  it("draft で作り、版 1 と ETag と revision を返す", async () => {
    const { request, metrics } = await buildClient();
    const res = await request("/api/pages", {
      method: "POST",
      json: { title: "  First  Page ", body: "本文" },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("ETag")).toBe('"1"');
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const page = await res.json<PageJson>();
    expect(res.headers.get("Location")).toBe(`/api/pages/${page.id}`);
    expect(page).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      title: "First  Page",
      body: "本文",
      visibility: "draft",
      version: 1,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(await revisionsOf(page.id)).toEqual([
      { version: 1, title: "First  Page", body: "本文", actor: "token:agent" },
    ]);
    expect(metrics).toEqual([
      { op: "create", actor: "token:agent", pageId: page.id, rowsWritten: expect.any(Number) },
    ]);
  });

  it("visibility を送ると 400 で、何も書かない", async () => {
    const { request } = await buildClient();
    const before = await snapshotDb();
    const res = await request("/api/pages", {
      method: "POST",
      json: { title: "x", body: "", visibility: "public" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "visibility_not_allowed" });
    expect(await snapshotDb()).toEqual(before);
  });

  it("frontmatter に visibility を書いても draft のまま", async () => {
    const { create, update, request } = await buildClient();
    const body = "---\nvisibility: public\n---\n本文";
    const page = await create("fm", body);
    expect(page.visibility).toBe("draft");
    const updated = await (await update(page, "fm", `${body}\n更新`)).json<PageJson>();
    expect(updated.visibility).toBe("draft");
    const appended = await request(`/api/pages/${page.id}/append`, {
      method: "POST",
      json: { text: "---\nvisibility: public\n---" },
    });
    expect((await appended.json<PageJson>()).visibility).toBe("draft");
    const row = await env.DB.prepare("SELECT visibility FROM pages WHERE id = ?1")
      .bind(page.id)
      .first<{ visibility: string }>();
    expect(row?.visibility).toBe("draft");
  });

  it("入力の誤りは 400", async () => {
    const { request } = await buildClient();
    const post = (json: unknown) => request("/api/pages", { method: "POST", json });
    expect(await (await post({ title: "x", content: "" })).json()).toEqual({
      error: "unknown_field",
      field: "content",
    });
    expect(await (await post({ title: "x" })).json()).toEqual({
      error: "missing_field",
      field: "body",
    });
    expect(await (await post({ title: 1, body: "" })).json()).toEqual({
      error: "invalid_field",
      field: "title",
    });
    expect((await post({ title: " \n ", body: "" })).status).toBe(400);
    expect((await post([1])).status).toBe(400);
    const broken = await request("/api/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      json: undefined,
    });
    expect(await broken.json()).toEqual({ error: "invalid_json" });
  });

  it("本文は UTF-8 で MAX_BODY_BYTES まで。超えたら 413", async () => {
    const { request } = await buildClient();
    const atLimit = await request("/api/pages", {
      method: "POST",
      json: { title: "limit", body: "a".repeat(MAX_BODY_BYTES) },
    });
    expect(atLimit.status).toBe(201);
    // 3 バイトの文字で、文字数ではなくバイト数で数えることを確かめる
    const over = await request("/api/pages", {
      method: "POST",
      json: { title: "big", body: "あ".repeat(Math.floor(MAX_BODY_BYTES / 3) + 1) },
    });
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: "body_too_large", max: MAX_BODY_BYTES });
  });

  it("JSON を解析する前に、Content-Length が上限を大きく超えるリクエストを 413 にする", async () => {
    const { request } = await buildClient();
    // JSON として壊れた本文を送る。解析まで進めば 400 invalid_json になる
    const huge = "x".repeat((MAX_TITLE_BYTES + MAX_BODY_BYTES) * 6 + 2048);
    const res = await request("/api/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(huge.length) },
      body: huge,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "body_too_large", max: MAX_BODY_BYTES });
  });

  it("title は単一行にしたあとの UTF-8 で MAX_TITLE_BYTES まで。超えたら 400 title_too_long", async () => {
    const { request } = await buildClient();
    const atLimit = await request("/api/pages", {
      method: "POST",
      json: { title: `${"t".repeat(MAX_TITLE_BYTES)}\n`, body: "" },
    });
    expect(atLimit.status).toBe(201);
    const before = await snapshotDb();
    const over = await request("/api/pages", {
      method: "POST",
      json: { title: "あ".repeat(Math.floor(MAX_TITLE_BYTES / 3) + 1), body: "" },
    });
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual({ error: "title_too_long", max: MAX_TITLE_BYTES });
    expect(await snapshotDb()).toEqual(before);
  });

  it("title_key が同じページがあれば 409 title_conflict", async () => {
    const { create, request } = await buildClient();
    await create("Hello World");
    const before = await snapshotDb();
    const res = await request("/api/pages", {
      method: "POST",
      json: { title: "ＨＥＬＬＯ   world", body: "[[Other]] #tag" },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "title_conflict" });
    expect(await snapshotDb()).toEqual(before);
  });
});

describe("read のトークン", () => {
  it("取得はできるが、作成、更新、追記、削除、作り直し、リンクの書き換えは 403", async () => {
    const writer = await buildClient();
    const page = await writer.create("p");
    const reader = await buildClient({ scopes: "read", name: "reader" });
    expect((await reader.request(`/api/pages/${page.id}`)).status).toBe(200);
    const ifMatch = { "If-Match": '"1"' };
    const attempts = [
      reader.request("/api/pages", { method: "POST", json: { title: "q", body: "" } }),
      reader.request(`/api/pages/${page.id}`, {
        method: "PUT",
        headers: ifMatch,
        json: { title: "p", body: "x" },
      }),
      reader.request(`/api/pages/${page.id}/append`, { method: "POST", json: { text: "x" } }),
      reader.request(`/api/pages/${page.id}`, { method: "DELETE", headers: ifMatch }),
      reader.request("/api/admin/derived/rebuild", { method: "POST", json: {} }),
      reader.request("/api/link-rewrites/step", { method: "POST", json: {} }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403);
  });
});

describe("GET /api/pages/:id と /api/pages/by-title", () => {
  it("id と title で同じページを返す", async () => {
    const { create, request } = await buildClient();
    const page = await create("A/B #c ?d", "# 本文");
    const byId = await request(`/api/pages/${page.id}`);
    expect(byId.status).toBe(200);
    expect(byId.headers.get("ETag")).toBe('"1"');
    expect(await byId.json()).toEqual(page);
    const byTitle = await request(
      `/api/pages/by-title?title=${encodeURIComponent("ａ/ｂ  #C ?D")}`,
    );
    expect(byTitle.status).toBe(200);
    expect(byTitle.headers.get("ETag")).toBe('"1"');
    expect(await byTitle.json()).toEqual(page);
  });

  it("無いページ、形式の違う id、空の title は 404", async () => {
    const { request } = await buildClient();
    for (const path of [
      "/api/pages/AAAAAAAAAAAAAAAAAAAAAA",
      "/api/pages/short",
      "/api/pages/by-title?title=nothing",
      "/api/pages/by-title?title=%20",
    ]) {
      const res = await request(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });
});

describe("PUT /api/pages/:id", () => {
  it("If-Match が合えば版を 1 進め、新しい ETag を返す", async () => {
    const { create, update, clock } = await buildClient();
    const page = await create("p", "v1");
    clock.now = T0 + 1000;
    const res = await update(page, "p2", "v2");
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"2"');
    expect(await res.json()).toEqual({
      ...page,
      title: "p2",
      body: "v2",
      version: 2,
      updatedAt: T0 + 1000,
    });
    expect((await revisionsOf(page.id)).map((r) => r.version)).toEqual([1, 2]);
  });

  it("If-Match は ETag の形と版の番号の両方を受け付ける", async () => {
    const { create, request } = await buildClient();
    const page = await create("p");
    const res = await request(`/api/pages/${page.id}`, {
      method: "PUT",
      headers: { "If-Match": "1" },
      json: { title: "p", body: "x" },
    });
    expect(res.status).toBe(200);
  });

  it("If-Match が無ければ 428、版を特定しない値は 400", async () => {
    const { create, request } = await buildClient();
    const page = await create("p");
    const put = (headers: Record<string, string>) =>
      request(`/api/pages/${page.id}`, { method: "PUT", headers, json: { title: "p", body: "x" } });
    const missing = await put({});
    expect(missing.status).toBe(428);
    expect(await missing.json()).toMatchObject({ error: "if_match_required" });
    for (const value of ["*", 'W/"1"', '"1", "2"', '"0"', "abc"]) {
      const res = await put({ "If-Match": value });
      expect(res.status, value).toBe(400);
    }
  });

  it("版が合わなければ 409 で、pages も派生データも revision も変わらない", async () => {
    const { create, update } = await buildClient();
    await create("Target");
    const page = await create("p", "[[Target]] [[Missing]] #old 古い本文です");
    const v2 = await (await update(page, "p", "[[Target]] #old 二つ目の本文")).json<PageJson>();
    const before = await snapshotDb();
    const res = await update(page, "renamed", "[[Other]] #new まったく別の本文");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "version_conflict", currentVersion: 2 });
    expect(await snapshotDb()).toEqual(before);
    expect(v2.version).toBe(2);
  });

  it("title_key の UNIQUE 違反は 409 title_conflict で、版の競合と区別でき、何も変わらない", async () => {
    const { create, update } = await buildClient();
    await create("Taken");
    const page = await create("p", "#a [[x]]");
    const before = await snapshotDb();
    const res = await update(page, "taken", "#b [[y]]");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "title_conflict" });
    expect(await snapshotDb()).toEqual(before);
  });

  it("無いページと削除済みのページは 404", async () => {
    const { create, update, request } = await buildClient();
    expect((await update({ id: "AAAAAAAAAAAAAAAAAAAAAA", version: 1 }, "x", "")).status).toBe(404);
    const page = await create("p");
    await request(`/api/pages/${page.id}`, { method: "DELETE", headers: { "If-Match": '"1"' } });
    const res = await update(page, "p", "x");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("visibility は変えられない", async () => {
    const { create, request } = await buildClient();
    const page = await create("p");
    const res = await request(`/api/pages/${page.id}`, {
      method: "PUT",
      headers: { "If-Match": '"1"' },
      json: { title: "p", body: "x", visibility: "public" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "visibility_not_allowed" });
  });

  it("同じ版からの並行保存は 1 つだけ成功する", async () => {
    const { create, update } = await buildClient();
    const page = await create("p", "v1");
    const results = await Promise.all(
      ["A", "B", "C", "D"].map((s) => update(page, "p", `並行 ${s} [[${s}]] #${s}`)),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409]);
    const winner = await results.find((r) => r.status === 200)?.json<PageJson>();
    const s = winner?.body.slice(3, 4);
    const snapshot = await snapshotDb();
    expect(snapshot.revisions).toHaveLength(2);
    expect(snapshot.links).toEqual([
      { source_page_id: page.id, target_title_key: s?.toLowerCase(), target_page_id: null },
    ]);
    expect(snapshot.tags).toEqual([{ page_id: page.id, tag_key: s?.toLowerCase(), tag: s }]);
  });
});

describe("POST /api/pages/:id/append", () => {
  it("最新版の末尾に行を足し、版を進める", async () => {
    const { create, request, metrics } = await buildClient();
    const page = await create("memo", "一行目");
    const res = await request(`/api/pages/${page.id}/append`, {
      method: "POST",
      json: { text: "- 追記\n" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"2"');
    const first = await res.json<PageJson>();
    expect(first.body).toBe("一行目\n- 追記\n");
    const second = await request(`/api/pages/${page.id}/append`, {
      method: "POST",
      json: { text: "- 次" },
    });
    expect((await second.json<PageJson>()).body).toBe("一行目\n- 追記\n- 次");
    expect(metrics.at(-1)).toEqual({
      op: "append",
      actor: "token:agent",
      pageId: page.id,
      rowsWritten: expect.any(Number),
      attempts: 1,
    });
  });

  it("並行する追記は読み直して全部残る", async () => {
    const { create, request } = await buildClient();
    const page = await create("memo", "");
    const results = await Promise.all(
      ["a", "b", "c"].map((text) =>
        request(`/api/pages/${page.id}/append`, { method: "POST", json: { text } }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const latest = await (await request(`/api/pages/${page.id}`)).json<PageJson>();
    expect(latest.version).toBe(4);
    expect(latest.body.split("\n").sort()).toEqual(["a", "b", "c"]);
  });

  it("無いページは 404、空の text と visibility は 400", async () => {
    const { create, request } = await buildClient();
    const missing = await request("/api/pages/AAAAAAAAAAAAAAAAAAAAAA/append", {
      method: "POST",
      json: { text: "x" },
    });
    expect(missing.status).toBe(404);
    const page = await create("p");
    const append = (json: unknown) =>
      request(`/api/pages/${page.id}/append`, { method: "POST", json });
    expect((await append({ text: "" })).status).toBe(400);
    expect(await (await append({ text: "x", visibility: "public" })).json()).toMatchObject({
      error: "visibility_not_allowed",
    });
  });
});

describe("DELETE /api/pages/:id", () => {
  it("If-Match が合えば論理削除し、title を空ける", async () => {
    const { create, request, metrics } = await buildClient();
    const page = await create("gone", "#t [[x]] 消える本文です");
    const res = await request(`/api/pages/${page.id}`, {
      method: "DELETE",
      headers: { "If-Match": '"1"' },
    });
    expect(res.status).toBe(204);
    expect(metrics.at(-1)).toEqual({
      op: "delete",
      actor: "token:agent",
      pageId: page.id,
      rowsWritten: expect.any(Number),
    });
    expect((await request(`/api/pages/${page.id}`)).status).toBe(404);
    const row = await env.DB.prepare(
      "SELECT deleted_at, deleted_by, version FROM pages WHERE id = ?1",
    )
      .bind(page.id)
      .first();
    expect(row).toEqual({ deleted_at: T0, deleted_by: "token:agent", version: 1 });
    const again = await create("gone");
    expect(again.id).not.toBe(page.id);
  });

  it("If-Match が無ければ 428、合わなければ 409、無ければ 404", async () => {
    const { create, request } = await buildClient();
    const page = await create("p");
    const del = (headers: Record<string, string>) =>
      request(`/api/pages/${page.id}`, { method: "DELETE", headers });
    expect((await del({})).status).toBe(428);
    const before = await snapshotDb();
    expect((await del({ "If-Match": '"2"' })).status).toBe(409);
    expect(await snapshotDb()).toEqual(before);
    expect((await del({ "If-Match": '"1"' })).status).toBe(204);
    expect((await del({ "If-Match": '"1"' })).status).toBe(404);
  });
});
