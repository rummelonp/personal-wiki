import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { buildClient, T0 } from "../test/pages";
import { insertToken } from "../test/tokens";
import type { LinkRewriteStepResult } from "./link-rewrites";
import { APPEND_MAX_ATTEMPTS } from "./store";

/*
 * 書き込みの経路ごとに、1 invocation のクエリ数が最も多くなる場合を数える。D1 Free の上限は 50 で、
 * batch の文も 1 文ずつ数える。派生データの文が 1 回の保存あたり 2 文増えても上限に届かないことを確かめる
 * （SLACK_PER_WRITE）。
 */
const D1_QUERY_LIMIT = 50;
const SLACK_PER_WRITE = 2;

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

function expectWithinBudget(counter: { queries: number }, writes: number) {
  expect(counter.queries + SLACK_PER_WRITE * writes).toBeLessThan(D1_QUERY_LIMIT);
}

describe("1 invocation のクエリ数", () => {
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
    // 認証 2、試行ごとに読み 1 と batch 12
    expect(counter.queries).toBe(2 + APPEND_MAX_ATTEMPTS * 13);
    expectWithinBudget(counter, APPEND_MAX_ATTEMPTS);
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
    // 認証 2、batch 13、版の読み分け 1
    expect(counter.queries).toBe(16);
    expectWithinBudget(counter, 1);
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
    // 認証 2、選ぶ 1、ページ 1、派生データ 1、batch 14、残り 1
    expect(success.counter.queries).toBe(20);

    await client.update({ id: target.id, version: 2 }, "Newer", "");
    const racing = instrumentedDb(() => s.id);
    const conflicted = await requestWith(racing.db, "/api/link-rewrites/step", {
      method: "POST",
      json: {},
    });
    expect((await conflicted.json<LinkRewriteStepResult>()).conflict).toBe(true);
    // 上に加えて、試行回数を数え直す 1
    expect(racing.counter.queries).toBe(21);
    expectWithinBudget(racing.counter, 1);
  });
});
