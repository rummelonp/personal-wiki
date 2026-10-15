// 全ページの派生データ（links、tags、抜粋、検索の索引）を、POST /api/admin/derived/rebuild で作り直す。
//   node scripts/derived-rebuild.mjs [--remote] [--url <base>] [--after <id>]
// API は CPU の上限に収まるよう 1 回に 1 ページしか進まないので、応答の next が null になるまで繰り返す。
// 既定はローカルの wrangler dev（http://localhost:8787）。--remote は deploy.env の WIKI_HOSTNAME に送る。
// write の scope を持つ API トークンを環境変数 WIKI_TOKEN から読む。値は標準出力にもログにも出さない。
// 派生データの形が変わる更新（migration で表を足したときなど）のあとと、Worker を前の版に戻して
// 再デプロイしたあとに実行する。
//   pnpm derived:rebuild --remote
// 途中で止まったら、表示される `--after <id>` を付けて続きから再開する。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEPLOY_ENV_PATH, readDeployValues } from "./deploy-config.mjs";
import { parseOriginArg } from "./origin-arg.mjs";

const LOCAL_URL = "http://localhost:8787";
// zone の Browser Integrity Check は、Node などの既定の User-Agent を弾くことがある
const USER_AGENT = "personal-wiki-derived-rebuild";
/** 進み具合を標準エラーに出す呼び出しの間隔 */
const PROGRESS_EVERY = 25;

const USAGE = `usage:
  derived-rebuild [--remote] [--url <base>] [--after <id>]
  環境変数 WIKI_TOKEN に write の token を入れておく（read -rs WIKI_TOKEN && export WIKI_TOKEN）`;

/**
 * @typedef {{ remote: boolean; url: string | undefined; after: string | null }} ParsedArgs
 */

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  let remote = false;
  /** @type {string | undefined} */
  let url;
  /** @type {string | null} */
  let after = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = /** @type {string} */ (argv[i]);
    if (arg === "--remote") remote = true;
    else if (arg === "--local") remote = false;
    else if (arg === "--url") url = argv[++i];
    else if (arg.startsWith("--url=")) url = arg.slice("--url=".length);
    else if (arg === "--after") after = argv[++i] ?? null;
    else if (arg.startsWith("--after=")) after = arg.slice("--after=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (url !== undefined) parseOriginArg(url);
  if (remote && url !== undefined) throw new Error("--remote and --url cannot be combined");
  if (argv.includes("--after") && after === null) throw new Error("--after needs a page id");
  return { remote, url, after };
}

/**
 * @typedef {{
 *   rebuilt: number;
 *   skipped: number;
 *   failed: string[];
 *   calls: number;
 *   stoppedAfter: string | null;
 *   error: string | null;
 * }} RebuildSummary
 */

/**
 * 応答の形が想定どおりか。想定外の応答を黙って進めると、止まらずに空回りしうる。
 * @param {unknown} value
 * @returns {value is { rebuilt: number; skipped: number; failed: string[]; next: string | null }}
 */
function isRebuildResponse(value) {
  if (typeof value !== "object" || value === null) return false;
  const v = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof v.rebuilt === "number" &&
    typeof v.skipped === "number" &&
    Array.isArray(v.failed) &&
    v.failed.every((id) => typeof id === "string") &&
    (v.next === null || typeof v.next === "string")
  );
}

/**
 * next が null になるまで rebuild を呼ぶ。通信や応答の失敗では例外を投げず、そこまでの結果と
 * 再開位置（stoppedAfter）を返す。token はヘッダにだけ使い、メッセージには含めない。
 * @param {{
 *   baseUrl: string;
 *   token: string;
 *   after: string | null;
 *   fetch: typeof fetch;
 *   progress?: (summary: { calls: number; rebuilt: number }) => void;
 * }} params
 * @returns {Promise<RebuildSummary>}
 */
