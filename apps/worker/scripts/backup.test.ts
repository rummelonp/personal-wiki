import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  backup,
  backupDirName,
  countInserts,
  countSql,
  DATA_TABLES,
  EXCLUDED_TABLES,
  exportArgs,
  load,
  loadArgs,
  parseArgs,
  parseCounts,
  parseManifest,
  run,
  TOKEN_TABLES,
  tablesToDump,
} from "./backup.mjs";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

const DUMP = [
  "PRAGMA defer_foreign_keys=TRUE;",
  `INSERT INTO "pages" ("seq","id") VALUES(1,'a');`,
  `INSERT INTO "pages" ("seq","id","body") VALUES(2,'b',replace('1\\n2','\\n',char(10)));`,
  `INSERT INTO "revisions" ("page_id") VALUES('a');`,
  `INSERT INTO "api_tokens" ("name") VALUES('t');`,
  "",
].join("\n");

interface Recorded {
  spawns: string[][];
  files: Map<string, string>;
  removed: string[];
  stderr: string;
}

/**
 * wrangler とファイルを差し替えた Io。export は DUMP を出力先に書き、execute は counts を順に返す。
 * counts は { 表: 行数 } の並びで、1 回の行数の問い合わせにつき 1 つ使う。
 */
function fakeIo(options: { counts?: Record<string, number>[]; failOn?: string } = {}) {
  const rec: Recorded = { spawns: [], files: new Map(), removed: [], stderr: "" };
  const counts = [...(options.counts ?? [])];
  const io = {
    spawn: (_command: string, args: string[]) => {
      // 先頭は wrangler の bin のパス。以降が wrangler への引数
      const wranglerArgs = args.slice(1);
      rec.spawns.push(wranglerArgs);
      if (options.failOn !== undefined && wranglerArgs.includes(options.failOn)) {
        return { status: 1, stdout: "" };
      }
      if (wranglerArgs[1] === "export") {
        rec.files.set(wranglerArgs[wranglerArgs.indexOf("--output") + 1] as string, DUMP);
        return { status: 0, stdout: "" };
      }
      if (wranglerArgs.includes("--json")) {
        const next = counts.shift() ?? {};
        const results = Object.entries(next).map(([t, n]) => ({ t, n }));
        return { status: 0, stdout: JSON.stringify([{ results }]) };
      }
      return { status: 0, stdout: "" };
    },
    stderr: { write: (chunk: string) => (rec.stderr += chunk) },
    now: () => new Date("2026-10-14T12:34:56.789Z"),
    fs: {
      mkdir: () => {},
      rm: (path: string) => rec.removed.push(path),
      read: (path: string) => {
        const text = rec.files.get(path);
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      },
      write: (path: string, text: string) => rec.files.set(path, text),
      exists: (path: string) => rec.files.has(path),
      restrict: () => {},
    },
    resolveRemote: () => "/work/wrangler.deploy.json",
  };
  return { io, rec };
}

describe("parseArgs", () => {
  it("既定はローカルで、出力先は apps/worker/backups", () => {
    const args = parseArgs([]);
    expect(args).toMatchObject({ command: "backup", remote: false, withTokens: false });
    expect(args.command === "backup" && args.out).toMatch(/apps\/worker\/backups$/);
  });

  it("--remote、--out、--with-tokens を受け取る", () => {
    expect(parseArgs(["--remote", "--out", "/tmp/b", "--with-tokens"])).toEqual({
      command: "backup",
      remote: true,
      out: "/tmp/b",
      withTokens: true,
    });
    expect(parseArgs(["--out=/tmp/c"])).toMatchObject({ out: "/tmp/c" });
  });

  it("load は dir を取る", () => {
    expect(parseArgs(["load", "backups/x", "--remote"])).toEqual({
      command: "load",
      remote: true,
      dir: "backups/x",
    });
  });

  it("不正な引数を拒否する", () => {
    expect(() => parseArgs(["--force"])).toThrow("unknown option");
    expect(() => parseArgs(["extra"])).toThrow("unexpected argument");
    expect(() => parseArgs(["--out"])).toThrow("--out needs");
    expect(() => parseArgs(["load"])).toThrow("load needs");
    expect(() => parseArgs(["load", "a", "b"])).toThrow("unexpected argument");
    expect(() => parseArgs(["load", "a", "--with-tokens"])).toThrow("only for backup");
    expect(() => parseArgs(["load", "a", "--out", "b"])).toThrow("only for backup");
  });
});

