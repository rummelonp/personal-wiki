// D1 のデータを SQL のダンプとして手元に残し、新しい D1 に戻す。D1 の Time Travel は Free で 7 日分しか
// 遡れないので、それより古い状態に戻せるようにするためのもの。
//   node scripts/backup.mjs [--remote] [--out <dir>] [--with-tokens]
//   node scripts/backup.mjs load <dir> [--remote]
// 既定はローカルの D1。--remote は deploy.env から合成した設定（deploy-config.mjs）で D1 を解決する。
// 実行ごとに <out>/<UTC の日時>-<local|remote>/ を作り、data.sql（INSERT と UPDATE だけ）と manifest.json を置く。
// 既定の出力先 apps/worker/backups/ は gitignore 済み。draft の本文を含むので、別の場所を指定するときも
// 追跡される場所には置かない。
//
// データは wrangler d1 export ではなく、SELECT で読んで INSERT を自分で組み立てる。export の形式は、
// 本文にもとからある 2 文字の `\n`（バックスラッシュと n）を、改行を逃がした `\n` と区別せず、
// 復元後に本物の改行へ変えてしまう。ここでは文字列の列を hex() で受け取り、CAST(X'…' AS TEXT) で戻すので、
// NUL を含むどんなバイト列も変わらない。
// load は、migration を適用済みで対象の表が空の D1 にだけ戻す。派生データ（links、tags、抜粋、検索の索引）は
// ダンプに含まれないので、load のあとに Worker をデプロイして derived:rebuild を回す。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
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

/** D1 の SQL 文の長さの上限（バイト）。`d1 execute --file` の 1 文ごとにも掛かる */
export const STATEMENT_LIMIT = 100_000;
/** 上限に余裕を持たせた、1 文の長さの目標。長い列を分けるときの基準にする */
const STATEMENT_BUDGET = 90_000;
/** 1 回の SELECT で読む行数の上限。ウィンドウ関数の対象を絞り、読み取る行数が表の大きさの 2 乗に増えないようにする */
const BATCH_ROWS = 100;
/**
 * 1 回の SELECT で受け取る本文などの合計（hex にする前のバイト数）の目安。hex で 2 倍、JSON で少し増えるので、
 * 応答は 1 MB 弱になる。D1 の応答の大きさの上限は公式の limits に書かれておらず、remote では確かめていない。
 * 行の大きさの上限は 2 MB なので、これを超える 1 行でも単独で読める（超えた行で打ち切る）。
 */
const BATCH_BYTES = 256 * 1024;

/**
 * @typedef {{ name: string; kind: "int" | "text" }} Column
 * @typedef {{ columns: Column[]; key: string[]; long?: string }} TableSpec
 */

/** @param {string} name */
const int = (name) => /** @type {Column} */ ({ name, kind: "int" });
/** @param {string} name */
const text = (name) => /** @type {Column} */ ({ name, kind: "text" });

/**
 * ダンプする表の列と、読む順序の主キー。列は migrations/*.sql の定義の順で、テストが突き合わせる。
 * long は 1 文に収まらないことがある列（本文は最大 64 KiB で、hex にすると 128 KiB になる）。
 * pages、revisions、attachments は正本、api_tokens は --with-tokens でだけ出す。
 * @type {Record<string, TableSpec>}
 */
export const TABLES = {
  pages: {
    columns: [
      int("seq"),
      text("id"),
      text("visibility"),
      int("version"),
      int("created_at"),
      int("updated_at"),
      int("deleted_at"),
      text("deleted_by"),
      text("title_key"),
      text("title"),
      text("body"),
    ],
    key: ["seq"],
    long: "body",
  },
  revisions: {
    columns: [
      text("page_id"),
      int("version"),
      text("actor"),
      int("created_at"),
      text("title"),
      text("body"),
    ],
    key: ["page_id", "version"],
    long: "body",
  },
  // 添付の台帳。中身（画像）は R2 にあり、このバックアップには入らない
  attachments: {
    columns: [
      text("name"),
      text("content_type"),
      int("size"),
      int("created_at"),
      text("created_by"),
    ],
    key: ["name"],
  },
  // token_hash を含み、ダンプの流出がそのまま token の流出になる。既定で出さないのは、復元後に
  // 発行し直せば済むため。ただし出さずに戻した D1 では id が 1 から振り直され、revisions.actor などの
  // token:<id>:<name> と重なりうるので、発行し直す名前は以前と変えること
  api_tokens: {
    columns: [
      int("id"),
      text("name"),
      text("token_hash"),
      text("scopes"),
      int("created_at"),
      int("last_used_at"),
      int("revoked_at"),
    ],
    key: ["id"],
  },
};

