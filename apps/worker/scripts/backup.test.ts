import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  backup,
  backupDirName,
  countSql,
  DATA_TABLES,
  defaultIo,
  EXCLUDED_TABLES,
  executeArgs,
  load,
  loadArgs,
  migrationsCompatible,
  parseArgs,
  parseManifest,
  rowStatements,
  run,
  STATEMENT_LIMIT,
  sanitizeStderr,
  selectSql,
  TABLE_MIGRATIONS,
  TABLES,
  TOKEN_TABLES,
  tablesToDump,
} from "./backup.mjs";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR).sort();
/** attachments の表を足す前の migration */
const BEFORE_ATTACHMENTS = MIGRATION_FILES.filter((f) => f < "0006_attachments.sql");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "backup-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** migration を適用した D1 の代わりの SQLite。wrangler が付ける d1_migrations も作る */
function migratedDb(files = MIGRATION_FILES) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)");
  for (const name of files) {
    db.exec(readFileSync(new URL(name, MIGRATIONS_DIR), "utf8"));
    db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
  }
  return db;
}

type Spawn = (command: string, args: string[]) => { status: number | null; stdout: string };

/** `wrangler d1 execute` を SQLite に対して実行する。onCommand で呼び出しを観測したり割り込んだりできる */
function fakeWrangler(db: DatabaseSync, onCommand?: (sql: string) => void): Spawn {
  return (_command, args) => {
    const w = args.slice(1);
    const command = w.indexOf("--command");
    if (command >= 0) {
      const sql = w[command + 1] as string;
      onCommand?.(sql);
      return { status: 0, stdout: JSON.stringify([{ results: db.prepare(sql).all() }]) };
    }
    db.exec(readFileSync(w[w.indexOf("--file") + 1] as string, "utf8"));
    return { status: 0, stdout: "" };
  };
}

function ioFor(
  db: DatabaseSync,
  over: Record<string, unknown> = {},
  onCommand?: (sql: string) => void,
) {
  const out = { stderr: "" };
  const io = {
    ...defaultIo,
    spawn: fakeWrangler(db, onCommand),
    stderr: { write: (chunk: string) => (out.stderr += chunk) },
    now: () => new Date("2026-10-14T12:34:56.789Z"),
    ...over,
  } as typeof defaultIo;
  return { io, out };
}

/** 文字列を CAST(X'…' AS TEXT) で SQL に書く。NUL や改行、引用符を含んでも変わらない */
const lit = (s: string | null) =>
  s === null ? "NULL" : `CAST(X'${Buffer.from(s).toString("hex")}' AS TEXT)`;

interface PageSeed {
  id: string;
  title: string;
  body: string;
  versions?: number;
  deleted?: boolean;
}

function seedPage(db: DatabaseSync, p: PageSeed) {
  const versions = p.versions ?? 1;
  const deleted = p.deleted === true;
  db.exec(
    `INSERT INTO pages (id, visibility, version, created_at, updated_at, deleted_at, deleted_by, title_key, title, body) VALUES (${lit(p.id)}, 'draft', ${versions}, 1, 2, ${deleted ? 3 : "NULL"}, ${deleted ? lit("owner") : "NULL"}, ${lit(p.id)}, ${lit(p.title)}, ${lit(p.body)})`,
  );
  for (let v = 1; v <= versions; v++) {
    db.exec(
      `INSERT INTO revisions (page_id, version, actor, created_at, title, body) VALUES (${lit(p.id)}, ${v}, ${lit(`token:t${v}`)}, ${v}, ${lit(p.title)}, ${lit(`${p.body}#${v}`)})`,
    );
  }
}

/** 本文の復元で壊れやすいものを集めたページ */
const NASTY_BODY = [
  "literal backslash-n: a\\nb and a\\rb and \\\\ and \\0",
  "real newline:\nCR:\rCRLF:\r\nend",
  "quotes: ' \" `; semicolon; -- comment /* x */",
  "emoji: 😀👨‍👩‍👧 日本語 ｶﾅ",
  "nul:\u0000in the middle\u0000",
].join("\n");