describe("ダンプする表", () => {
  it("既定は pages と revisions で、api_tokens は --with-tokens でだけ足す", () => {
    expect(tablesToDump(false)).toEqual(["pages", "revisions"]);
    expect(tablesToDump(true)).toEqual(["pages", "revisions", "api_tokens"]);
  });

  it("migrations の表は、ダンプするか除外するかのどちらかに分類されている", () => {
    const created = new Set<string>();
    for (const name of readdirSync(MIGRATIONS_DIR)) {
      const sql = readFileSync(new URL(name, MIGRATIONS_DIR), "utf8");
      for (const m of sql.matchAll(/^CREATE (?:VIRTUAL )?TABLE (\w+)/gm)) {
        created.add(m[1] as string);
      }
    }
    const classified = new Set([...DATA_TABLES, ...TOKEN_TABLES, ...Object.keys(EXCLUDED_TABLES)]);
    expect([...created].filter((t) => !classified.has(t))).toEqual([]);
    expect([...classified].filter((t) => !created.has(t))).toEqual([]);
  });

  it("FTS の仮想テーブルはダンプしない", () => {
    expect(DATA_TABLES).not.toContain("pages_fts");
    expect(TOKEN_TABLES).not.toContain("pages_fts");
  });
});

describe("wrangler への引数", () => {
  it("export は表を 1 回にまとめ、スキーマを出さない", () => {
    expect(exportArgs(["pages", "revisions"], "/o/data.sql", { remote: false })).toEqual([
      "d1",
      "export",
      "DB",
      "--local",
      "--no-schema",
      "--table",
      "pages",
      "--table",
      "revisions",
      "--output",
      "/o/data.sql",
      "--skip-confirmation",
    ]);
  });

  it("remote は合成した設定を渡す", () => {
    const args = exportArgs(["pages"], "/o/data.sql", { remote: true, configPath: "/c.json" });
    expect(args).toContain("--remote");
    expect(args.slice(args.indexOf("--config"), args.indexOf("--config") + 2)).toEqual([
      "--config",
      "/c.json",
    ]);
    expect(args).not.toContain("--local");
  });

  it("load は SQL ファイルを --file で流す", () => {
    expect(loadArgs("/o/data.sql", { remote: false })).toEqual([
      "d1",
      "execute",
      "DB",
      "--local",
      "--yes",
      "--file",
      "/o/data.sql",
    ]);
  });

  it("行数の SQL は表ごとの SELECT を UNION ALL でつなぐ", () => {
    expect(countSql(["pages", "revisions"])).toBe(
      "SELECT 'pages' AS t, count(*) AS n FROM pages UNION ALL SELECT 'revisions' AS t, count(*) AS n FROM revisions",
    );
  });
});

describe("countInserts", () => {
  it("行頭の INSERT を表ごとに数え、本文中の改行は退避済みとして 1 行に数える", () => {
    expect(countInserts(DUMP, ["pages", "revisions", "api_tokens"])).toEqual({
      pages: 2,
      revisions: 1,
      api_tokens: 1,
    });
    expect(countInserts(DUMP, ["pages", "revisions"])).toEqual({ pages: 2, revisions: 1 });
  });
});

describe("backupDirName", () => {
  it("UTC の日時と対象を含み、ファイル名に使えない文字を含まない", () => {
    const date = new Date("2026-10-14T12:34:56.789Z");
    expect(backupDirName(date, false)).toBe("2026-10-14T12-34-56Z-local");
    expect(backupDirName(date, true)).toBe("2026-10-14T12-34-56Z-remote");
  });
});

describe("backup", () => {
  it("日時のディレクトリに data.sql と manifest.json を置く", () => {
    const { io, rec } = fakeIo();
    const result = backup({ command: "backup", remote: false, out: "/b", withTokens: false }, io);
    expect(result.dir).toBe("/b/2026-10-14T12-34-56Z-local");
    expect(rec.spawns).toHaveLength(1);
    expect(rec.spawns[0]).toContain("--local");
    expect(rec.spawns[0]).not.toContain("api_tokens");
    const manifest = JSON.parse(rec.files.get(`${result.dir}/manifest.json`) as string);
    expect(manifest).toEqual({
      version: 1,
      createdAt: "2026-10-14T12:34:56.789Z",
      target: "local",
      file: "data.sql",
      rows: { pages: 2, revisions: 1 },
    });
  });

  it("--with-tokens では api_tokens も出す", () => {
    const { io, rec } = fakeIo();
    const result = backup({ command: "backup", remote: false, out: "/b", withTokens: true }, io);
    expect(rec.spawns[0]).toContain("api_tokens");
    expect(result.rows.api_tokens).toBe(1);
  });

  it("--remote は deploy.env から合成した設定で export する", () => {
    const { io, rec } = fakeIo();
    backup({ command: "backup", remote: true, out: "/b", withTokens: false }, io);
    expect(rec.spawns[0]).toContain("--remote");
    expect(rec.spawns[0]).toContain("/work/wrangler.deploy.json");
  });

  it("wrangler が失敗したら、作りかけのディレクトリを消して例外にする", () => {
    const { io, rec } = fakeIo({ failOn: "export" });
    expect(() =>
      backup({ command: "backup", remote: false, out: "/b", withTokens: false }, io),
    ).toThrow("wrangler exited with 1");
    expect(rec.removed).toEqual(["/b/2026-10-14T12-34-56Z-local"]);
    expect(rec.files.size).toBe(0);
  });
});

