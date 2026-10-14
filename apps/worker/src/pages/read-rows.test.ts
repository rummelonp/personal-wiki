import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { T0 } from "../test/pages";
import { type Cursor, listPageTitles, listRecentPages, parseCursor } from "./search";

/*
 * 匿名にも開いた一覧の、1 回の D1 の読み取り行数（meta.rows_read）がページ数に比例しないこと。
 * D1 Free の読み取りは 1 日 500 万行で、全ページを読む一覧は少ない要求で使い切れる。
 * rows_read は SQLite の版や計画で数行ずつ揺れるので、固定値でなく、全ページを読んだら超える上限で確かめる。
 */

const PAGES = 2000;

/** 半分を public にした PAGES 件のページを、updated_at を 1 ずつずらして入れる。 */
async function seed() {
  await env.DB.prepare(
    `INSERT INTO pages (id, title, title_key, body, visibility, version, created_at, updated_at)
     SELECT printf('%022d', value), 'bulk ' || value, 'bulk ' || value, '',
            CASE WHEN value % 2 = 0 THEN 'public' ELSE 'draft' END, 1, ?2, ?2 + value
     FROM json_each(?1)`,
  )
    .bind(JSON.stringify(Array.from({ length: PAGES }, (_, i) => i)), T0)
    .run();
}

/** all() の rows_read を足し上げる D1。 */
function meteredDb() {
  const counter = { rowsRead: 0 };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (prop === "all") {
          return async () => {
            const result = await target.all();
            counter.rowsRead += result.meta.rows_read;
            return result;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql));
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, counter };
}

function cursorOf(value: string | null): Cursor {
  const cursor = value === null ? null : parseCursor(value);
  if (cursor === null) throw new Error("no cursor");
  return cursor;
}

describe("一覧の読み取り行数", () => {
  it("最近の更新は、cursor の有無にかかわらず limit の数倍で止まる", async () => {
    await seed();
    for (const readable of ["all", "public"] as const) {
      const first = meteredDb();
      const page = await listRecentPages(first.db, { limit: 20, cursor: null, readable });
      expect(page.pages).toHaveLength(20);
      expect(first.counter.rowsRead, readable).toBeLessThan(300);

      const next = meteredDb();
      await listRecentPages(next.db, { limit: 20, cursor: cursorOf(page.nextCursor), readable });
      expect(next.counter.rowsRead, readable).toBeLessThan(300);
    }
  });

  it("title の一覧の 2 回目は、cursor の位置まで読み飛ばさない", async () => {
    await seed();
    const first = await listPageTitles(env.DB, { limit: 500, cursor: null, readable: "all" });
    const next = meteredDb();
    const page = await listPageTitles(next.db, {
      limit: 500,
      cursor: cursorOf(first.nextCursor),
      readable: "all",
    });
    expect(page.pages[0]?.title).toBe(`bulk ${PAGES - 501}`);
    // 先頭から読み飛ばすと 1,000 行を超え、索引を使わなければ全ページを読んで並べ替える
    expect(next.counter.rowsRead).toBeLessThan(800);
  });
});