// この順に読む。attachments の行は消さず、本文に埋め込む前に作られるので、pages より後に読めば
// dump したページが参照する添付の行はすべて入る。attachments の行を消す処理（purge）を足すときは、
// この前提が崩れるので読む順を見直す
export const DATA_TABLES = ["pages", "revisions", "attachments"];
export const TOKEN_TABLES = ["api_tokens"];

/**
 * 後の migration で足した表と、それを作る migration。読む D1 や manifest の migration の一覧に無ければ、
 * その表は無いものとして扱う（migration を当てる前の D1 もバックアップでき、表を足す前のバックアップも
 * load できるように）。ここに無い表は、最初からある表として扱う。
 * @type {Record<string, string>}
 */
export const TABLE_MIGRATIONS = { attachments: "0006_attachments.sql" };

/**
 * ダンプする表の保存値を書き換えた migration と、その書き換えの SQL。バックアップの後にこの migration を
 * 当てた D1 へ load すると、値はバックアップの時点の規則のまま入るので、load の後に同じ書き換えを当てる。
 * ダンプしない表（links など）の分は derived:rebuild が作り直すので含めない。
 * @type {Record<string, string>}
 */
export const DATA_MIGRATIONS = {
  "0008_title_key_underscore.sql":
    "UPDATE pages SET title_key = replace(title_key, '_', ' ') WHERE instr(title_key, '_') > 0",
};

/**
 * 適用済みの migration が migrations である D1 から、ダンプする表。
 * @param {boolean} withTokens
 * @param {string[]} migrations
 */
export function tablesToDump(withTokens, migrations) {
  const tables = [...DATA_TABLES, ...(withTokens ? TOKEN_TABLES : [])];
  return tables.filter((t) => {
    const since = TABLE_MIGRATIONS[t];
    return since === undefined || migrations.includes(since);
  });
}

/**
 * ダンプしない表と、その理由。migrations/*.sql の表が TABLES かここに入っていることをテストが検査する
 * （表を足したときに、バックアップの要否を決め忘れないため）。
 */
export const EXCLUDED_TABLES = {
  // 派生データ。pages と revisions の本文から derived:rebuild で作り直せる。
  // FTS5 は復元後に rebuild が必ず要るので、同じ経路にそろえて外部キーの順序を避ける
  links: "derived",
  tags: "derived",
  page_excerpts: "derived",
  attachment_refs: "derived",
  // FTS5 の仮想テーブルは D1 の export もできない。shadow table（pages_fts_*）は仮想テーブルが作る
  pages_fts: "derived",
  // 保存の batch が版の衝突を検出するための表。常に空
  save_guard: "transient",
  // OAuth の client の登録数を UTC の 1 日ごとに数える表。復元しても過ぎた日の行は使われない
  oauth_client_registrations: "transient",
  // title の変更でリンクを書き換える待ち行列。処理が済めば空になる。バックアップの時点で処理を
  // 待っていた分は、復元した本文に古い title のリンクとして残る
  link_rewrites: "transient",
};

