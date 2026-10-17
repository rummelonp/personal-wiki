// API トークンを発行する、失効させる、一覧を出す。
//   node scripts/api-token.mjs issue <name> --scopes read|read,write [--remote]
//   node scripts/api-token.mjs revoke <name> | --id <id> [--remote]
//   node scripts/api-token.mjs list [--remote]
// 既定はローカルの D1（wrangler d1 execute --local）。本番に書くときだけ --remote を付ける。
// --remote は deploy.env から合成した設定（deploy-config.mjs）で D1 を解決する。
// pnpm 経由で標準出力をパイプに渡すときは、pnpm 自身の表示が混ざらないよう apps/worker で
// `pnpm -s api-token` として呼ぶ（--filter を付けると -s でも実行するコマンドが表示される）。
// 発行したトークンの平文は標準出力にだけ出す。D1 に渡すのは hash だけで、平文はコマンドラインにも載せない。
// トークンを識別するのは id で、name は重複してよいラベル。
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeGeneratedConfig } from "./deploy-config.mjs";

const D1_BINDING = "DB";
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ID_PATTERN = /^[1-9][0-9]{0,14}$/;
const SCOPE_SETS = new Map([
  ["read", "read"],
  ["write", "read write"],
  ["read,write", "read write"],
]);

const USAGE = `usage:
  api-token issue <name> --scopes read|read,write [--remote]
  api-token revoke <name> | --id <id> [--remote]
  api-token list [--remote]`;

/** 32 バイトの乱数を base64url（43 文字）にする。Worker の isWellFormedApiToken と同じ形式。 */
export function generateToken() {
  return randomBytes(32).toString("base64url");
}

/** @param {string} token */
export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * @typedef {{ command: "issue"; name: string; scopes: string; remote: boolean }
 *   | { command: "revoke"; name: string; remote: boolean }
 *   | { command: "revoke"; id: number; remote: boolean }
 *   | { command: "list"; remote: boolean }} ParsedArgs
 */

/**
 * name は SQL に埋め込むので、引用符などを含まない文字種に限る。
 * @param {string | undefined} name
 * @returns {string}
 */
export function checkName(name) {
  if (name === undefined || !NAME_PATTERN.test(name)) {
    throw new Error("name must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/");
  }
  return name;
}

/**
 * --scopes の指定を、D1 に保存する形（空白区切り）にする。
 * @param {string | undefined} arg
 * @returns {string}
 */
export function resolveScopes(arg) {
  const scopes = arg === undefined ? undefined : SCOPE_SETS.get(arg);
  if (scopes === undefined) throw new Error("--scopes must be read or read,write");
  return scopes;
}

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  const positional = [];
  /** @type {string | undefined} */
  let scopesArg;
  /** @type {string | undefined} */
  let idArg;
  let remote = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = /** @type {string} */ (argv[i]);
    if (arg === "--remote") remote = true;
    else if (arg === "--local") remote = false;
    else if (arg === "--scopes") scopesArg = argv[++i];
    else if (arg.startsWith("--scopes=")) scopesArg = arg.slice("--scopes=".length);
    else if (arg === "--id") idArg = argv[++i] ?? "";
    else if (arg.startsWith("--id=")) idArg = arg.slice("--id=".length);
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  const [command, ...rest] = positional;
  if (scopesArg !== undefined && command !== "issue") throw new Error("--scopes is only for issue");
  if (idArg !== undefined && command !== "revoke") throw new Error("--id is only for revoke");
  if (command === "list") {
    if (rest.length > 0) throw new Error(`unexpected argument: ${rest.join(" ")}`);
    return { command, remote };
  }
  const [name, ...extra] = rest;
  if (extra.length > 0) throw new Error(`unexpected argument: ${extra.join(" ")}`);
  if (command === "issue") {
    const scopes = resolveScopes(scopesArg);
    return { command, name: checkName(name), scopes, remote };
  }
  if (command === "revoke") {
    if (idArg === undefined) return { command, name: checkName(name), remote };
    if (name !== undefined) throw new Error("give either a name or --id, not both");
    // id も SQL に埋め込むので、数字だけに限る
    if (!ID_PATTERN.test(idArg)) throw new Error("--id must be a positive integer");
    return { command, id: Number(idArg), remote };
  }
  throw new Error(`unknown command: ${command ?? "(none)"}`);
}

// wrangler d1 execute --command はバインド変数を受け付けないので、値を SQL に埋め込む。
// 埋め込む値は parseArgs で検査した name と id、hex の hash、固定の scopes、数値だけにする。
// ローカルの wrangler d1 execute は変更行数（meta.changes）を返さないので、書き込みは RETURNING の行で数える。

/** @param {{ name: string; tokenHash: string; scopes: string; now: number }} params */
export function issueSql({ name, tokenHash, scopes, now }) {
  return `INSERT INTO api_tokens (name, token_hash, scopes, created_at) VALUES ('${name}', '${tokenHash}', '${scopes}', ${now}) RETURNING id`;
}

/** @param {string} name */
export function activeIdsSql(name) {
  return `SELECT id FROM api_tokens WHERE name = '${name}' AND revoked_at IS NULL ORDER BY id`;
}

/** @param {{ id: number; now: number }} params */
export function revokeSql({ id, now }) {
  return `UPDATE api_tokens SET revoked_at = ${now} WHERE id = ${id} AND revoked_at IS NULL RETURNING id, name`;
}

/** token_hash は出さない */
export const LIST_SQL =
  "SELECT id, name, scopes, created_at, last_used_at, revoked_at FROM api_tokens ORDER BY id";