describe("run (backup)", () => {
  it("行数を表示し、pages が空なら警告する", () => {
    const { io, rec } = fakeIo();
    expect(run(["--out", "/b"], io)).toBe(0);
    expect(rec.stderr).toContain("pages 2, revisions 1");
    expect(rec.stderr).not.toContain("warning");

    const empty = fakeIo();
    empty.io.spawn = (_c, args) => {
      empty.rec.files.set(args[args.indexOf("--output") + 1] as string, "PRAGMA x;\n");
      return { status: 0, stdout: "" };
    };
    expect(run(["--out", "/b"], empty.io)).toBe(0);
    expect(empty.rec.stderr).toContain("warning: no pages were dumped");
  });

  it("不正な引数では wrangler を呼ばずに終了コード 1 にする", () => {
    const { io, rec } = fakeIo();
    expect(run(["--bogus"], io)).toBe(1);
    expect(rec.spawns).toHaveLength(0);
    expect(rec.stderr).toContain("unknown option");
  });
});

describe("parseManifest", () => {
  const valid = {
    version: 1,
    createdAt: "2026-10-14T00:00:00.000Z",
    target: "local",
    file: "data.sql",
    rows: { pages: 1, revisions: 2 },
  };

  it("許可した表だけの manifest を通す", () => {
    expect(parseManifest(valid).rows).toEqual({ pages: 1, revisions: 2 });
    expect(parseManifest({ ...valid, rows: { ...valid.rows, api_tokens: 0 } }).rows).toHaveProperty(
      "api_tokens",
    );
  });

  it("SQL に埋め込めない表名、必須の表の欠落、別のファイル名を拒否する", () => {
    expect(() => parseManifest({ ...valid, rows: { pages: 1, revisions: 1, "x; --": 1 } })).toThrow(
      "unexpected tables",
    );
    expect(() => parseManifest({ ...valid, rows: { pages: 1 } })).toThrow("unexpected tables");
    expect(() => parseManifest({ ...valid, rows: { pages: -1, revisions: 1 } })).toThrow(
      "unexpected tables",
    );
    expect(() => parseManifest({ ...valid, file: "../x.sql" })).toThrow("not a backup manifest");
    expect(() => parseManifest(null)).toThrow("not a backup manifest");
  });
});

describe("parseCounts", () => {
  it("wrangler d1 execute --json の出力から表ごとの行数を取る", () => {
    expect(parseCounts(JSON.stringify([{ results: [{ t: "pages", n: 3 }] }]))).toEqual({
      pages: 3,
    });
  });
});

describe("load", () => {
  const dir = "/b/2026-10-14T12-34-56Z-local";
  const manifest = JSON.stringify({
    version: 1,
    createdAt: "2026-10-14T00:00:00.000Z",
    target: "local",
    file: "data.sql",
    rows: { pages: 2, revisions: 1 },
  });

  function ready(counts: Record<string, number>[]) {
    const made = fakeIo({ counts });
    made.rec.files.set(`${dir}/manifest.json`, manifest);
    made.rec.files.set(`${dir}/data.sql`, DUMP);
    return made;
  }
  const args = { command: "load", remote: false, dir } as const;

  it("空の D1 に data.sql を流し、行数が manifest と一致するのを確かめる", () => {
    const { io, rec } = ready([
      { pages: 0, revisions: 0 },
      { pages: 2, revisions: 1 },
    ]);
    expect(load(args, io)).toEqual({ pages: 2, revisions: 1 });
    expect(rec.spawns).toHaveLength(3);
    expect(rec.spawns[1]).toEqual(loadArgs(`${dir}/data.sql`, { remote: false }));
  });

  it("対象の表に行があれば、何も流さずに拒否する", () => {
    const { io, rec } = ready([{ pages: 1, revisions: 0 }]);
    expect(() => load(args, io)).toThrow("not empty (pages)");
    expect(rec.spawns).toHaveLength(1);
  });

  it("表が無い（migration 未適用）なら、何も流さずに拒否する", () => {
    const { io, rec } = ready([]);
    io.spawn = () => ({ status: 1, stdout: "" });
    expect(() => load(args, io)).toThrow("apply the migrations first");
    expect(rec.spawns).toHaveLength(0);
  });

  it("流した後の行数が manifest と違えば例外にする", () => {
    const { io } = ready([
      { pages: 0, revisions: 0 },
      { pages: 2, revisions: 0 },
    ]);
    expect(() => load(args, io)).toThrow("revisions 0 (expected 1)");
  });

  it("manifest が無い（不完全な）ディレクトリは拒否する", () => {
    const { io, rec } = fakeIo();
    rec.files.set(`${dir}/data.sql`, DUMP);
    expect(() => load(args, io)).toThrow("not a complete backup");
  });
});