export async function rebuildAll({ baseUrl, token, after, fetch: fetchFn, progress }) {
  /** @type {RebuildSummary} */
  const summary = { rebuilt: 0, skipped: 0, failed: [], calls: 0, stoppedAfter: null, error: null };
  let cursor = after;
  for (;;) {
    /** @type {Response} */
    let res;
    try {
      res = await fetchFn(`${baseUrl}/api/admin/derived/rebuild`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({ after: cursor }),
      });
    } catch (error) {
      return stopped(summary, cursor, `request failed: ${errorText(error)}`);
    }
    if (!res.ok) {
      const code = await errorCode(res);
      return stopped(
        summary,
        cursor,
        `server returned ${res.status}${code === null ? "" : ` (${code})`}`,
      );
    }
    /** @type {unknown} */
    let body;
    try {
      body = await res.json();
    } catch {
      return stopped(summary, cursor, "response is not JSON");
    }
    if (!isRebuildResponse(body)) return stopped(summary, cursor, "unexpected response shape");
    summary.calls += 1;
    summary.rebuilt += body.rebuilt;
    summary.skipped += body.skipped;
    summary.failed.push(...body.failed);
    progress?.({ calls: summary.calls, rebuilt: summary.rebuilt });
    if (body.next === null) return summary;
    if (body.next === cursor) return stopped(summary, cursor, "cursor did not advance");
    cursor = body.next;
  }
}

/**
 * @param {RebuildSummary} summary
 * @param {string | null} cursor
 * @param {string} error
 * @returns {RebuildSummary}
 */
function stopped(summary, cursor, error) {
  return { ...summary, stoppedAfter: cursor, error };
}

/** @param {unknown} error */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {Response} res */
async function errorCode(res) {
  try {
    const body = /** @type {{ error?: unknown }} */ (await res.json());
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {{
 *   fetch: typeof fetch;
 *   env: Record<string, string | undefined>;
 *   stderr: { write(chunk: string): unknown };
 *   readDeployEnv: () => string;
 * }} Io
 */

/** @type {Io} */
const defaultIo = {
  fetch,
  env: process.env,
  stderr: process.stderr,
  readDeployEnv: () => readFileSync(DEPLOY_ENV_PATH, "utf8"),
};

/**
 * @param {ParsedArgs} args
 * @param {Io} io
 */
function resolveBaseUrl(args, io) {
  if (args.url !== undefined) return args.url;
  if (!args.remote) return LOCAL_URL;
  let text;
  try {
    text = io.readDeployEnv();
  } catch {
    throw new Error("deploy.env not found (copy deploy.env.example to deploy.env)");
  }
  const result = readDeployValues(text);
  if ("problems" in result) throw new Error(`deploy.env: ${result.problems.join("; ")}`);
  return `https://${result.values.hostname}`;
}

/**
 * 終了コードを返す。失敗したページがあるか、途中で止まったときは 1。
 * @param {string[]} argv
 * @param {Io} [io]
 * @returns {Promise<number>}
 */
export async function run(argv, io = defaultIo) {
  try {
    const args = parseArgs(argv);
    const token = io.env.WIKI_TOKEN?.trim();
    if (token === undefined || token === "") {
      throw new Error("WIKI_TOKEN is not set (a token with the write scope)");
    }
    const baseUrl = resolveBaseUrl(args, io);
    io.stderr.write(`rebuilding derived data on ${baseUrl}\n`);
    const summary = await rebuildAll({
      baseUrl,
      token,
      after: args.after,
      fetch: io.fetch,
      progress: ({ calls, rebuilt }) => {
        if (calls % PROGRESS_EVERY === 0) io.stderr.write(`  ${rebuilt} pages rebuilt\n`);
      },
    });
    io.stderr.write(
      `rebuilt ${summary.rebuilt}, skipped ${summary.skipped} (saved again while rebuilding), failed ${summary.failed.length}\n`,
    );
    if (summary.failed.length > 0) {
      io.stderr.write(
        `failed pages (derived data left as before):\n${summary.failed.map((id) => `  ${id}\n`).join("")}`,
      );
    }
    if (summary.error !== null) {
      const resume = summary.stoppedAfter === null ? "" : ` --after ${summary.stoppedAfter}`;
      io.stderr.write(`stopped: ${summary.error}\nresume with:${resume || " (from the start)"}\n`);
      return 1;
    }
    return summary.failed.length > 0 ? 1 : 0;
  } catch (error) {
    io.stderr.write(`${errorText(error)}\n${USAGE}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await run(process.argv.slice(2));
}