const USAGE = `usage:
  backup [--remote] [--out <dir>] [--with-tokens]
  backup load <dir> [--remote]
  相対パスの起点は、コマンドを実行したディレクトリ（pnpm なら apps/worker）`;

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
    else if (arg === "--out") out = argv[++i] ?? "";
    else if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (out !== undefined && (out === "" || out.startsWith("-"))) {
    throw new Error("--out needs a directory (a value starting with - is not accepted)");
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

/** @typedef {{ remote: false } | { remote: true; configPath: string }} Target */

/** @param {Target} target */
function targetFlags(target) {
  return target.remote ? ["--remote", "--config", target.configPath] : ["--local"];
}

/**
 * @param {string} sql
 * @param {Target} target
 */
export function executeArgs(sql, target) {
  return ["d1", "execute", D1_BINDING, ...targetFlags(target), "--json", "--command", sql];
}

/**
 * @param {string} filePath
 * @param {Target} target
 */
export function loadArgs(filePath, target) {
  return ["d1", "execute", D1_BINDING, ...targetFlags(target), "--yes", "--file", filePath];
}

/** @param {string} name */
const quoteIdent = (name) => `"${name}"`;

/**
 * 読む順序の主キーの値を SQL のリテラルにする。text の値は hex のまま持っているので、
 * 引用符の扱いを考えずに済む形で書く。
 * @param {Column} column
 * @param {number | string | null} value
 */
function literal(column, value) {
  if (value === null) return "NULL";
  if (column.kind === "int") {
    if (!Number.isSafeInteger(value)) throw new Error(`${column.name} is not an integer`);
    return String(value);
  }
  if (typeof value !== "string" || !/^[0-9A-Fa-f]*$/.test(value)) {
    throw new Error(`${column.name} is not a hex string`);
  }
  return value === "" ? "''" : `CAST(X'${value}' AS TEXT)`;
}

/**
 * 表を主キーの順に、本文の大きさで区切って読む SELECT。文字列の列は hex() で受け取り（NULL は NULL のまま）、
 * 列は c0, c1, … の別名で返す。
 * 区切りは「それまでの合計が BATCH_BYTES に達していない行まで」で、最初の行は必ず入るので読み進められる。
 * @param {string} table
 * @param {(number | string | null)[] | null} after 直前の batch の最後の行の主キー。最初は null
 */
export function selectSql(table, after) {
  const spec = /** @type {TableSpec} */ (TABLES[table]);
  const byName = new Map(spec.columns.map((c) => [c.name, c]));
  const keyColumns = spec.key.map((k) => /** @type {Column} */ (byName.get(k)));
  const keyList = spec.key.map(quoteIdent).join(", ");
  const where =
    after === null
      ? "1"
      : `(${keyList}) > (${keyColumns.map((c, i) => literal(c, after[i] ?? null)).join(", ")})`;
  const size = `${spec.columns
    .filter((c) => c.kind === "text")
    .map((c) => `coalesce(length(CAST(${quoteIdent(c.name)} AS BLOB)), 0)`)
    .join(" + ")} + 64`;
  const select = spec.columns
    .map((c, i) => {
      const q = quoteIdent(c.name);
      return c.kind === "int"
        ? `${q} AS c${i}`
        : `CASE WHEN ${q} IS NULL THEN NULL ELSE hex(${q}) END AS c${i}`;
    })
    .join(", ");
  return (
    `SELECT ${select} FROM (` +
    `SELECT *, ${size} AS _size, SUM(${size}) OVER (ORDER BY ${keyList}) AS _run FROM (` +
    `SELECT * FROM ${quoteIdent(table)} WHERE ${where} ORDER BY ${keyList} LIMIT ${BATCH_ROWS}` +
    `)) WHERE _run - _size < ${BATCH_BYTES} ORDER BY ${keyList}`
  );
}

/**
 * 表ごとの行数を 1 つの SELECT で返す SQL。表名は TABLES のキーだけ。
 * @param {string[]} tables
 */
export function countSql(tables) {
  return tables
    .map((t) => `SELECT '${t}' AS t, count(*) AS n FROM ${quoteIdent(t)}`)
    .join(" UNION ALL ");
}

export const MIGRATIONS_SQL = "SELECT name FROM d1_migrations ORDER BY id";

/**
 * 1 行（selectSql の c0, c1, … の順）。int は数値、text は hex の文字列、NULL は null。
 * @typedef {(number | string | null)[]} Row
 */

/** @param {string} hex */
const hexToText = (hex) => Buffer.from(hex, "hex").toString("utf8");

/**
 * INSERT と、1 文に収まらない本文を足す UPDATE を組み立てる。文は 1 行に 1 つで、改行を含まない。
 * 本文は UTF-8 の文字の途中で切らずに分け、UPDATE は blob として連結する（text の連結は NUL で切れない
 * ことを確かめてあるが、blob の方が型の変換に依存しない）。
 * @param {string} table
 * @param {Row} row
 * @returns {string[]}
 */
export function rowStatements(table, row) {
  const spec = /** @type {TableSpec} */ (TABLES[table]);
  const columnList = spec.columns.map((c) => quoteIdent(c.name)).join(", ");
  const longIndex =
    spec.long === undefined ? -1 : spec.columns.findIndex((c) => c.name === spec.long);
  const longHex = longIndex < 0 ? null : (row[longIndex] ?? null);
  /** @param {string} bodyHex */
  const insert = (bodyHex) =>
    `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES(${spec.columns
      .map((c, i) => (i === longIndex ? literal(c, bodyHex) : literal(c, row[i] ?? null)))
      .join(",")});`;
  const keyWhere = spec.key
    .map((k) => {
      const i = spec.columns.findIndex((c) => c.name === k);
      return `${quoteIdent(k)} = ${literal(/** @type {Column} */ (spec.columns[i]), row[i] ?? null)}`;
    })
    .join(" AND ");
  /** @param {string} chunkHex */
  const append = (chunkHex) =>
    `UPDATE ${quoteIdent(table)} SET ${quoteIdent(/** @type {string} */ (spec.long))} = CAST(CAST(${quoteIdent(/** @type {string} */ (spec.long))} AS BLOB) || X'${chunkHex}' AS TEXT) WHERE ${keyWhere};`;

  if (typeof longHex !== "string") return checked([insert("")]);
  const bytes = Buffer.from(longHex, "hex");
  const overhead = Math.max(Buffer.byteLength(insert("")), Buffer.byteLength(append("")));
  const chunkBytes = Math.floor((STATEMENT_BUDGET - overhead) / 2);
  if (chunkBytes < 16) throw new Error(`a row of ${table} is too large for one statement`);
  /** @type {string[]} */
  const chunks = [];
  let pos = 0;
  do {
    let end = Math.min(pos + chunkBytes, bytes.length);
    // 次の byte が UTF-8 の継続 byte なら、文字の途中なので手前の文字の境界まで戻る
    while (end < bytes.length && end > pos && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    if (end === pos && pos < bytes.length) throw new Error("cannot split a body at a character");
    chunks.push(bytes.subarray(pos, end).toString("hex").toUpperCase());
    pos = end;
  } while (pos < bytes.length);
  return checked([insert(chunks[0] ?? ""), ...chunks.slice(1).map(append)]);
}

/** @param {string[]} statements */
function checked(statements) {
  for (const s of statements) {
    if (Buffer.byteLength(s) >= STATEMENT_LIMIT) {
      throw new Error("a generated statement exceeds the D1 statement size limit");
    }
  }
  return statements;
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
 *   migrations: string[];
 *   tables: Record<string, { rows: number; sha256: string }>;
 * }} Manifest
 */

/**
 * manifest は手元のファイルだが、load が SQL に埋め込む表名の出どころなので、TABLES にある表名だけを通す。
 * 表の過不足は manifest の migration の一覧と照らす。その時点で在った正本の表が欠けていれば、
 * 復元で黙って失うので拒む。
 * @param {unknown} value
 * @returns {Manifest}
 */
export function parseManifest(value) {
  const v = /** @type {Record<string, any> | null} */ (value);
  if (
    typeof v !== "object" ||
    v === null ||
    v.version !== 1 ||
    v.file !== DATA_FILE ||
    !Array.isArray(v.migrations) ||
    !v.migrations.every((/** @type {unknown} */ m) => typeof m === "string") ||
    typeof v.tables !== "object" ||
    v.tables === null
  ) {
    throw new Error(`${MANIFEST_FILE} is not a backup manifest`);
  }
  const names = Object.keys(v.tables);
  const allowed = tablesToDump(true, v.migrations);
  const valid =
    tablesToDump(false, v.migrations).every((t) => names.includes(t)) &&
    names.every((t) => {
      const entry = v.tables[t];
      return (
        allowed.includes(t) &&
        Number.isInteger(entry?.rows) &&
        entry.rows >= 0 &&
        typeof entry.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(entry.sha256)
      );
    });
  if (!valid) throw new Error(`${MANIFEST_FILE} has unexpected tables, row counts or digests`);
  return /** @type {Manifest} */ (v);
}

/**
 * テストで wrangler の実行、ファイル、時刻、出力先を差し替えるための口。
 * @typedef {{
 *   spawn: (command: string, args: string[], options: import("node:child_process").SpawnSyncOptionsWithStringEncoding) => { status: number | null; stdout: string; stderr?: string; error?: Error };
 *   stderr: { write(chunk: string): unknown };
 *   now: () => Date;
 *   fs: {
 *     mkdir: (path: string) => void;
 *     rm: (path: string) => void;
 *     read: (path: string) => string;
 *     write: (path: string, text: string) => void;
 *     append: (path: string, text: string) => void;
 *     exists: (path: string) => boolean;
 *     restrict: (path: string, mode: number) => void;
 *   };
 *   resolveRemote: () => string;
 * }} Io
 */

/** @type {Io} */
export const defaultIo = {
  spawn: spawnSync,
  stderr: process.stderr,
  now: () => new Date(),
  fs: {
    // 末端のディレクトリは recursive にせず作り、既にあれば失敗させる（失敗時の掃除で前のバックアップを消さない）
    mkdir: (path) => {
      mkdirSync(dirname(path), { recursive: true });
      mkdirSync(path, { mode: 0o700 });
    },
    rm: (path) => rmSync(path, { recursive: true, force: true }),
    read: (path) => readFileSync(path, "utf8"),
    write: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
    append: (path, text) => appendFileSync(path, text, { mode: 0o600 }),
    exists: (path) => existsSync(path) && statSync(path).isFile(),
    restrict: (path, mode) => chmodSync(path, mode),
  },
  resolveRemote: () => writeGeneratedConfig(),
};

/**
 * 失敗時にエラーへ出す wrangler の stderr。本文や hash を含みうる長い hex の並びは省き、長さも切る。
 * @param {string} stderr
 */
export function sanitizeStderr(stderr) {
  const cleaned = stderr.replace(/[0-9A-Fa-f]{40,}/g, "…").trim();
  return cleaned.length > 1000 ? `${cleaned.slice(0, 1000)}…` : cleaned;
}

/**
 * `--json` の wrangler が失敗時に標準出力へ出す `{"error": {"text", "notes"}}` から、エラーの文だけを取り出す。
 * 形が違えば空を返し、標準出力のほかの部分は使わない。
 * @param {string} stdout
 */
export function jsonErrorText(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return "";
  }
  const error = parsed?.error;
  if (typeof error?.text !== "string") return "";
  const notes = Array.isArray(error.notes)
    ? error.notes
        .map((/** @type {{ text?: unknown }} */ n) => n?.text)
        .filter((/** @type {unknown} */ t) => typeof t === "string")
    : [];
  return [error.text, ...notes].join("\n");
}

