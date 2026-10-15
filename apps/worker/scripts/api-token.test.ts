import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  formatList,
  generateToken,
  hashToken,
  issueSql,
  main,
  parseArgs,
  revokeSql,
  run,
  wranglerArgs,
} from "./api-token.mjs";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR).sort();

/** migration を適用した D1 の代わりの SQLite */
function migratedDb(files = MIGRATION_FILES) {
  const db = new DatabaseSync(":memory:");
  for (const name of files) db.exec(readFileSync(new URL(name, MIGRATIONS_DIR), "utf8"));
  return db;
}

describe("generateToken", () => {
  it("32 バイトの乱数を 43 文字の base64url にする", () => {
    const tokens = Array.from({ length: 20 }, () => generateToken());
    expect(new Set(tokens).size).toBe(20);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
    }
  });
});

describe("hashToken", () => {
  it("Worker の hashApiToken と同じ SHA-256 の小文字 hex を返す", () => {
    expect(hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("parseArgs", () => {
  it("既定はローカルで、--remote を付けたときだけリモートにする", () => {
    expect(parseArgs(["issue", "laptop", "--scopes", "read"])).toEqual({
      command: "issue",
      name: "laptop",
      scopes: "read",
      remote: false,
    });
    expect(parseArgs(["revoke", "laptop", "--remote"])).toEqual({
      command: "revoke",
      name: "laptop",
      remote: true,
    });
    expect(parseArgs(["list", "--remote"])).toEqual({ command: "list", remote: true });
  });

  it("revoke は --id でも指定でき、名前と --id の両方は拒否する", () => {
    expect(parseArgs(["revoke", "--id", "12"])).toEqual({
      command: "revoke",
      id: 12,
      remote: false,
    });
    expect(parseArgs(["revoke", "--id=3", "--remote"])).toEqual({
      command: "revoke",
      id: 3,
      remote: true,
    });
    expect(() => parseArgs(["revoke", "laptop", "--id", "1"])).toThrow("not both");
    for (const id of ["0", "-1", "1.5", "1 OR 1=1", "", "01"]) {
      expect(() => parseArgs(["revoke", "--id", id]), id).toThrow();
    }
    expect(() => parseArgs(["revoke", "--id"])).toThrow();
    expect(() => parseArgs(["issue", "a", "--scopes", "read", "--id", "1"])).toThrow(
      "--id is only for revoke",
    );
  });

  it("write は read を含む scopes にそろえる", () => {
    expect(parseArgs(["issue", "a", "--scopes=read,write"])).toMatchObject({
      scopes: "read write",
    });
    expect(parseArgs(["issue", "a", "--scopes", "write"])).toMatchObject({ scopes: "read write" });
  });

  it("SQL に埋め込めない名前を拒否する", () => {
    for (const name of ["x'; DROP TABLE api_tokens; --", "a b", "", "-a", "a".repeat(65)]) {
      expect(() => parseArgs(["revoke", name])).toThrow();
    }
  });

  it("scopes の指定が無いか未知のときは、発行を拒否する", () => {
    expect(() => parseArgs(["issue", "a"])).toThrow();
    expect(() => parseArgs(["issue", "a", "--scopes", "admin"])).toThrow();
    expect(() => parseArgs(["list", "--scopes", "read"])).toThrow("--scopes is only for issue");
  });

  it("未知のコマンドとオプション、余分な引数を拒否する", () => {
    expect(() => parseArgs(["show", "a"])).toThrow();
    expect(() => parseArgs(["list", "a"])).toThrow();
    expect(() => parseArgs(["revoke", "a", "--force"])).toThrow();
    expect(() => parseArgs(["revoke", "a", "extra"])).toThrow();
    expect(() => parseArgs(["revoke"])).toThrow();
  });
});

describe("SQL と wrangler の引数", () => {
  it("平文ではなく hash を登録する", () => {
    const token = generateToken();
    const sql = issueSql({ name: "laptop", tokenHash: hashToken(token), scopes: "read", now: 1 });
    expect(sql).toContain(hashToken(token));
    expect(sql).not.toContain(token);
  });

  it("失効済みの行は書き換えない", () => {
    expect(revokeSql({ id: 1, now: 1 })).toContain("revoked_at IS NULL");
  });

  it("--local と --remote を切り替える", () => {
    expect(wranglerArgs("SELECT 1", { remote: false })).toContain("--local");
    expect(wranglerArgs("SELECT 1", { remote: false })).not.toContain("--remote");
    const remote = wranglerArgs("SELECT 1", {
      remote: true,
      configPath: "/w/wrangler.deploy.json",
    });
    expect(remote).toContain("--remote");
    expect(remote).not.toContain("--local");
    expect(remote.slice(remote.indexOf("--config"), remote.indexOf("--config") + 2)).toEqual([
      "--config",
      "/w/wrangler.deploy.json",
    ]);
  });
});

describe("formatList", () => {
  it("列をそろえ、時刻は UTC の ISO 形式、無い時刻は - にする", () => {
    const text = formatList([
      {
        id: 1,
        name: "air-claude",
        scopes: "read write",
        created_at: Date.UTC(2026, 0, 2, 3, 4, 5),
        last_used_at: null,
        revoked_at: Date.UTC(2026, 1, 1),
      },
      { id: 12, name: "a", scopes: "read", created_at: 0, last_used_at: 0, revoked_at: null },
    ]);
    expect(text.split("\n")).toEqual([
      "id  name        scopes      created                   last used                 revoked",
      "1   air-claude  read write  2026-01-02T03:04:05.000Z  -                         2026-02-01T00:00:00.000Z",
      "12  a           read        1970-01-01T00:00:00.000Z  1970-01-01T00:00:00.000Z  -",
    ]);
  });
});

describe("main", () => {
  /** wrangler の代わりに、migration を当てた SQLite で SQL を実行する spawn を使う */
  function fakeIo(db = migratedDb()) {
    const out = { stdout: "", stderr: "", sql: [] as string[], spawnArgs: [] as string[][] };
    let clock = 1000;
    const io = {
      spawn: (_command: string, args: string[]) => {
        out.spawnArgs.push(args);
        const sql = args[args.indexOf("--command") + 1] as string;
        out.sql.push(sql);
        return { status: 0, stdout: JSON.stringify([{ results: db.prepare(sql).all() }]) };
      },
      stdout: { write: (chunk: string) => (out.stdout += chunk) },
      stderr: { write: (chunk: string) => (out.stderr += chunk) },
      now: () => clock++,
    };
    const reset = () => {
      out.stdout = "";
      out.stderr = "";
    };
    const rows = () =>
      db.prepare("SELECT id, name, token_hash, revoked_at FROM api_tokens ORDER BY id").all();
    return { io, out, db, reset, rows };
  }

  it("発行したトークンの平文は標準出力にだけ出し、id は標準エラーに出し、wrangler には hash だけを渡す", () => {
    const { io, out, rows } = fakeIo();
    expect(run(["issue", "laptop", "--scopes", "read"], io)).toBe(0);
    const token = out.stdout.trimEnd();
    expect(out.stdout).toBe(`${token}\n`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(out.stderr).toBe('issued "laptop" as id 1 (read) on local D1\n');
    for (const args of out.spawnArgs) {
      expect(args.join(" ")).not.toContain(token);
      expect(args).toContain("--local");
    }
    expect(out.spawnArgs.some((args) => args.join(" ").includes(hashToken(token)))).toBe(true);
    expect(rows()).toEqual([
      { id: 1, name: "laptop", token_hash: hashToken(token), revoked_at: null },
    ]);
  });

  it("同じ名前でも発行でき、有効な同名の token があれば id を添えて知らせる", () => {
    const { io, out, reset, rows } = fakeIo();
    expect(run(["issue", "air-claude", "--scopes", "read,write"], io)).toBe(0);
    reset();
    expect(run(["issue", "air-claude", "--scopes", "read"], io)).toBe(0);
    expect(out.stderr).toContain('issued "air-claude" as id 2 (read) on local D1');
    expect(out.stderr).toContain('"air-claude" also has active tokens with id 1');
    expect(rows().map((r) => [r.id, r.name])).toEqual([
      [1, "air-claude"],
      [2, "air-claude"],
    ]);
  });

  it("失効済みの token と同じ名前で発行し直すときは、知らせを出さない", () => {
    const { io, out, reset } = fakeIo();
    run(["issue", "air-claude", "--scopes", "read"], io);
    run(["revoke", "air-claude"], io);
    reset();
    expect(run(["issue", "air-claude", "--scopes", "read"], io)).toBe(0);
    expect(out.stderr).toBe('issued "air-claude" as id 2 (read) on local D1\n');
  });

  it("名前で失効させるとき、有効な token が 1 本ならそれだけを失効させる", () => {
    const { io, out, reset, rows } = fakeIo();
    run(["issue", "laptop", "--scopes", "read"], io);
    run(["revoke", "laptop"], io);
    run(["issue", "laptop", "--scopes", "read"], io);
    run(["issue", "phone", "--scopes", "read"], io);
    reset();
    expect(run(["revoke", "laptop"], io)).toBe(0);
    expect(out.stderr).toBe('revoked "laptop" (id 2) on local D1\n');
    expect(rows().map((r) => [r.id, r.revoked_at !== null])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
  });

  it("名前で失効させるとき、有効な token が複数なら何も変えずに id を示して終了コード 1 にする", () => {
    const { io, out, reset, rows } = fakeIo();
    run(["issue", "laptop", "--scopes", "read"], io);
    run(["issue", "laptop", "--scopes", "read"], io);
    reset();
    const before = rows();
    expect(run(["revoke", "laptop"], io)).toBe(1);
    expect(out.stderr).toContain('2 active tokens are named "laptop" on local D1 (id 1, 2)');
    expect(out.stderr).toContain("nothing was revoked");
    expect(rows()).toEqual(before);
    expect(out.sql.at(-1)).toMatch(/^SELECT/);
  });

  it("id で失効させ、失効済みや無い id なら終了コード 1 にする", () => {
    const { io, out, reset, rows } = fakeIo();
    run(["issue", "laptop", "--scopes", "read"], io);
    run(["issue", "laptop", "--scopes", "read"], io);
    reset();
    expect(run(["revoke", "--id", "1"], io)).toBe(0);
    expect(out.stderr).toBe('revoked "laptop" (id 1) on local D1\n');
    expect(rows().map((r) => r.revoked_at !== null)).toEqual([true, false]);
    const revokedAt = rows()[0]?.revoked_at;
    for (const id of ["1", "9"]) {
      reset();
      expect(run(["revoke", "--id", id], io)).toBe(1);
      expect(out.stderr).toContain(`no active token with id ${id}`);
    }
    expect(rows()[0]?.revoked_at).toBe(revokedAt);
  });

  it("失効させる行が無ければ終了コード 1 にする", () => {
    const { io, out } = fakeIo();
    expect(run(["revoke", "nobody"], io)).toBe(1);
    expect(out.stderr).toContain('no active token named "nobody"');
    expect(out.stdout).toBe("");
  });

  it("list は失効済みを含めて id 順に出し、hash は出さない", () => {
    const { io, out, reset } = fakeIo();
    run(["issue", "laptop", "--scopes", "read"], io);
    const token = out.stdout.trimEnd();
    run(["revoke", "laptop"], io);
    run(["issue", "laptop", "--scopes", "read,write"], io);
    reset();
    expect(run(["list"], io)).toBe(0);
    const lines = out.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^id\s+name\s+scopes\s+created\s+last used\s+revoked$/);
    expect(lines.slice(1).map((l) => l.split(/\s{2,}/))).toEqual([
      ["1", "laptop", "read", new Date(1000).toISOString(), "-", new Date(1001).toISOString()],
      ["2", "laptop", "read write", new Date(1002).toISOString(), "-", "-"],
    ]);
    expect(out.stdout).not.toContain(hashToken(token));
    expect(out.sql.at(-1)).not.toContain("token_hash");
  });

  it("list は token が無くても見出しを出す", () => {
    const { io, out } = fakeIo();
    expect(run(["list"], io)).toBe(0);
    expect(out.stdout).toMatch(/^id\s+name/);
    expect(out.stdout.trimEnd().split("\n")).toHaveLength(1);
  });

  it("wrangler が失敗したら、平文を出さずに終了コード 1 にする", () => {
    const { io, out } = fakeIo();
    io.spawn = (_command, args) => {
      out.spawnArgs.push(args);
      return { status: 1, stdout: "" };
    };
    expect(run(["issue", "laptop", "--scopes", "read"], io)).toBe(1);
    expect(out.stdout).toBe("");
  });

  it("未知のオプションでは wrangler を呼ばずに例外を投げる", () => {
    const { io, out } = fakeIo();
    expect(() => main(["revoke", "laptop", "--force"], io)).toThrow("unknown option: --force");
    expect(out.spawnArgs).toHaveLength(0);
  });
});

describe("0009_api_token_names.sql", () => {
  const FILE = "0009_api_token_names.sql";
  const BEFORE = MIGRATION_FILES.filter((f) => f < FILE);
  const insert = (db: DatabaseSync, values: string) =>
    db.exec(
      `INSERT INTO api_tokens (id, name, token_hash, scopes, created_at, last_used_at, revoked_at) VALUES ${values}`,
    );
  const rows = (db: DatabaseSync) => db.prepare("SELECT * FROM api_tokens ORDER BY id").all();

  it("既存の行を id ごと残し、name の重複を許す", () => {
    const db = migratedDb(BEFORE);
    insert(
      db,
      "(3, 'laptop', 'aa', 'read write', 10, 20, 30), (7, 'phone', 'bb', 'read', 11, NULL, NULL)",
    );
    const before = rows(db);
    expect(() => insert(db, "(8, 'laptop', 'cc', 'read', 12, NULL, NULL)")).toThrow(/UNIQUE/);

    db.exec(readFileSync(new URL(FILE, MIGRATIONS_DIR), "utf8"));
    expect(rows(db)).toEqual(before);

    insert(db, "(8, 'laptop', 'cc', 'read', 12, NULL, NULL)");
    // id を指定しない行は、最大の id の次になる
    db.exec(
      "INSERT INTO api_tokens (name, token_hash, scopes, created_at) VALUES ('laptop', 'dd', 'read', 13)",
    );
    expect(
      db
        .prepare("SELECT id FROM api_tokens WHERE name = 'laptop' ORDER BY id")
        .all()
        .map((r) => r.id),
    ).toEqual([3, 8, 9]);
  });

  it("token_hash の一意と scopes の CHECK は残り、name の `:` は CHECK で拒む", () => {
    const db = migratedDb();
    insert(db, "(1, 'a', 'aa', 'read', 1, NULL, NULL)");
    expect(() => insert(db, "(2, 'b', 'aa', 'read', 1, NULL, NULL)")).toThrow(/UNIQUE/);
    expect(() => insert(db, "(2, 'b', 'bb', '', 1, NULL, NULL)")).toThrow(/CHECK/);
    expect(() => insert(db, "(2, 'a:b', 'bb', 'read', 1, NULL, NULL)")).toThrow(/CHECK/);
    expect(() =>
      db.exec("INSERT INTO api_tokens (name, token_hash, scopes) VALUES ('c', 'cc', 'read')"),
    ).toThrow(/NOT NULL/);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'api_tokens%' AND type = 'table'")
        .all(),
    ).toEqual([{ name: "api_tokens" }]);
  });
});