function seedNasty(db: DatabaseSync) {
  seedPage(db, { id: "aaaaaaaaaaaaaaaaaaaaaa", title: NASTY_BODY, body: NASTY_BODY, versions: 2 });
  seedPage(db, { id: "bbbbbbbbbbbbbbbbbbbbbb", title: "", body: "", deleted: true });
  seedPage(db, { id: "cccccccccccccccccccccc", title: "x", body: "a\\nb" });
}

function dump(db: DatabaseSync, table: string) {
  const columns = (TABLES[table]?.columns ?? []).map((c) =>
    c.kind === "text" ? `hex(${c.name}) AS ${c.name}, typeof(${c.name}) AS ${c.name}_t` : c.name,
  );
  const key = TABLES[table]?.key.join(", ");
  return JSON.stringify(
    db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${key}`).all(),
  );
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
    expect(() => parseArgs(["--out", "--remote"])).toThrow("--out needs");
    expect(() => parseArgs(["--out=-x"])).toThrow("--out needs");
    expect(() => parseArgs(["load"])).toThrow("load needs");
    expect(() => parseArgs(["load", "a", "b"])).toThrow("unexpected argument");
    expect(() => parseArgs(["load", "a", "--with-tokens"])).toThrow("only for backup");
    expect(() => parseArgs(["load", "a", "--out", "b"])).toThrow("only for backup");
  });
});

describe("ダンプする表", () => {
  it("既定は pages、revisions、attachments で、api_tokens は --with-tokens でだけ足す", () => {
    expect(tablesToDump(false, MIGRATION_FILES)).toEqual(["pages", "revisions", "attachments"]);
    expect(tablesToDump(true, MIGRATION_FILES)).toEqual([
      "pages",
      "revisions",
      "attachments",
      "api_tokens",
    ]);
    expect(DATA_TABLES).not.toContain("pages_fts");
    expect(DATA_TABLES).not.toContain("attachment_refs");
    expect(EXCLUDED_TABLES.attachment_refs).toBe("derived");
    expect(TOKEN_TABLES).toEqual(["api_tokens"]);
  });

  it("表を作る migration が一覧に無ければ、その表をダンプしない", () => {
    expect(tablesToDump(false, BEFORE_ATTACHMENTS)).toEqual(["pages", "revisions"]);
    expect(tablesToDump(true, BEFORE_ATTACHMENTS)).toEqual(["pages", "revisions", "api_tokens"]);
    for (const [table, migration] of Object.entries(TABLE_MIGRATIONS)) {
      expect(MIGRATION_FILES, table).toContain(migration);
      const before = MIGRATION_FILES.slice(0, MIGRATION_FILES.indexOf(migration));
      const tables = migratedDb(before)
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .all(table);
      expect(tables, table).toEqual([]);
    }
  });

  it("migration を適用した DB の表は、ダンプするか除外するかのどちらかに分類されている", () => {
    const db = migratedDb();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'pages_fts_%' AND name <> 'd1_migrations'",
      )
      .all()
      .map((r) => r.name as string);
    const classified = new Set([...Object.keys(TABLES), ...Object.keys(EXCLUDED_TABLES)]);
    expect(tables.filter((t) => !classified.has(t))).toEqual([]);
    expect([...classified].filter((t) => !tables.includes(t))).toEqual([]);
  });

  it("TABLES の列は、migration を適用した DB の列と順序も型も一致する", () => {
    const db = migratedDb();
    for (const [table, spec] of Object.entries(TABLES)) {
      const actual = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => `${r.name}:${String(r.type).toUpperCase() === "INTEGER" ? "int" : "text"}`);
      expect(spec.columns.map((c) => `${c.name}:${c.kind}`)).toEqual(actual);
      const pk = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .filter((r) => Number(r.pk) > 0)
        .map((r) => r.name);
      expect([...pk].sort()).toEqual([...spec.key].sort());
    }
  });
});

describe("wrangler への引数", () => {
  it("execute は --json で SELECT を渡し、remote は合成した設定を付ける", () => {
    expect(executeArgs("SELECT 1", { remote: false })).toEqual([
      "d1",
      "execute",
      "DB",
      "--local",
      "--json",
      "--command",
      "SELECT 1",
    ]);
    const remote = executeArgs("SELECT 1", { remote: true, configPath: "/c.json" });
    expect(remote).toContain("--remote");
    expect(remote.slice(remote.indexOf("--config"), remote.indexOf("--config") + 2)).toEqual([
      "--config",
      "/c.json",
    ]);
    expect(remote).not.toContain("--local");
  });

  it("load は SQL ファイルを --file で流し、d1 export は使わない", () => {
    expect(loadArgs("/o/data.sql", { remote: false })).toEqual([
      "d1",
      "execute",
      "DB",
      "--local",
      "--yes",
      "--file",
      "/o/data.sql",
    ]);
    expect(selectSql("pages", null)).not.toContain("export");
  });

  it("SELECT は文字列の列を hex() で受け、続きは主キーの後ろから読む", () => {
    expect(selectSql("pages", null)).toContain('hex("body")');
    expect(selectSql("pages", null)).not.toContain('hex("seq")');
    expect(selectSql("pages", [5])).toContain('("seq") > (5)');
    expect(selectSql("revisions", ["6162", 3])).toContain(
      '("page_id", "version") > (CAST(X\'6162\' AS TEXT), 3)',
    );
    expect(() => selectSql("revisions", ["x'; DROP", 3])).toThrow("not a hex string");
  });

  it("行数の SQL は表ごとの SELECT を UNION ALL でつなぐ", () => {
    expect(countSql(["pages", "revisions"])).toBe(
      "SELECT 'pages' AS t, count(*) AS n FROM \"pages\" UNION ALL SELECT 'revisions' AS t, count(*) AS n FROM \"revisions\"",
    );
  });
});

describe("rowStatements", () => {
  it("本文が最大（64 KiB）でも、すべての文が D1 の上限（100 KB）に収まる", () => {
    // 3 バイトと 4 バイトの文字を混ぜ、分割位置が文字の途中にならないことも確かめる
    const body = `${"あ😀".repeat(9362)}aa`;
    expect(Buffer.byteLength(body)).toBe(65536);
    const hex = Buffer.from(body).toString("hex").toUpperCase();
    const row = [1, "AA", "6472616674", 1, 1, 2, null, null, "AA", "AA", hex];
    const statements = rowStatements("pages", row);
    expect(statements.length).toBeGreaterThan(1);
    for (const s of statements) expect(Buffer.byteLength(s)).toBeLessThan(STATEMENT_LIMIT);
    expect(statements.every((s) => !s.includes("\n"))).toBe(true);

    const db = migratedDb();
    db.exec(statements.join("\n"));
    const restored = db.prepare("SELECT hex(body) AS h FROM pages").get() as { h: string };
    expect(restored.h).toBe(hex);
  });

  it("空の本文は空文字列として入り、NULL とは区別される", () => {
    const db = migratedDb();
    db.exec(
      rowStatements("pages", [1, "AA", "6472616674", 1, 1, 2, null, null, "AA", "", ""]).join("\n"),
    );
    expect(
      db.prepare("SELECT typeof(body) AS b, typeof(deleted_at) AS d FROM pages").get(),
    ).toMatchObject({
      b: "text",
      d: "null",
    });
  });
});

describe("backupDirName", () => {
  it("UTC の日時と対象を含み、ファイル名に使えない文字を含まない", () => {
    const date = new Date("2026-10-14T12:34:56.789Z");
    expect(backupDirName(date, false)).toBe("2026-10-14T12-34-56Z-local");
    expect(backupDirName(date, true)).toBe("2026-10-14T12-34-56Z-remote");
  });
});

describe("backup と load の往復", () => {
  it("2 文字の \\n と本物の改行、NUL、引用符、絵文字、空文字列、NULL を含む本文が完全に一致する", () => {
    const source = migratedDb();
    seedNasty(source);
    source.exec(
      `INSERT INTO api_tokens (name, token_hash, scopes, created_at) VALUES (${lit("t1")}, ${lit("deadbeef")}, ${lit("read write")}, 1)`,
    );
    source.exec(
      `INSERT INTO attachments (name, content_type, size, created_at, created_by) VALUES (${lit("AAAAAAAAAAAAAAAAAAAAAA.png")}, ${lit("image/png")}, 12, 1, ${lit("owner")})`,
    );
    const out = tmp();
    const { io, out: log } = ioFor(source);
    const result = backup({ command: "backup", remote: false, out, withTokens: true }, io);
    expect(result.tables).toMatchObject({
      pages: { rows: 3 },
      revisions: { rows: 4 },
      attachments: { rows: 1 },
      api_tokens: { rows: 1 },
    });
    expect(result.skippedRevisions).toBe(0);
    const files = readdirSync(result.dir).sort();
    expect(files).toEqual(["data.sql", "manifest.json"]);
    for (const line of readFileSync(join(result.dir, "data.sql"), "utf8").split("\n")) {
      expect(Buffer.byteLength(line)).toBeLessThan(STATEMENT_LIMIT);
    }

    const dest = migratedDb();
    const loaded = load({ command: "load", remote: false, dir: result.dir }, ioFor(dest).io);
    expect(loaded.tables).toEqual(result.tables);
    for (const table of ["pages", "revisions", "attachments", "api_tokens"]) {
      expect(dump(dest, table)).toBe(dump(source, table));
    }
    // hex の突き合わせに加えて、文字列としても同じか
    expect(
      dest.prepare("SELECT body FROM pages WHERE id = 'cccccccccccccccccccccc'").get(),
    ).toEqual({
      body: "a\\nb",
    });
    expect(log.stderr).toBe("");
  });

  it("既定では api_tokens を出さない", () => {
    const source = migratedDb();
    seedNasty(source);
    source.exec(
      `INSERT INTO api_tokens (name, token_hash, scopes, created_at) VALUES (${lit("t1")}, ${lit("deadbeef")}, ${lit("read")}, 1)`,
    );
    const { io } = ioFor(source);
    const result = backup({ command: "backup", remote: false, out: tmp(), withTokens: false }, io);
    expect(Object.keys(result.tables)).toEqual(["pages", "revisions", "attachments"]);
    expect(readFileSync(join(result.dir, "data.sql"), "utf8")).not.toContain("api_tokens");
  });

  it("大きな本文が多くても batch に分けて読み、往復で一致する", () => {
    const source = migratedDb();
    const body = "x\\n".repeat(15_000);
    const commands: string[] = [];
    for (let i = 0; i < 130; i++) {
      seedPage(source, {
        id: `p${String(i).padStart(21, "0")}`,
        title: `t${i}`,
        body: `${body}${i}`,
        versions: i % 3 === 0 ? 2 : 1,
      });
    }
    const { io } = ioFor(source, {}, (sql) => commands.push(sql));
    const result = backup({ command: "backup", remote: false, out: tmp(), withTokens: false }, io);
    expect(commands.filter((c) => c.includes('FROM "pages"')).length).toBeGreaterThan(3);
    expect(result.tables.pages?.rows).toBe(130);
    expect(result.tables.revisions?.rows).toBe(130 + 44);

    const dest = migratedDb();
    load({ command: "load", remote: false, dir: result.dir }, ioFor(dest).io);
    expect(dump(dest, "pages")).toBe(dump(source, "pages"));
    expect(dump(dest, "revisions")).toBe(dump(source, "revisions"));
  });

  it("読んでいる間に増えたページと版は、dump に入れず、load が失敗しない", () => {
    const source = migratedDb();
    seedPage(source, { id: "aaaaaaaaaaaaaaaaaaaaaa", title: "a", body: "a", versions: 1 });
    let injected = false;
    const { io, out } = ioFor(source, {}, (sql) => {
      // pages を読み終えて revisions に移った時点で、保存とページの作成を割り込ませる
      if (!injected && sql.includes('FROM "revisions"')) {
        injected = true;
        source.exec("UPDATE pages SET version = 2 WHERE id = 'aaaaaaaaaaaaaaaaaaaaaa'");
        source.exec(
          `INSERT INTO revisions (page_id, version, actor, created_at, title, body) VALUES ('aaaaaaaaaaaaaaaaaaaaaa', 2, 'owner', 2, 'a', 'a2')`,
        );
        seedPage(source, { id: "bbbbbbbbbbbbbbbbbbbbbb", title: "b", body: "b" });
      }
    });
    const result = backup({ command: "backup", remote: false, out: tmp(), withTokens: false }, io);
    expect(injected).toBe(true);
    expect(result.tables.pages?.rows).toBe(1);
    expect(result.tables.revisions?.rows).toBe(1);
    expect(result.skippedRevisions).toBe(2);

    const dest = migratedDb();
    load({ command: "load", remote: false, dir: result.dir }, ioFor(dest).io);
    expect(dest.prepare("SELECT version FROM pages").all()).toEqual([{ version: 1 }]);
    expect(out.stderr).toBe("");
  });

  it("pages の batch の間に title を手放したページがあり、後のページがそれを取ると、失敗して出力を残さない", () => {
    const source = migratedDb();
    const body = "x".repeat(60_000);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const id = `p${String(i).padStart(21, "0")}`;
      ids.push(id);
      seedPage(source, { id, title: `t${i}`, body });
    }
    let pagesReads = 0;
    const { io } = ioFor(source, {}, (sql) => {
      if (!sql.includes('FROM "pages"')) return;
      pagesReads++;
      // 先頭のページは読み終えているので、削除して title_key を空け、まだ読んでいない最後のページに移す
      if (pagesReads === 2) {
        source.exec(`UPDATE pages SET deleted_at = 3, deleted_by = 'owner' WHERE id = '${ids[0]}'`);
        source.exec(`UPDATE pages SET title_key = '${ids[0]}' WHERE id = '${ids[29]}'`);
      }
    });
    const out = tmp();
    expect(() => backup({ command: "backup", remote: false, out, withTokens: false }, io)).toThrow(
      "pages changed while reading",
    );
    expect(pagesReads).toBeGreaterThan(1);
    expect(readdirSync(out)).toEqual([]);
  });

  it("remote で pages が 0 件なら失敗し、local では警告にとどめる", () => {
    const empty = migratedDb();
    const remote = ioFor(empty, { resolveRemote: () => "/c.json" });
    expect(() =>
      backup({ command: "backup", remote: true, out: tmp(), withTokens: false }, remote.io),
    ).toThrow("not keeping an empty backup");
    const local = ioFor(empty);
    expect(run(["--out", tmp()], local.io)).toBe(0);
    expect(local.out.stderr).toContain("warning: no pages were dumped");
  });
});

describe("attachments の表を足す前の D1", () => {
  const args = (dir: string) => ({ command: "load", remote: false, dir }) as const;

  function backedUpBeforeAttachments() {
    const source = migratedDb(BEFORE_ATTACHMENTS);
    seedNasty(source);
    const result = backup(
      { command: "backup", remote: false, out: tmp(), withTokens: false },
      ioFor(source).io,
    );
    return { source, result };
  }

  it("バックアップでき、manifest に attachments を載せない", () => {
    const { result } = backedUpBeforeAttachments();
    expect(Object.keys(result.tables)).toEqual(["pages", "revisions"]);
    const manifest = JSON.parse(readFileSync(join(result.dir, "manifest.json"), "utf8"));
    expect(Object.keys(manifest.tables)).toEqual(["pages", "revisions"]);
    expect(manifest.migrations).toEqual(BEFORE_ATTACHMENTS);
  });

  it("そのバックアップを、同じ時点の D1 にも、attachments を足した D1 にも load できる", () => {
    const { source, result } = backedUpBeforeAttachments();
    for (const dest of [migratedDb(BEFORE_ATTACHMENTS), migratedDb()]) {
      load(args(result.dir), ioFor(dest).io);
      for (const table of ["pages", "revisions"]) {
        expect(dump(dest, table), table).toBe(dump(source, table));
      }
    }
  });

  it("復元先の attachments に行があれば、manifest に無い表でも拒否する", () => {
    const { result } = backedUpBeforeAttachments();
    const dest = migratedDb();
    dest.exec(
      `INSERT INTO attachments (name, content_type, size, created_at, created_by) VALUES (${lit("AAAAAAAAAAAAAAAAAAAAAA.png")}, ${lit("image/png")}, 1, 1, ${lit("owner")})`,
    );
    expect(() => load(args(result.dir), ioFor(dest).io)).toThrow("not empty (attachments)");
    expect(dest.prepare("SELECT count(*) AS n FROM pages").get()).toEqual({ n: 0 });
  });
});

describe("load の検証", () => {
  function backedUp() {
    const source = migratedDb();
    seedNasty(source);
    const result = backup(
      { command: "backup", remote: false, out: tmp(), withTokens: false },
      ioFor(source).io,
    );
    return result.dir;
  }
  const args = (dir: string) => ({ command: "load", remote: false, dir }) as const;

  it("対象の表に行があれば、何も流さずに拒否する", () => {
    const dir = backedUp();
    const dest = migratedDb();
    seedPage(dest, { id: "zzzzzzzzzzzzzzzzzzzzzz", title: "z", body: "z" });
    expect(() => load(args(dir), ioFor(dest).io)).toThrow("not empty (pages, revisions)");
    expect(dest.prepare("SELECT count(*) AS n FROM pages").get()).toEqual({ n: 1 });
  });

  it("migration が未適用の D1 は拒否する", () => {
    const dir = backedUp();
    const dest = new DatabaseSync(":memory:");
    expect(() => load(args(dir), ioFor(dest).io)).toThrow("cannot read d1_migrations");
  });

  it("migration の一覧が食い違えば拒否し、復元先が先に進んでいるのは許す", () => {
    const dir = backedUp();
    const behind = migratedDb(MIGRATION_FILES.slice(0, 2));
    expect(() => load(args(dir), ioFor(behind).io)).toThrow("migrations differ");

    const ahead = migratedDb();
    ahead.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run("9999_future.sql");
    expect(load(args(dir), ioFor(ahead).io).ahead).toEqual(["9999_future.sql"]);

    expect(migrationsCompatible(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(migrationsCompatible(["a", "b"], ["a", "c"])).toBe(false);
    expect(migrationsCompatible(["a", "b"], ["a"])).toBe(false);
  });

  it("行数が同じでも、内容が違えば digest で検出する", () => {
    const dir = backedUp();
    const dataPath = join(dir, "data.sql");
    const data = readFileSync(dataPath, "utf8");
    // actor の token:t1 の 1 文字を変える（長さも行数も変わらない）
    const draft = Buffer.from("token:t1").toString("hex").toUpperCase();
    expect(data).toContain(draft);
    writeFileSync(
      dataPath,
      data.replace(draft, Buffer.from("token:t9").toString("hex").toUpperCase()),
    );
    expect(() => load(args(dir), ioFor(migratedDb()).io)).toThrow("restored data differs");
  });

  it("manifest の無い（不完全な）ディレクトリは拒否する", () => {
    const dir = backedUp();
    rmSync(join(dir, "manifest.json"));
    expect(() => load(args(dir), ioFor(migratedDb()).io)).toThrow("not a complete backup");
  });
});

describe("backup の失敗", () => {
  it("wrangler が失敗したら作りかけのディレクトリを消し、標準出力を表示しない", () => {
    const out = tmp();
    const { io } = ioFor(migratedDb(), {
      spawn: () => ({
        status: 1,
        stdout: "SECRET-BODY https://signed.example/url",
        stderr: `failed ${"ab".repeat(100)}`,
      }),
    });
    let message = "";
    try {
      backup({ command: "backup", remote: false, out, withTokens: false }, io);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("wrangler exited with 1");
    expect(message).not.toContain("SECRET-BODY");
    expect(message).not.toContain("ab".repeat(30));
    expect(readdirSync(out)).toEqual([]);
  });

  it("--json の失敗は、標準出力のエラーの文だけを表示する", () => {
    const { io } = ioFor(migratedDb(), {
      spawn: () => ({
        status: 1,
        stdout: JSON.stringify({
          error: {
            text: "no such column: x: SQLITE_ERROR",
            notes: [{ text: "see the docs" }],
            body: "SECRET-BODY",
          },
        }),
        stderr: "",
      }),
    });
    let message = "";
    try {
      backup({ command: "backup", remote: false, out: tmp(), withTokens: false }, io);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("wrangler exited with 1:\nno such column: x: SQLITE_ERROR\nsee the docs");
  });

  it("出力先が既にあれば失敗し、前のバックアップを消さない", () => {
    const out = tmp();
    const existing = join(out, backupDirName(new Date("2026-10-14T12:34:56.789Z"), false));
    mkdirSync(existing);
    writeFileSync(join(existing, "keep.txt"), "previous");
    const { io } = ioFor(migratedDb());
    expect(() => backup({ command: "backup", remote: false, out, withTokens: false }, io)).toThrow(
      "EEXIST",
    );
    expect(readFileSync(join(existing, "keep.txt"), "utf8")).toBe("previous");
  });

  it("出力が JSON でなければ、出力を含めずに失敗する", () => {
    const { io } = ioFor(migratedDb(), { spawn: () => ({ status: 0, stdout: "private text" }) });
    expect(() =>
      backup({ command: "backup", remote: false, out: tmp(), withTokens: false }, io),
    ).toThrow(/^unexpected output from wrangler d1 execute$/);
  });
});

describe("sanitizeStderr", () => {
  it("長い hex の並びを省き、長さを切る", () => {
    expect(sanitizeStderr(`error ${"AB".repeat(50)} end`)).toBe("error … end");
    expect(sanitizeStderr("x".repeat(2000)).length).toBeLessThan(1100);
  });
});

describe("parseManifest", () => {
  const sha = "a".repeat(64);
  const valid = {
    version: 1,
    createdAt: "2026-10-14T00:00:00.000Z",
    target: "local",
    file: "data.sql",
    migrations: ["0001_a.sql"],
    tables: { pages: { rows: 1, sha256: sha }, revisions: { rows: 2, sha256: sha } },
  };
  const withAttachments = {
    ...valid,
    migrations: ["0001_a.sql", "0006_attachments.sql"],
    tables: { ...valid.tables, attachments: { rows: 0, sha256: sha } },
  };

  it("許可した表だけの manifest を通す", () => {
    // attachments の表を足す前に取ったバックアップも load できる
    expect(parseManifest(valid).tables.pages?.rows).toBe(1);
    expect(parseManifest(withAttachments)).toBeTruthy();
    expect(
      parseManifest({
        ...valid,
        tables: { ...valid.tables, api_tokens: { rows: 0, sha256: sha } },
      }),
    ).toBeTruthy();
  });

  it("SQL に埋め込めない表名、必須の表の欠落、不正な digest、別のファイル名を拒否する", () => {
    const bad = (patch: object) => () => parseManifest({ ...valid, ...patch });
    expect(bad({ tables: { ...valid.tables, "x; --": { rows: 1, sha256: sha } } })).toThrow(
      "unexpected tables",
    );
    expect(bad({ tables: { pages: valid.tables.pages } })).toThrow("unexpected tables");
    expect(bad({ tables: { ...valid.tables, pages: { rows: -1, sha256: sha } } })).toThrow(
      "unexpected tables",
    );
    expect(bad({ tables: { ...valid.tables, pages: { rows: 1, sha256: "zz" } } })).toThrow(
      "unexpected tables",
    );
    // migration の一覧と表が食い違うもの
    expect(bad({ migrations: withAttachments.migrations })).toThrow("unexpected tables");
    expect(bad({ tables: withAttachments.tables })).toThrow("unexpected tables");
    expect(bad({ file: "../x.sql" })).toThrow("not a backup manifest");
    expect(bad({ migrations: "x" })).toThrow("not a backup manifest");
    expect(() => parseManifest(null)).toThrow("not a backup manifest");
  });
});