/**
 * wrangler を実行して標準出力を返す。失敗時は標準出力をそのまま出さない（SELECT の結果の本文や、
 * remote の export の署名付き URL を表示しないため）。
 * `--json` の失敗は標準エラーが空になるので、標準出力のエラーの文だけを表示する。
 * @param {string[]} args
 * @param {Io} io
 */
function runWrangler(args, io) {
  const require = createRequire(import.meta.url);
  const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
  const result = io.spawn(process.execPath, [wranglerBin, ...args], {
    cwd: WORKER_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = sanitizeStderr(
      [result.stderr ?? result.error?.message ?? "", jsonErrorText(result.stdout ?? "")]
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .join("\n"),
    );
    throw new Error(`wrangler exited with ${result.status}${detail === "" ? "" : `:\n${detail}`}`);
  }
  return result.stdout ?? "";
}

/**
 * wrangler d1 execute --json の出力から行を取り出す。解析できないときは、出力を含めずに失敗する。
 * @param {string} stdout
 * @returns {Record<string, any>[]}
 */
function parseRows(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed.flatMap((/** @type {{ results?: unknown[] }} */ set) => set.results ?? []);
  } catch {
    throw new Error("unexpected output from wrangler d1 execute");
  }
}

/**
 * @param {string} sql
 * @param {Target} target
 * @param {Io} io
 */
