// D1 のデータを SQL のダンプとして手元に残し、新しい D1 に戻す。D1 の Time Travel は Free で 7 日分しか
// 遡れないので、それより古い状態に戻せるようにするためのもの。
//   node scripts/backup.mjs [--remote] [--out <dir>] [--with-tokens]
//   node scripts/backup.mjs load <dir> [--remote]
// 既定はローカルの D1。--remote は deploy.env から合成した設定（deploy-config.mjs）で D1 を解決する。
// 実行ごとに <out>/<UTC の日時>-<local|remote>/ を作り、data.sql（INSERT 文だけ）と manifest.json を置く。
// 既定の出力先 apps/worker/backups/ は gitignore 済み。draft の本文を含むので、別の場所を指定するときも
// 追跡される場所には置かない。
// load は、migration を適用済みで対象の表が空の D1 にだけ戻す。派生データ（links、tags、抜粋、検索の索引）は
// ダンプに含まれないので、load のあとに Worker をデプロイして derived:rebuild を回す。

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeGeneratedConfig } from "./deploy-config.mjs";

const D1_BINDING = "DB";
const WORKER_DIR = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_OUT_DIR = `${WORKER_DIR}backups`;
const DATA_FILE = "data.sql";
const MANIFEST_FILE = "manifest.json";

/** ダンプする表。本文の正本なので、これが欠けると復元できない。 */
export const DATA_TABLES = ["pages", "revisions"];

/**
 * --with-tokens でだけダンプする表。token_hash を含み、ダンプの流出がそのまま token の流出になる。
 * 既定で出さないのは、復元後に発行し直せば済むため。ただし失効済みの名前は再利用できず、
 * revisions.actor（token:<名前>）の指す先でもあるので、発行し直す名前は以前と変えること。
 */
export const TOKEN_TABLES = ["api_tokens"];

/**
 * ダンプしない表と、その理由。migrations/*.sql の表がこのどちらかか DATA_TABLES、TOKEN_TABLES に
 * 入っていることをテストが検査する（表を足したときに、バックアップの要否を決め忘れないため）。
 */
export const EXCLUDED_TABLES = {
  // 派生データ。pages と revisions の本文から derived:rebuild で作り直せる。
  // 復元後は rebuild が必要になる（FTS は export できない）ので、同じ経路にそろえて外部キーの順序を避ける
  links: "derived",
  tags: "derived",
  page_excerpts: "derived",
  // FTS5 の仮想テーブルは D1 の export ができない。shadow table（pages_fts_*）は仮想テーブルが作る
  pages_fts: "derived",
  // 保存の batch が版の衝突を検出するための表。常に空
  save_guard: "transient",
};

const USAGE = `usage:
  backup [--remote] [--out <dir>] [--with-tokens]
  backup load <dir> [--remote]`;

/**
 * @typedef {{ command: "backup"; remote: boolean; out: string; withTokens: boolean }
 *   | { command: "load"; remote: boolean; dir: string }} ParsedArgs
 */

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  const positional = [];
  let remote = false;
  let withTokens = false;
  /** @type {string | undefined} */
  let out;
  for (let i = 0; i < argv.length; i++) {
    const arg = /** @type {string} */ (argv[i]);
    if (arg === "--remote") remote = true;
    else if (arg === "--local") remote = false;
    else if (arg === "--with-tokens") withTokens = true;
    else if (arg === "--out") out = argv[++i];
    else if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (argv.includes("--out") && (out === undefined || out === "")) {
    throw new Error("--out needs a directory");
  }
  if (positional[0] === "load") {
    if (out !== undefined || withTokens) {
      throw new Error("--out and --with-tokens are only for backup");
    }
    const [, dir, ...rest] = positional;
    if (dir === undefined) throw new Error("load needs the backup directory");
    if (rest.length > 0) throw new Error(`unexpected argument: ${rest.join(" ")}`);
    return { command: "load", remote, dir };
  }
  if (positional.length > 0) throw new Error(`unexpected argument: ${positional.join(" ")}`);
  return { command: "backup", remote, out: out ?? DEFAULT_OUT_DIR, withTokens };
}

/** @param {boolean} withTokens */
export function tablesToDump(withTokens) {
  return withTokens ? [...DATA_TABLES, ...TOKEN_TABLES] : DATA_TABLES;
}

/**
 * @param {{ remote: false } | { remote: true; configPath: string }} target
 *   remote では、D1 の ID を持つ設定ファイルを渡す
 */
function targetFlags(target) {
  return target.remote ? ["--remote", "--config", target.configPath] : ["--local"];
}

/**
 * 表を 1 回の export にまとめるのは、export の途中でリクエストが止まるので 1 つの時点のダンプになり、
 * 表ごとに分けると pages と revisions の間に保存が割り込みうるため。
 * スキーマは migration が作るので --no-schema にする。
 * @param {string[]} tables
 * @param {string} outputPath
 * @param {{ remote: false } | { remote: true; configPath: string }} target
 */