/**
 * @param {string} sql
 * @param {{ remote: false } | { remote: true; configPath: string }} target
 *   remote では、D1 の ID を持つ設定ファイルを渡す
 * @returns {string[]}
 */
export function wranglerArgs(sql, target) {
  const where = target.remote ? ["--remote", "--config", target.configPath] : ["--local"];
  return ["d1", "execute", D1_BINDING, ...where, "--json", "--command", sql];
}

/**
 * テストで wrangler の実行と出力先を差し替えるための口。
 * @typedef {{
 *   spawn: (command: string, args: string[], options: import("node:child_process").SpawnSyncOptionsWithStringEncoding) => { status: number | null; stdout: string };
 *   stdout: { write(chunk: string): unknown };
 *   stderr: { write(chunk: string): unknown };
 *   now: () => number;
 * }} Io
 */

/** @type {Io} */
const defaultIo = {
  spawn: spawnSync,
  stdout: process.stdout,
  stderr: process.stderr,
  now: Date.now,
};

/**
 * @typedef {{
 *   id: number;
 *   name: string;
 *   scopes: string;
 *   created_at: number;
 *   last_used_at: number | null;
 *   revoked_at: number | null;
 * }} TokenRow
 */

/**
 * wrangler で SQL を 1 文実行し、結果の行を返す。wrangler の出力は標準出力に流さない
 * （標準出力には発行したトークンと一覧だけを出すため）。
 * @param {string} sql
 * @param {Parameters<typeof wranglerArgs>[1]} where
 * @param {Io} io
 * @returns {Record<string, unknown>[]}
 */
function query(sql, where, io) {
  const require = createRequire(import.meta.url);
  const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const result = io.spawn(process.execPath, [wranglerBin, ...wranglerArgs(sql, where)], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    io.stderr.write(result.stdout ?? "");
    throw new Error(`wrangler exited with ${result.status}`);
  }
  /** @type {{ results?: Record<string, unknown>[] }[]} */
  const parsed = JSON.parse(result.stdout);
  return parsed.flatMap((r) => r.results ?? []);
}

/** @param {number | null} ms */
function formatTime(ms) {
  return ms === null ? "-" : new Date(ms).toISOString();
}

/**
 * 列を空白でそろえた表にする。scopes は空白を含むので、列の間は 2 文字空ける。
 * @param {TokenRow[]} rows
 */
export function formatList(rows) {
  const header = ["id", "name", "scopes", "created", "last used", "revoked"];
  const lines = [
    header,
    ...rows.map((r) => [
      String(r.id),
      r.name,
      r.scopes,
      formatTime(r.created_at),
      formatTime(r.last_used_at),
      formatTime(r.revoked_at),
    ]),
  ];
  const widths = header.map((_, i) => Math.max(...lines.map((l) => (l[i] ?? "").length)));
  return lines
    .map((l) =>
      l
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** @param {Record<string, unknown>[]} rows */
const idsOf = (rows) => rows.map((r) => Number(r.id));

/**
 * @param {string[]} argv
 * @param {Io} [io]
 */
export function main(argv, io = defaultIo) {
  const args = parseArgs(argv);
  const target = args.remote ? "remote" : "local";
  // 設定が足りないときに、トークンを作る前に止める
  /** @type {Parameters<typeof wranglerArgs>[1]} */
  const where = args.remote
    ? { remote: true, configPath: writeGeneratedConfig() }
    : { remote: false };
  const now = io.now();
  if (args.command === "list") {
    const rows = /** @type {TokenRow[]} */ (query(LIST_SQL, where, io));
    io.stdout.write(`${formatList(rows)}\n`);
    return;
  }
  if (args.command === "issue") {
    // 発行の後に読むと、その読み取りが失敗したときに平文を出せないまま有効な行が残るので、先に読む
    const others = idsOf(query(activeIdsSql(args.name), where, io));
    const token = generateToken();
    const [inserted] = query(issueSql({ ...args, tokenHash: hashToken(token), now }), where, io);
    if (inserted === undefined) throw new Error(`could not issue "${args.name}" on ${target} D1`);
    io.stderr.write(
      `issued "${args.name}" as id ${inserted.id} (${args.scopes}) on ${target} D1\n`,
    );
    if (others.length > 0) {
      io.stderr.write(
        `note: "${args.name}" also has active tokens with id ${others.join(", ")}; revoke the old one with "revoke --id <id>" if it is no longer used\n`,
      );
    }
    io.stdout.write(`${token}\n`);
    return;
  }
  /** @type {number} */
  let id;
  if ("id" in args) {
    id = args.id;
  } else {
    const ids = idsOf(query(activeIdsSql(args.name), where, io));
    if (ids.length === 0) throw new Error(`no active token named "${args.name}" on ${target} D1`);
    if (ids.length > 1) {
      throw new Error(
        `${ids.length} active tokens are named "${args.name}" on ${target} D1 (id ${ids.join(", ")}); nothing was revoked. Choose one with --id`,
      );
    }
    id = /** @type {number} */ (ids[0]);
  }
  const [revoked] = query(revokeSql({ id, now }), where, io);
  if (revoked === undefined) throw new Error(`no active token with id ${id} on ${target} D1`);
  io.stderr.write(`revoked "${revoked.name}" (id ${revoked.id}) on ${target} D1\n`);
}

/**
 * main を実行し、プロセスの終了コードを返す。
 * @param {string[]} argv
 * @param {Io} [io]
 * @returns {number}
 */
export function run(argv, io = defaultIo) {
  try {
    main(argv, io);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = run(process.argv.slice(2));
}