function query(sql, target, io) {
  return parseRows(runWrangler(executeArgs(sql, target), io));
}

/**
 * 表の全行を、主キーの順に batch ごとに読む。
 * @param {string} table
 * @param {Target} target
 * @param {Io} io
 * @returns {Generator<Row[]>}
 */
function* readBatches(table, target, io) {
  const spec = /** @type {TableSpec} */ (TABLES[table]);
  const keyIndexes = spec.key.map((k) => spec.columns.findIndex((c) => c.name === k));
  /** @type {(number | string | null)[] | null} */
  let after = null;
  for (;;) {
    /** @type {Row[]} */
    const rows = query(selectSql(table, after), target, io).map((record) =>
      spec.columns.map((_, i) => /** @type {number | string | null} */ (record[`c${i}`] ?? null)),
    );
    const last = /** @type {Row | undefined} */ (rows[rows.length - 1]);
    if (last === undefined) return;
    yield rows;
    after = keyIndexes.map((i) => last[i] ?? null);
  }
}

/**
 * 行の列挙から、行数と全列の digest を求める。backup と load の検証で同じ形に揃える。
 * @param {Iterable<Row[]>} batches
 * @param {(rows: Row[]) => Row[]} [visit] batch ごとに呼び、digest に入れる行を返す
 */