export function exportArgs(tables, outputPath, target) {
  return [
    "d1",
    "export",
    D1_BINDING,
    ...targetFlags(target),
    "--no-schema",
    ...tables.flatMap((table) => ["--table", table]),
    "--output",
    outputPath,
    "--skip-confirmation",
  ];
}

/**
 * @param {string} sql
 * @param {{ remote: false } | { remote: true; configPath: string }} target
 */
export function executeArgs(sql, target) {
  return ["d1", "execute", D1_BINDING, ...targetFlags(target), "--json", "--command", sql];
}

/**
 * @param {string} filePath
 * @param {{ remote: false } | { remote: true; configPath: string }} target
 */
export function loadArgs(filePath, target) {
  return ["d1", "execute", D1_BINDING, ...targetFlags(target), "--yes", "--file", filePath];
}

/**
 * 表の行数を 1 つの SELECT で返す SQL。表名は固定の一覧から選び、外から来た値は埋め込まない。
 * @param {string[]} tables
 */
export function countSql(tables) {
  return tables.map((t) => `SELECT '${t}' AS t, count(*) AS n FROM ${t}`).join(" UNION ALL ");
}

/**
 * ダンプの INSERT 文を表ごとに数える。export は改行を replace(..., '\n', char(10)) で退避して
 * 1 行 1 文にするので、行頭の INSERT で数えられる。
 * @param {string} sql
 * @param {string[]} tables
 * @returns {Record<string, number>}
 */
export function countInserts(sql, tables) {
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(tables.map((t) => [t, 0]));
  for (const line of sql.split("\n")) {
    const match = /^INSERT INTO "([^"]+)" /.exec(line);
    const table = match?.[1];
    if (table !== undefined && table in counts) counts[table] = (counts[table] ?? 0) + 1;
  }
  return counts;
}

/**
 * ディレクトリ名に使う UTC の日時。ファイル名に使えない `:` を `-` にする。
 * @param {Date} date
 * @param {boolean} remote
 */
export function backupDirName(date, remote) {
  return `${date.toISOString().slice(0, 19).replaceAll(":", "-")}Z-${remote ? "remote" : "local"}`;
}

/**
 * @typedef {{
 *   version: 1;
 *   createdAt: string;
 *   target: "local" | "remote";
 *   file: string;
 *   rows: Record<string, number>;
 * }} Manifest
 */

/**
 * manifest は手元のファイルだが、load が SQL に埋め込む表名の出どころなので、許可した表名だけを通す。
 * @param {unknown} value
 * @returns {Manifest}
 */
export function parseManifest(value) {
  const allowed = new Set([...DATA_TABLES, ...TOKEN_TABLES]);
  const v = /** @type {Record<string, any> | null} */ (value);
  if (
    typeof v !== "object" ||
    v === null ||
    v.version !== 1 ||
    v.file !== DATA_FILE ||
    typeof v.rows !== "object" ||
    v.rows === null
  ) {
    throw new Error(`${MANIFEST_FILE} is not a backup manifest`);
  }
  const tables = Object.keys(v.rows);
  const valid =
    DATA_TABLES.every((t) => tables.includes(t)) &&
    tables.every((t) => allowed.has(t) && Number.isInteger(v.rows[t]) && v.rows[t] >= 0);
  if (!valid) throw new Error(`${MANIFEST_FILE} has unexpected tables or row counts`);
  return /** @type {Manifest} */ (v);
}

/**
 * テストで wrangler の実行、ファイル、時刻、出力先を差し替えるための口。
 * @typedef {{
 *   spawn: (command: string, args: string[], options: import("node:child_process").SpawnSyncOptionsWithStringEncoding) => { status: number | null; stdout: string };
 *   stderr: { write(chunk: string): unknown };
 *   now: () => Date;
 *   fs: {
 *     mkdir: (path: string) => void;
 *     rm: (path: string) => void;
 *     read: (path: string) => string;
 *     write: (path: string, text: string) => void;
 *     exists: (path: string) => boolean;
 *     restrict: (path: string, mode: number) => void;
 *   };
 *   resolveRemote: () => string;
 * }} Io
 */

/** @type {Io} */
const defaultIo = {
  spawn: spawnSync,
  stderr: process.stderr,
  now: () => new Date(),
  fs: {
    mkdir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
    rm: (path) => rmSync(path, { recursive: true, force: true }),
    read: (path) => readFileSync(path, "utf8"),
    write: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
    exists: (path) => existsSync(path) && statSync(path).isFile(),
    restrict: (path, mode) => chmodSync(path, mode),
  },
  resolveRemote: () => writeGeneratedConfig(),
};

/**
 * wrangler を実行して標準出力を返す。
 * @param {string[]} args
 * @param {Io} io
 */
