import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { createScheduledHandler } from "../scheduled";
import { ownerCookie, ownerEnv } from "../test/owner";
import { buildClient, T0 } from "../test/pages";
import { insertToken } from "../test/tokens";
import type { LinkRewriteStepResult } from "./link-rewrites";
import { APPEND_MAX_ATTEMPTS } from "./store";

/*
 * 書き込みの経路ごとに、1 invocation のクエリ数が最も多くなる場合を数える。D1 Free の上限は 50 で、
 * batch の文も 1 文ずつ数える。派生データの文を足す余裕は添付の参照（attachment_refs の 2 文）で使い、
 * append の最悪は owner の 48 になる（owner は batch に revision をまとめる文が 1 つ増えるが、認証に D1 を
 * 使わない。token は認証の 2 を足して 47）。保存の batch にさらに文を足すと append が上限を超えるので、
 * そのときは APPEND_MAX_ATTEMPTS を下げる。
 */
const D1_QUERY_LIMIT = 50;

/**
 * prepare の回数を数える D1。conflictWith を渡すと、各 batch の直前にそのページの版を進め、
 * 版の競合を起こし続ける（その UPDATE は数えない）。
 */
function instrumentedDb(conflictWith?: () => string) {
  const counter = { queries: 0, batches: 0 };
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          counter.queries += 1;
          return target.prepare(sql);
        };
      }
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          counter.batches += 1;
          if (conflictWith !== undefined) {
            await target
              .prepare("UPDATE pages SET version = version + 1 WHERE id = ?1")
              .bind(conflictWith())
              .run();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, counter };
}

let tokens = 0;

async function requestWith(
  db: D1Database,
  path: string,
  init: { method: string; json: unknown; headers?: Record<string, string> },
) {
  const token = await insertToken({ name: `counted-${++tokens}`, scopes: "read write" });
  const app = createApp({ now: () => T0 + 1000, recordWrite: () => {} });
  return app.request(
    path,
    {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      body: JSON.stringify(init.json),
    },
    { ...env, DB: db },
  );
}

function expectWithinBudget(counter: { queries: number }) {
  expect(counter.queries).toBeLessThan(D1_QUERY_LIMIT);
}