function digestOf(batches, visit = (rows) => rows) {
  const hash = createHash("sha256");
  let rows = 0;
  for (const batch of batches) {
    for (const row of visit(batch)) {
      hash.update(`${JSON.stringify(row)}\n`);
      rows += 1;
    }
  }
  return { rows, sha256: hash.digest("hex") };
}

/**
 * @param {Target} target
 * @param {Io} io
 * @returns {string[]}
 */
function readMigrations(target, io) {
  return query(MIGRATIONS_SQL, target, io).map((r) => String(r.name));
}

/**
 * @typedef {{
 *   dir: string;
 *   tables: Record<string, { rows: number; sha256: string }>;
 *   skippedRevisions: number;
 * }} BackupResult
 */

/**
 * pages を先に読んで INSERT を書き、revisions はその pages の版までのものだけを書く。
 * 読んでいる間にも保存は続くので、表を複数回に分けて読むと時点がずれる。ずれは次の 2 つに限り、
 * どちらも dump の外に出すので、load は外部キーでも版の衝突でも失敗しない。
 *   - 読んだ後に作られたページ: pages に無いので、その revisions は書かない
 *   - 読んだ後に保存されたページ: revisions のうち pages.version より新しい版は書かない
 * revisions は追記だけで更新も削除もないので、書いた分は pages の版と整合する。
 * ページ同士の時点は揃わず、先に読んだページは古く、後に読んだページは新しい。
 * そのため、先に読んだページが削除や改名で title を手放し、後に読んだページがその title を取ると、
 * 生きたページの title_key が dump の中で重なる。load は部分一意索引で失敗するので、
 * 重なりを見つけた時点で backup を失敗させる（片方を落として直すと、どちらが正しいか決められない）。
 * @param {Extract<ParsedArgs, { command: "backup" }>} args
 * @param {Io} io
 * @returns {BackupResult}
 */
