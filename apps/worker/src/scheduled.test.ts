import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { WriteMetric } from "./pages/operations";
import { createScheduledHandler } from "./scheduled";
import { buildClient, type PageJson, T0 } from "./test/pages";

afterEach(() => {
  vi.restoreAllMocks();
});

function controller() {
  return createScheduledController({ cron: "* * * * *", scheduledTime: T0 });
}

/** prepare の回数を数える D1 */
function countingDb(db: D1Database) {
  const counter = { prepares: 0 };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          counter.prepares += 1;
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, counter };
}

async function queueRename() {
  const client = await buildClient();
  const target = await client.create("Old");
  const source = await client.create("S", "[[Old]]");
  const renamed = await client.update(target, "New", "");
  expect(renamed.status).toBe(200);
  return { client, source };
}

function logged(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

describe("scheduled", () => {
  it("default export の scheduled から 1 リンク元を書き換える", async () => {
    const { client, source } = await queueRename();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.scheduled(controller(), env);

    const res = await client.request(`/api/pages/${source.id}`);
    expect(await res.json<PageJson>()).toMatchObject({ body: "[[New]]", version: 2 });
    expect(logged(log)).toContainEqual({
      event: "link_rewrites.scheduled",
      processed: source.id,
      rewritten: 1,
      conflict: false,
      failed: [],
      remaining: 0,
      rowsWritten: expect.any(Number),
    });
  });

  it("書き換えが無ければ 1 クエリで終わり、何も書かない", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const metrics: WriteMetric[] = [];
    const { db, counter } = countingDb(env.DB);
    await createScheduledHandler({ recordWrite: (m) => metrics.push(m) })(controller(), {
      ...env,
      DB: db,
    });
    expect(counter.prepares).toBe(1);
    expect(metrics).toEqual([]);
    expect(logged(log)).toEqual([
      {
        event: "link_rewrites.scheduled",
        processed: null,
        rewritten: 0,
        conflict: false,
        failed: [],
        remaining: 0,
        rowsWritten: 0,
      },
    ]);
  });

  it("1 回の発火では 1 リンク元しか進めず、revision の actor は rename した呼び出し元になる", async () => {
    const client = await buildClient({ name: "renamer" });
    const target = await client.create("Old");
    const a = await client.create("A", "[[Old]]");
    const b = await client.create("B", "[[Old]]");
    await client.update(target, "New", "");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const metrics: WriteMetric[] = [];
    const handler = createScheduledHandler({
      now: () => T0 + 1000,
      recordWrite: (m) => metrics.push(m),
    });

    await handler(controller(), env);
    const { results } = await env.DB.prepare(
      "SELECT page_id AS pageId, actor FROM revisions WHERE version = 2 AND page_id IN (?1, ?2)",
    )
      .bind(a.id, b.id)
      .all<{ pageId: string; actor: string }>();
    expect(results).toHaveLength(1);
    expect(results[0]?.actor).toBe("token:renamer");
    expect(metrics).toMatchObject([{ op: "link_rewrite", actor: "token:renamer" }]);

    await handler(controller(), env);
    const rest = await env.DB.prepare("SELECT count(*) AS n FROM link_rewrites").first<{
      n: number;
    }>();
    expect(rest?.n).toBe(0);
  });

  it("D1 の例外はログに出して投げ直す", async () => {
    await queueRename();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async () => {
            throw new Error("injected");
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(createScheduledHandler()(controller(), { ...env, DB: failing })).rejects.toThrow(
      "injected",
    );
    expect(logged(error)).toEqual([{ event: "link_rewrites.scheduled_error", error: "injected" }]);
    // 積んだ分は残り、次の発火が試す
    const left = await env.DB.prepare("SELECT attempts FROM link_rewrites").first<{
      attempts: number;
    }>();
    expect(left?.attempts).toBe(1);
  });
});