function runWrangler(args, io) {
  const require = createRequire(import.meta.url);
  const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
  const result = io.spawn(process.execPath, [wranglerBin, ...args], {
    cwd: WORKER_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    io.stderr.write(result.stdout ?? "");
    throw new Error(`wrangler exited with ${result.status}`);
  }
  return result.stdout ?? "";
}

/**
 * @param {ParsedArgs} args
 * @param {Io} io
 * @returns {{ remote: false } | { remote: true; configPath: string }}
 */
function resolveTarget(args, io) {
  return args.remote ? { remote: true, configPath: io.resolveRemote() } : { remote: false };
}

/**
 * @param {Extract<ParsedArgs, { command: "backup" }>} args
 * @param {Io} io
 * @returns {{ dir: string; rows: Record<string, number> }}
 */
export function backup(args, io) {
  const target = resolveTarget(args, io);
  const tables = tablesToDump(args.withTokens);
  const dir = join(resolve(args.out), backupDirName(io.now(), args.remote));
  const dataPath = join(dir, DATA_FILE);
  /** @type {Record<string, number>} */
  let rows;
  io.fs.mkdir(dir);
  try {
    runWrangler(exportArgs(tables, dataPath, target), io);
    io.fs.restrict(dataPath, 0o600);
    rows = countInserts(io.fs.read(dataPath), tables);
    /** @type {Manifest} */
    const manifest = {
      version: 1,
      createdAt: io.now().toISOString(),
      target: args.remote ? "remote" : "local",
      file: DATA_FILE,
      rows,
    };
    // manifest は最後に書く。プロセスが強制終了されて manifest の無いまま残ったディレクトリは、
    // 不完全なバックアップとして load が拒む
    io.fs.write(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    io.fs.rm(dir);
    throw error;
  }
  return { dir, rows };
}

/**
 * @param {string} stdout wrangler d1 execute --json の出力
 * @returns {Record<string, number>}
 */
export function parseCounts(stdout) {
  /** @type {{ results?: { t: string; n: number }[] }[]} */
  const parsed = JSON.parse(stdout);
  /** @type {Record<string, number>} */
  const counts = {};
  for (const set of parsed) for (const row of set.results ?? []) counts[row.t] = row.n;
  return counts;
}

/**
 * @param {Extract<ParsedArgs, { command: "load" }>} args
 * @param {Io} io
 * @returns {Record<string, number>} 復元後の行数
 */
export function load(args, io) {
  const dir = resolve(args.dir);
  const manifestPath = join(dir, MANIFEST_FILE);
  const dataPath = join(dir, DATA_FILE);
  if (!io.fs.exists(manifestPath) || !io.fs.exists(dataPath)) {
    throw new Error(`${dir} is not a complete backup (${MANIFEST_FILE} and ${DATA_FILE} needed)`);
  }
  const manifest = parseManifest(JSON.parse(io.fs.read(manifestPath)));
  const tables = Object.keys(manifest.rows);
  const target = resolveTarget(args, io);

  // 表が無ければ migration が未適用で、空でなければ INSERT が主キーの衝突で途中まで入って止まる
  let before;
  try {
    before = parseCounts(runWrangler(executeArgs(countSql(tables), target), io));
  } catch (error) {
    throw new Error(
      `cannot count rows in the target D1 (apply the migrations first): ${error instanceof Error ? error.message : error}`,
    );
  }
  const filled = tables.filter((t) => (before[t] ?? 0) > 0);
  if (filled.length > 0) {
    throw new Error(`target D1 is not empty (${filled.join(", ")}); load only into a new D1`);
  }

  runWrangler(loadArgs(dataPath, target), io);

  const after = parseCounts(runWrangler(executeArgs(countSql(tables), target), io));
  const mismatched = tables.filter((t) => after[t] !== manifest.rows[t]);
  if (mismatched.length > 0) {
    throw new Error(
      `row counts differ after load: ${mismatched.map((t) => `${t} ${after[t]} (expected ${manifest.rows[t]})`).join(", ")}`,
    );
  }
  return after;
}

/**
 * 終了コードを返す。
 * @param {string[]} argv
 * @param {Io} [io]
 * @returns {number}
 */
export function run(argv, io = defaultIo) {
  try {
    const args = parseArgs(argv);
    const where = args.remote ? "remote" : "local";
    if (args.command === "backup") {
      const { dir, rows } = backup(args, io);
      io.stderr.write(
        `backed up ${where} D1 to ${dir} (${Object.entries(rows)
          .map(([t, n]) => `${t} ${n}`)
          .join(", ")})\n`,
      );
      // migration 前の D1 や、別の D1 を指していても export は成功する。空のダンプに気づけるようにする
      if (rows.pages === 0) io.stderr.write("warning: no pages were dumped\n");
      return 0;
    }
    const counts = load(args, io);
    io.stderr.write(
      `loaded ${Object.entries(counts)
        .map(([t, n]) => `${t} ${n}`)
        .join(", ")} into ${where} D1\n` +
        "next: deploy the Worker, issue an API token, then run derived:rebuild\n",
    );
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = run(process.argv.slice(2));
}
