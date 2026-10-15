// title の変更で積まれたリンクの書き換えを、POST /api/link-rewrites/step で最後まで進める。
//   node scripts/link-rewrites.mjs [--remote] [--url <base>] [--target <page id>]
// API は CPU の上限に収まるよう 1 回に 1 ページしか書き換えないので、応答の remaining が 0 になるまで繰り返す。
// --target を付けると、そのページの rename で積まれた分だけを進める。
// 既定はローカルの wrangler dev（http://localhost:8787）。--remote は deploy.env の WIKI_HOSTNAME に送る。
// write の scope を持つ API トークンを環境変数 WIKI_TOKEN から読む。値は標準出力にもログにも出さない。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEPLOY_ENV_PATH, readDeployValues } from "./deploy-config.mjs";
import { parseOriginArg } from "./origin-arg.mjs";

const LOCAL_URL = "http://localhost:8787";
// zone の Browser Integrity Check は、Node などの既定の User-Agent を弾くことがある
const USER_AGENT = "personal-wiki-link-rewrites";
/** 進み具合を標準エラーに出す呼び出しの間隔 */
const PROGRESS_EVERY = 25;
/**
 * 版の競合が続いたら止める回数。競合は書き換えるページが保存され続けているときに起き、
 * 呼び直せば読み直して進むが、保存が止まらないページで空回りし続けないようにする。
 */
export const MAX_CONSECUTIVE_CONFLICTS = 5;

const USAGE = `usage:
  link-rewrites [--remote] [--url <base>] [--target <page id>]
  環境変数 WIKI_TOKEN に write の token を入れておく（read -rs WIKI_TOKEN && export WIKI_TOKEN）`;

/**
 * @typedef {{ remote: boolean; url: string | undefined; target: string | null }} ParsedArgs
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
  let target = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = /** @type {string} */ (argv[i]);
    if (arg === "--remote") remote = true;
    else if (arg === "--local") remote = false;
    else if (arg === "--url") url = argv[++i];
    else if (arg.startsWith("--url=")) url = arg.slice("--url=".length);
    else if (arg === "--target") target = argv[++i] ?? null;
    else if (arg.startsWith("--target=")) target = arg.slice("--target=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (url !== undefined) parseOriginArg(url);
  if (remote && url !== undefined) throw new Error("--remote and --url cannot be combined");
  if (argv.includes("--target") && target === null) throw new Error("--target needs a page id");
  return { remote, url, target };
}

/**
 * @typedef {{
 *   processed: number;
 *   rewritten: number;
 *   failed: string[];
 *   calls: number;
 *   remaining: number | null;
 *   error: string | null;
 * }} RewriteSummary
 */

/**
 * 応答の形が想定どおりか。想定外の応答を黙って進めると、止まらずに空回りしうる。
 * @param {unknown} value
 * @returns {value is {
 *   processed: { rewritten: number } | null;
 *   conflict: boolean;
 *   failed: string[];
 *   remaining: number;
 * }}
 */
function isStepResponse(value) {
  if (typeof value !== "object" || value === null) return false;
  const v = /** @type {Record<string, unknown>} */ (value);
  const processed = /** @type {Record<string, unknown> | null} */ (v.processed);
  return (
    (processed === null ||
      (typeof processed === "object" && typeof processed.rewritten === "number")) &&
    typeof v.conflict === "boolean" &&
    Array.isArray(v.failed) &&
    v.failed.every((id) => typeof id === "string") &&
    typeof v.remaining === "number"
  );
}

/**
 * remaining が 0 になるまで step を呼ぶ。通信や応答の失敗では例外を投げず、そこまでの結果を返す。
 * 積んだ分はサーバーに残るので、止まったら同じ引数で呼び直せば続きから進む。
 * token はヘッダにだけ使い、メッセージには含めない。
 * @param {{
 *   baseUrl: string;
 *   token: string;
 *   target: string | null;
 *   fetch: typeof fetch;
 *   progress?: (summary: { calls: number; processed: number; remaining: number }) => void;
 * }} params
 * @returns {Promise<RewriteSummary>}
 */
export async function rewriteAll({ baseUrl, token, target, fetch: fetchFn, progress }) {
  /** @type {RewriteSummary} */
  const summary = {
    processed: 0,
    rewritten: 0,
    failed: [],
    calls: 0,
    remaining: null,
    error: null,
  };
  let conflicts = 0;
  for (;;) {
    /** @type {Response} */
    let res;
    try {
      res = await fetchFn(`${baseUrl}/api/link-rewrites/step`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(target === null ? {} : { targetPageId: target }),
      });
    } catch (error) {
      return { ...summary, error: `request failed: ${errorText(error)}` };
    }
    if (!res.ok) {
      const code = await errorCode(res);
      return {
        ...summary,
        error: `server returned ${res.status}${code === null ? "" : ` (${code})`}`,
      };
    }
    /** @type {unknown} */
    let body;
    try {
      body = await res.json();
    } catch {
      return { ...summary, error: "response is not JSON" };
    }
    if (!isStepResponse(body)) return { ...summary, error: "unexpected response shape" };
    summary.calls += 1;
    summary.remaining = body.remaining;
    summary.failed.push(...body.failed);
    if (body.processed !== null) {
      summary.processed += 1;
      summary.rewritten += body.processed.rewritten;
    }
    progress?.({ calls: summary.calls, processed: summary.processed, remaining: body.remaining });
    conflicts = body.conflict ? conflicts + 1 : 0;
    if (conflicts >= MAX_CONSECUTIVE_CONFLICTS) {
      return { ...summary, error: `version conflicts ${conflicts} times in a row` };
    }
    if (body.remaining === 0) return summary;
  }
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
 * 終了コードを返す。書き換えられなかったページがあるか、途中で止まったときは 1。
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
    io.stderr.write(`rewriting links on ${baseUrl}\n`);
    const summary = await rewriteAll({
      baseUrl,
      token,
      target: args.target,
      fetch: io.fetch,
      progress: ({ calls, processed, remaining }) => {
        if (calls % PROGRESS_EVERY === 0) {
          io.stderr.write(`  ${processed} pages rewritten, ${remaining} left\n`);
        }
      },
    });
    io.stderr.write(
      `rewrote ${summary.rewritten} links in ${summary.processed} pages, failed ${summary.failed.length}\n`,
    );
    if (summary.failed.length > 0) {
      io.stderr.write(
        `failed pages (links to the old title left as is):\n${summary.failed.map((id) => `  ${id}\n`).join("")}`,
      );
    }
    if (summary.error !== null) {
      const left = summary.remaining === null ? "" : ` (${summary.remaining} pages left)`;
      io.stderr.write(`stopped: ${summary.error}${left}\nrun the same command again to resume\n`);
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
