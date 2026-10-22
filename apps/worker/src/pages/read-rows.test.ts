import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { T0 } from "../test/pages";
import {
  type Cursor,
  type ListOrder,
  listPageTitles,
  listPublicPages,
  listRecentPages,
  parseCursor,
} from "./search";

/*
 * 匿名にも開いた一覧の、1 回の D1 の読み取り行数（meta.rows_read）がページ数に比例しないこと。
 * D1 Free の読み取りは 1 日 500 万行で、全ページを読む一覧は少ないリクエストで使い切れる。
 * rows_read は SQLite の版や計画で数行ずつ揺れるので、固定値でなく、全ページを読んだら超える上限で確かめる。
 */

const PAGES = 2000;

/**
 * 半分を public にした PAGES 件のページを、updated_at を 1 ずつ進め、created_at を 1 ずつ戻して入れる。
 * created_at の順が updated_at の順と逆なので、どちらかのインデックスで別の並びを代用すると読み取り行数が増える。
 */
async function seed() {
  await env.DB.prepare(
    `INSERT INTO pages (id, title, title_key, body, visibility, version, created_at, updated_at)
     SELECT printf('%022d', value), 'bulk ' || value, 'bulk ' || value, '',
            CASE WHEN value % 2 = 0 THEN 'public' ELSE 'draft' END, 1, ?2 + ?3 - value, ?2 + value
     FROM json_each(?1)`,
  )
    .bind(JSON.stringify(Array.from({ length: PAGES }, (_, i) => i)), T0, PAGES - 1)
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
    // 先頭に近い cursor では、先頭から読み飛ばしても行数が増えないので、中ほどの位置から読ませる
    const deep = PAGES / 2;
    const deepCursor: Cursor = { updatedAt: T0 + deep, id: String(deep).padStart(22, "0") };
    for (const readable of ["all", "public"] as const) {
      const first = meteredDb();
      const page = await listRecentPages(first.db, { limit: 20, cursor: null, readable });
      expect(page.pages).toHaveLength(20);
      expect(first.counter.rowsRead, readable).toBeLessThan(300);

      const next = meteredDb();
      const later = await listRecentPages(next.db, { limit: 20, cursor: deepCursor, readable });
      expect(later.pages[0]?.title, readable).toBe(
        `bulk ${readable === "all" ? deep - 1 : deep - 2}`,
      );
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
    // 先頭から読み飛ばすと 1,000 行を超え、インデックスを使わなければ全ページを読んで並べ替える
    expect(next.counter.rowsRead).toBeLessThan(800);
  });

  // 作成日時の順と title の順は、既定の更新日時の順とは別のインデックス（pages_alive_created、pages_title_key_alive）を使う
  it.each([
    {
      sort: "created",
      // 作成日時の降順で deep 番目の次は、value の昇順で 1 つ先（public は 2 つ先）になる
      cursor: { createdAt: T0 + PAGES - 1 - PAGES / 2, id: String(PAGES / 2).padStart(22, "0") },
      next: { all: `bulk ${PAGES / 2 + 1}`, public: `bulk ${PAGES / 2 + 2}` },
    },
    {
      sort: "title",
      // 'bulk 510' は title_key の昇順で 1,400 番目より後ろで、先頭から読み飛ばすと読み取り行数が増える
      cursor: { titleKey: "bulk 510" },
      next: { all: "bulk 511", public: "bulk 512" },
    },
  ] as const)(
    "$sort の順は、cursor の有無にかかわらず limit の数倍で止まる",
    async ({ sort, cursor, next }) => {
      await seed();
      for (const readable of ["all", "public"] as const) {
        const first = meteredDb();
        const page = await listRecentPages(first.db, {
          limit: 20,
          readable,
          ...({ sort, cursor: null } as ListOrder),
        });
        expect(page.pages, `${sort} ${readable}`).toHaveLength(20);
        expect(first.counter.rowsRead, `${sort} ${readable}`).toBeLessThan(300);

        const later = meteredDb();
        const deeper = await listRecentPages(later.db, {
          limit: 20,
          readable,
          ...({ sort, cursor } as ListOrder),
        });
        expect(deeper.pages[0]?.title, `${sort} ${readable}`).toBe(next[readable]);
        expect(later.counter.rowsRead, `${sort} ${readable}`).toBeLessThan(300);
      }
    },
  );

  it("public のページの一覧は、それより新しい draft の行を読まない", async () => {
    const publicPages = 200;
    // 古い publicPages 件だけを public にし、残りの draft をすべてそれより新しくする
    await env.DB.prepare(
      `INSERT INTO pages (id, title, title_key, body, visibility, version, created_at, updated_at)
       SELECT printf('%022d', value), 'bulk ' || value, 'bulk ' || value, '',
              CASE WHEN value < ?3 THEN 'public' ELSE 'draft' END, 1, ?2 + value, ?2 + value
       FROM json_each(?1)`,
    )
      .bind(JSON.stringify(Array.from({ length: PAGES }, (_, i) => i)), T0, publicPages)
      .run();
    const metered = meteredDb();
    const pages = await listPublicPages(metered.db, { limit: 100 });
    expect(pages).toHaveLength(100);
    expect(pages[0]?.title).toBe(`bulk ${publicPages - 1}`);
    // draft の行も読むと 1,900 行になる。部分インデックスを使わないクエリでも結果は変わらないので、行数で確かめる
    expect(metered.counter.rowsRead).toBeLessThan(300);
  });
});
