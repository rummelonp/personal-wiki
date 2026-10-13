// API トークンを発行・失効する。
//   node scripts/api-token.mjs issue <name> --scopes read|read,write [--remote]
//   node scripts/api-token.mjs revoke <name> [--remote]
// 既定はローカルの D1（wrangler d1 execute --local）。本番に書くときだけ --remote を付ける。
// --remote は deploy.env から合成した設定（deploy-config.mjs）で D1 を解決する。
// pnpm 経由で標準出力をパイプに渡すときは、pnpm 自身の表示が混ざらないよう apps/worker で
// `pnpm -s api-token` として呼ぶ（--filter を付けると -s でも実行するコマンドが表示される）。
// 発行したトークンの平文は標準出力にだけ出す。D1 に渡すのは hash だけで、平文はコマンドラインにも載せない。
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeGeneratedConfig } from "./deploy-config.mjs";

const D1_BINDING = "DB";
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SCOPE_SETS = new Map([
  ["read", "read"],
  ["write", "read write"],
  ["read,write", "read write"],
]);

const USAGE = `usage:
  api-token issue <name> --scopes read|read,write [--remote]
  api-token revoke <name> [--remote]`;

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
 *   | { command: "revoke"; name: string; remote: boolean }} ParsedArgs
 */

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  const positional = [];
  /** @type {string | undefined} */
  let scopesArg;
  let remote = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = /** @type {string} */ (argv[i]);
    if (arg === "--remote") remote = true;
    else if (arg === "--local") remote = false;
    else if (arg === "--scopes") scopesArg = argv[++i];
    else if (arg.startsWith("--scopes=")) scopesArg = arg.slice("--scopes=".length);
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  const [command, name, ...rest] = positional;
  if (rest.length > 0) throw new Error(`unexpected argument: ${rest.join(" ")}`);
  // name は SQL に埋め込むので、引用符などを含まない文字種に限る
  if (name === undefined || !NAME_PATTERN.test(name)) {
    throw new Error("name must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/");
  }
  if (command === "issue") {
    const scopes = scopesArg === undefined ? undefined : SCOPE_SETS.get(scopesArg);
    if (scopes === undefined) throw new Error("--scopes must be read or read,write");
    return { command, name, scopes, remote };
  }
  if (command === "revoke") {
    if (scopesArg !== undefined) throw new Error("--scopes is only for issue");
    return { command, name, remote };
  }
  throw new Error(`unknown command: ${command ?? "(none)"}`);
}

/**
 * wrangler d1 execute --command はバインド変数を受け付けないので、値を SQL に埋め込む。
 * 埋め込む値は parseArgs で検査した name、hex の hash、固定の scopes、数値だけにする。
 * 失効済みの行も名前を持ち続けるので、名前が使用済みなら 0 行にして RETURNING の行数で見分ける
 * （UNIQUE 制約の失敗にすると wrangler の生のエラーしか出ない）。
 * @param {{ name: string; tokenHash: string; scopes: string; now: number }} params
 */
export function issueSql({ name, tokenHash, scopes, now }) {
  return `INSERT INTO api_tokens (name, token_hash, scopes, created_at) SELECT '${name}', '${tokenHash}', '${scopes}', ${now} WHERE NOT EXISTS (SELECT 1 FROM api_tokens WHERE name = '${name}') RETURNING id`;
}

/**
 * ローカルの wrangler d1 execute は変更行数（meta.changes）を返さないので、RETURNING の行で数える。
 * @param {{ name: string; now: number }} params
 */
export function revokeSql({ name, now }) {
  return `UPDATE api_tokens SET revoked_at = ${now} WHERE name = '${name}' AND revoked_at IS NULL RETURNING id`;
}

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
 * wrangler を実行し、結果の行数を返す。wrangler の出力は標準出力に流さない
 * （標準出力には発行したトークンだけを出すため）。
 * @param {string[]} args
 * @param {Io} io
 * @returns {number}
 */
function runWrangler(args, io) {
  const require = createRequire(import.meta.url);
  const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const result = io.spawn(process.execPath, [wranglerBin, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    io.stderr.write(result.stdout ?? "");
    throw new Error(`wrangler exited with ${result.status}`);
  }
  /** @type {{ results?: unknown[] }[]} */
  const parsed = JSON.parse(result.stdout);
  return parsed.reduce((sum, r) => sum + (r.results?.length ?? 0), 0);
}

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
  if (args.command === "issue") {
    const token = generateToken();
    const inserted = runWrangler(
      wranglerArgs(issueSql({ ...args, tokenHash: hashToken(token), now }), where),
      io,
    );
    if (inserted === 0) {
      throw new Error(
        `token name "${args.name}" is already used on ${target} D1 (revoked tokens keep their names); choose another name`,
      );
    }
    io.stderr.write(`issued "${args.name}" (${args.scopes}) on ${target} D1\n`);
    io.stdout.write(`${token}\n`);
    return;
  }
  const changes = runWrangler(wranglerArgs(revokeSql({ ...args, now }), where), io);
  if (changes === 0) throw new Error(`no active token named "${args.name}" on ${target} D1`);
  io.stderr.write(`revoked "${args.name}" on ${target} D1\n`);
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