describe("1 invocation のクエリ数", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("append は競合が上限まで続いても収まる", async () => {
    const client = await buildClient();
    const page = await client.create("Page", "[[Other]] #tag");
    const { db, counter } = instrumentedDb(() => page.id);
    const res = await requestWith(db, `/api/pages/${page.id}/append`, {
      method: "POST",
      json: { text: "追記" },
    });
    expect(res.status).toBe(409);
    expect(counter.batches).toBe(APPEND_MAX_ATTEMPTS);
    // 認証 2、試行ごとに読み 1 と batch 14
    expect(counter.queries).toBe(2 + APPEND_MAX_ATTEMPTS * 15);
    expectWithinBudget(counter);
  });

  it("owner の append は、revision をまとめる文の分を足しても競合が上限まで続いて収まる", async () => {
    const client = await buildClient();
    const page = await client.create("Page", "[[Other]] #tag");
    const { db, counter } = instrumentedDb(() => page.id);
    const res = await createApp({ now: () => T0 + 1000, recordWrite: () => {} }).request(
      `/api/pages/${page.id}/append`,
      {
        method: "POST",
        headers: {
          Cookie: await ownerCookie(T0 + 1000),
          Origin: "http://localhost",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "追記" }),
      },
      ownerEnv({ DB: db }),
    );
    expect(res.status).toBe(409);
    expect(counter.batches).toBe(APPEND_MAX_ATTEMPTS);
    // 試行ごとに読み 1 と batch 15（cookie は署名の検証だけで D1 を読まない）
    expect(counter.queries).toBe(APPEND_MAX_ATTEMPTS * 16);
    expectWithinBudget(counter);
  });

  it("title を変える更新は、版の競合で読み分けるところまで収まる", async () => {
    const client = await buildClient();
    const page = await client.create("Old");
    await client.create("S", "[[Old]]");
    const { db, counter } = instrumentedDb(() => page.id);
    const res = await requestWith(db, `/api/pages/${page.id}`, {
      method: "PUT",
      json: { title: "New", body: "" },
      headers: { "If-Match": `"${page.version}"` },
    });
    expect(res.status).toBe(409);
    // 認証 2、batch 15、版の読み分け 1
    expect(counter.queries).toBe(18);
    expectWithinBudget(counter);
  });

  it("版を戻す書き込みは、版の競合で読み分けるところまで収まる", async () => {
    const client = await buildClient();
    const page = await client.create("Page", "[[Other]] #tag");
    expect((await client.update(page, "Page", "[[Another]] #tag2")).status).toBe(200);
    const { db, counter } = instrumentedDb(() => page.id);
    const res = await requestWith(db, `/api/pages/${page.id}/revisions/1/restore`, {
      method: "POST",
      json: {},
      headers: { "If-Match": `"${page.version + 1}"` },
    });
    expect(res.status).toBe(409);
    // 認証 2、今のページと戻す版の読み 1、batch 15、版の読み分け 1
    expect(counter.queries).toBe(19);
    expectWithinBudget(counter);
  });

  it("link の書き換えの step は、版の競合で数え直すところまで収まる", async () => {
    const client = await buildClient();
    const target = await client.create("Old");
    const links = Array.from({ length: 30 }, (_, i) => `[[Old]] [[L${i}]] #t${i}`).join("\n");
    const s = await client.create("S", links);
    await client.update(target, "New", "");

    const success = instrumentedDb();
    const res = await requestWith(success.db, "/api/link-rewrites/step", {
      method: "POST",
      json: {},
    });
    expect(res.status).toBe(200);
    expect((await res.json<LinkRewriteStepResult>()).processed?.rewritten).toBe(30);
    // 認証 2、選ぶ 1、ページ 1、派生データ 1、batch 16、残り 1
    expect(success.counter.queries).toBe(22);

    await client.update({ id: target.id, version: 2 }, "Newer", "");
    const racing = instrumentedDb(() => s.id);
    const conflicted = await requestWith(racing.db, "/api/link-rewrites/step", {
      method: "POST",
      json: {},
    });
    expect((await conflicted.json<LinkRewriteStepResult>()).conflict).toBe(true);
    // 上に加えて、試行回数を数え直す 1
    expect(racing.counter.queries).toBe(23);
    expectWithinBudget(racing.counter);
  });

  it("MCP の rewrite_links は REST の step と同じ数のクエリに収まる", async () => {
    const client = await buildClient();
    const target = await client.create("Old");
    const links = Array.from({ length: 30 }, (_, i) => `[[Old]] [[L${i}]] #t${i}`).join("\n");
    const s = await client.create("S", links);
    await client.update(target, "New", "");

    const call = (db: D1Database) =>
      requestWith(db, "/mcp", {
        method: "POST",
        headers: { Accept: "application/json, text/event-stream" },
        json: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "rewrite_links", arguments: {} },
        },
      });
    const outcome = async (res: Response) => {
      const text = await res.text();
      const data = text.startsWith("{")
        ? text
        : (text.split("\n").find((line) => line.startsWith("data: ")) ?? "").slice(6);
      const rpc = JSON.parse(data) as { result: { content: { text: string }[] } };
      return JSON.parse(rpc.result.content[0]?.text ?? "") as {
        processed: { rewritten: number } | null;
        conflict: boolean;
      };
    };

    const success = instrumentedDb();
    const res = await call(success.db);
    expect(res.status).toBe(200);
    expect((await outcome(res)).processed?.rewritten).toBe(30);
    // REST の step と同じ 22（認証 2、選ぶ 1、ページ 1、派生データ 1、batch 16、残り 1）
    expect(success.counter.queries).toBe(22);

    await client.update({ id: target.id, version: 2 }, "Newer", "");
    const racing = instrumentedDb(() => s.id);
    expect((await outcome(await call(racing.db))).conflict).toBe(true);
    expect(racing.counter.queries).toBe(23);
    expectWithinBudget(racing.counter);
  });

  it("MCP の list_unresolved_links は、リンクが多くても件数に関係なく固定のクエリ数に収まる", async () => {
    const client = await buildClient();
    const page = await client.create(
      "Page",
      Array.from({ length: 60 }, (_, i) => `[[Ghost ${i}]]`).join(" "),
    );
    for (let i = 0; i < 7; i++) await client.create(`Other ${i}`, "[[Ghost 0]]");
    const count = async (args: Record<string, unknown>) => {
      const { db, counter } = instrumentedDb();
      const res = await requestWith(db, "/mcp", {
        method: "POST",
        headers: { Accept: "application/json, text/event-stream" },
        json: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_unresolved_links", arguments: args },
        },
      });
      expect(res.status).toBe(200);
      // 本文を読み切るまで tool は走り続けるので、数えるのは読んだあと
      expect(await res.text()).not.toContain('"isError":true');
      expectWithinBudget(counter);
      return counter.queries;
    };
    // 認証 2、title_key の集計 1、リンク元 1
    expect(await count({ limit: 100 })).toBe(4);
    // 上に加えて、ページの読み 1
    expect(await count({ id: page.id, limit: 100 })).toBe(5);
  });

  it("MCP の edit_page は、版の競合で最新の本文を読み直すところまで収まる", async () => {
    const client = await buildClient();
    const page = await client.create("Page", "[[Other]] #tag 古い");
    const call = (db: D1Database) =>
      requestWith(db, "/mcp", {
        method: "POST",
        headers: { Accept: "application/json, text/event-stream" },
        json: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "edit_page",
            arguments: { id: page.id, version: 1, edits: [{ old: "古い", new: "新しい" }] },
          },
        },
      });
    const outcome = async (res: Response) => {
      const text = await res.text();
      const data = text.startsWith("{")
        ? text
        : (text.split("\n").find((line) => line.startsWith("data: ")) ?? "").slice(6);
      const rpc = JSON.parse(data) as { result: { content: { text: string }[] } };
      return JSON.parse(rpc.result.content[0]?.text ?? "") as { error?: string; version?: number };
    };

    const racing = instrumentedDb(() => page.id);
    expect((await outcome(await call(racing.db))).error).toBe("version_conflict");
    // 認証 2、ページの読み 1、batch 15、版の読み分け 1、最新の本文の読み直し 1
    expect(racing.counter.queries).toBe(20);
    expectWithinBudget(racing.counter);

    // 競合した呼び出しがページの版を進めたので、成功する呼び出しは新しい版に合わせる
    const success = instrumentedDb();
    const res = await requestWith(success.db, "/mcp", {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream" },
      json: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "edit_page",
          arguments: { id: page.id, version: 2, edits: [{ old: "古い", new: "新しい" }] },
        },
      },
    });
    expect((await outcome(res)).version).toBe(3);
    // 認証 2、ページの読み 1、batch 15
    expect(success.counter.queries).toBe(18);
  });

  it("owner の cookie で呼ぶ step は、認証に D1 のクエリを使わない", async () => {
    const client = await buildClient();
    const target = await client.create("Old");
    const links = Array.from({ length: 30 }, (_, i) => `[[Old]] [[L${i}]] #t${i}`).join("\n");
    const s = await client.create("S", links);
    await client.update(target, "New", "");

    const call = async (db: D1Database) =>
      createApp({ now: () => T0 + 1000, recordWrite: () => {} }).request(
        "/api/link-rewrites/step",
        {
          method: "POST",
          headers: {
            Cookie: await ownerCookie(T0 + 1000),
            Origin: "http://localhost",
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
          },
          body: "{}",
        },
        ownerEnv({ DB: db }),
      );

    const success = instrumentedDb();
    const res = await call(success.db);
    expect(res.status).toBe(200);
    expect((await res.json<LinkRewriteStepResult>()).processed?.rewritten).toBe(30);
    // 選ぶ 1、ページ 1、派生データ 1、batch 16、残り 1（cookie は署名の検証だけで D1 を読まない）
    expect(success.counter.queries).toBe(20);

    await client.update({ id: target.id, version: 2 }, "Newer", "");
    const racing = instrumentedDb(() => s.id);
    const conflicted = await call(racing.db);
    expect((await conflicted.json<LinkRewriteStepResult>()).conflict).toBe(true);
    // 上に加えて、試行回数を数え直す 1
    expect(racing.counter.queries).toBe(21);
    expectWithinBudget(racing.counter);
  });

  it("Cron の scheduled は、REST の step から認証の 2 を除いた数に収まる", async () => {
    const client = await buildClient();
    const target = await client.create("Old");
    const links = Array.from({ length: 30 }, (_, i) => `[[Old]] [[L${i}]] #t${i}`).join("\n");
    const s = await client.create("S", links);
    await client.update(target, "New", "");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const scheduled = createScheduledHandler({ recordWrite: () => {} });
    const controller = createScheduledController({ cron: "* * * * *" });

    const success = instrumentedDb();
    await scheduled(controller, { ...env, DB: success.db });
    // 選ぶ 1、ページ 1、派生データ 1、batch 16、残り 1
    expect(success.counter.queries).toBe(20);

    await client.update({ id: target.id, version: 2 }, "Newer", "");
    const racing = instrumentedDb(() => s.id);
    await scheduled(controller, { ...env, DB: racing.db });
    // 上に加えて、試行回数を数え直す 1
    expect(racing.counter.queries).toBe(21);
    expectWithinBudget(racing.counter);
  });
});