export function backup(args, io) {
  const target = resolveTarget(args, io);
  const dir = join(resolve(args.out), backupDirName(io.now(), args.remote));
  const dataPath = join(dir, DATA_FILE);
  io.fs.mkdir(dir);
  try {
    const migrations = readMigrations(target, io);
    io.fs.write(dataPath, "");
    io.fs.restrict(dataPath, 0o600);
    /** @param {string} table @param {Row[]} rows */
    const write = (table, rows) => {
      if (rows.length === 0) return;
      io.fs.append(dataPath, `${rows.flatMap((row) => rowStatements(table, row)).join("\n")}\n`);
    };

    /** @type {Map<string, number>} */
    const versions = new Map();
    /** @type {Set<string>} 生きたページの title_key（hex のまま比べる） */
    const aliveTitleKeys = new Set();
    /** @type {BackupResult["tables"]} */
    const tables = {};
    let skippedRevisions = 0;
    for (const table of tablesToDump(args.withTokens, migrations)) {
      const spec = /** @type {TableSpec} */ (TABLES[table]);
      const idIndex = spec.columns.findIndex(
        (c) => c.name === (table === "pages" ? "id" : "page_id"),
      );
      const versionIndex = spec.columns.findIndex((c) => c.name === "version");
      const deletedAtIndex = spec.columns.findIndex((c) => c.name === "deleted_at");
      const titleKeyIndex = spec.columns.findIndex((c) => c.name === "title_key");
      tables[table] = digestOf(readBatches(table, target, io), (batch) => {
        let kept = batch;
        if (table === "pages") {
          for (const row of batch) {
            versions.set(hexToText(String(row[idIndex])), Number(row[versionIndex]));
            if (row[deletedAtIndex] !== null) continue;
            const titleKey = String(row[titleKeyIndex]);
            if (aliveTitleKeys.has(titleKey)) {
              throw new Error(
                `pages changed while reading: two live pages share the title_key "${hexToText(titleKey)}". Run the backup again.`,
              );
            }
            aliveTitleKeys.add(titleKey);
          }
        } else if (table === "revisions") {
          kept = batch.filter((row) => {
            const pageVersion = versions.get(hexToText(String(row[idIndex])));
            return pageVersion !== undefined && Number(row[versionIndex]) <= pageVersion;
          });
          skippedRevisions += batch.length - kept.length;
        }
        write(table, kept);
        return kept;
      });
    }
    if ((tables.pages?.rows ?? 0) === 0 && args.remote) {
      throw new Error("no pages were read from the remote D1; not keeping an empty backup");
    }
    /** @type {Manifest} */
    const manifest = {
      version: 1,
      createdAt: io.now().toISOString(),
      target: args.remote ? "remote" : "local",
      file: DATA_FILE,
      migrations,
      tables,
    };
    // manifest は最後に書く。プロセスが強制終了されて manifest の無いまま残ったディレクトリは、
    // 不完全なバックアップとして load が拒む
    io.fs.write(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    return { dir, tables, skippedRevisions };
  } catch (error) {
    io.fs.rm(dir);
    throw error;
  }
}

/**
 * @param {ParsedArgs} args
 * @param {Io} io
 * @returns {Target}
 */
function resolveTarget(args, io) {
  return args.remote ? { remote: true, configPath: io.resolveRemote() } : { remote: false };
}

/**
 * migration の一覧が、バックアップの時点のものを先頭に含むか。復元先が先に進んでいるのは許す
 * （新しい migration を足したあとに、古いバックアップを新しい D1 へ戻せるように）。
 * @param {string[]} backupMigrations
 * @param {string[]} targetMigrations
 */
export function migrationsCompatible(backupMigrations, targetMigrations) {
  return backupMigrations.every((name, i) => targetMigrations[i] === name);
}

/**
 * @param {Extract<ParsedArgs, { command: "load" }>} args
 * @param {Io} io
 * @returns {{ tables: Manifest["tables"]; ahead: string[] }} 復元後の行数と digest、復元先だけにある migration
 */
export function load(args, io) {
  const dir = resolve(args.dir);
  const manifestPath = join(dir, MANIFEST_FILE);
  const dataPath = join(dir, DATA_FILE);
  if (!io.fs.exists(manifestPath) || !io.fs.exists(dataPath)) {
    throw new Error(`${dir} is not a complete backup (${MANIFEST_FILE} and ${DATA_FILE} needed)`);
  }
  const manifest = parseManifest(JSON.parse(io.fs.read(manifestPath)));
  const names = Object.keys(manifest.tables);
  const target = resolveTarget(args, io);

  // migrations の表が無いのは migration が未適用、一覧の食い違いは別の版の schema
  /** @type {string[]} */
  let applied;
  try {
    applied = readMigrations(target, io);
  } catch (error) {
    throw new Error(
      `cannot read d1_migrations in the target D1 (run db:migrate:remote first): ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!migrationsCompatible(manifest.migrations, applied)) {
    throw new Error(
      `migrations differ: the backup was taken at [${manifest.migrations.join(", ")}] but the target D1 has [${applied.join(", ")}]. Apply the same migrations (db:migrate:remote) to the new D1 first`,
    );
  }
  // バックアップに無い表（表を足す前のバックアップの attachments など）も、復元先で空であることを確かめる
  const guarded = [...new Set([...names, ...tablesToDump(false, applied)])];
  const before = Object.fromEntries(
    query(countSql(guarded), target, io).map((r) => [String(r.t), Number(r.n)]),
  );
  const filled = guarded.filter((t) => (before[t] ?? 0) > 0);
  if (filled.length > 0) {
    throw new Error(`target D1 is not empty (${filled.join(", ")}); load only into a new D1`);
  }

  runWrangler(loadArgs(dataPath, target), io);

  // 行数だけでなく全列の digest も、復元先から読み直して照合する
  /** @type {Manifest["tables"]} */
  const after = {};
  for (const table of names) after[table] = digestOf(readBatches(table, target, io));
  const mismatched = names.filter((t) => {
    const expected = /** @type {{ rows: number; sha256: string }} */ (manifest.tables[t]);
    return after[t]?.rows !== expected.rows || after[t]?.sha256 !== expected.sha256;
  });
  if (mismatched.length > 0) {
    throw new Error(
      `restored data differs from the backup: ${mismatched
        .map((t) => `${t} ${after[t]?.rows} rows (expected ${manifest.tables[t]?.rows})`)
        .join(", ")}`,
    );
  }
  const ahead = applied.slice(manifest.migrations.length);
  for (const name of ahead) {
    const sql = DATA_MIGRATIONS[name];
    if (sql === undefined) continue;
    try {
      query(sql, target, io);
    } catch (error) {
      // 生きたページ同士が新しい規則で同じ title_key になると、一意索引で止まる。行は入ったまま残る
      throw new Error(
        `loaded the backup, but could not apply the data change of ${name}: ${error instanceof Error ? error.message : error}. Rename one of the conflicting pages (open it by /p/<id>)${conflictingPages(target, io)}, then run this SQL with wrangler d1 execute: ${sql}`,
      );
    }
  }
  return { tables: after, ahead };
}

/**
 * `_` と空白だけが違う title で重なる生きたページ。エラーの案内に付けるだけなので、読めなければ空にする
 * @param {Target} target
 * @param {Io} io
 */
function conflictingPages(target, io) {
  try {
    const rows = query(
      "SELECT id, title FROM pages WHERE deleted_at IS NULL AND replace(title_key, '_', ' ') IN (SELECT replace(title_key, '_', ' ') FROM pages WHERE deleted_at IS NULL GROUP BY 1 HAVING count(*) > 1) ORDER BY replace(title_key, '_', ' '), id",
      target,
      io,
    );
    if (rows.length === 0) return "";
    return ` (${rows.map((r) => `${r.id} ${JSON.stringify(r.title)}`).join(", ")})`;
  } catch {
    return "";
  }
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
    /** @param {Record<string, { rows: number }>} tables */
    const summary = (tables) =>
      Object.entries(tables)
        .map(([t, v]) => `${t} ${v.rows}`)
        .join(", ");
    if (args.command === "backup") {
      const result = backup(args, io);
      io.stderr.write(`backed up ${where} D1 to ${result.dir} (${summary(result.tables)})\n`);
      if (result.skippedRevisions > 0) {
        io.stderr.write(
          `${result.skippedRevisions} revisions were saved while reading and are not in the backup\n`,
        );
      }
      if ((result.tables.pages?.rows ?? 0) === 0)
        io.stderr.write("warning: no pages were dumped\n");
      return 0;
    }
    const result = load(args, io);
    io.stderr.write(`loaded ${summary(result.tables)} into ${where} D1 (digests match)\n`);
    if (result.ahead.length > 0) {
      io.stderr.write(
        `note: the target D1 has newer migrations than the backup (${result.ahead.join(", ")})\n`,
      );
    }
    io.stderr.write("next: deploy the Worker, issue an API token, then run derived:rebuild\n");
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = run(process.argv.slice(2));
}
