// ローカル専用: owner としてログインした状態で wiki を開く。
// 乱数の SESSION_SECRET で wrangler dev を起動し、前段の proxy がリクエストごとに owner の
// セッション cookie を足す。ブラウザには cookie を持たせないので、http の localhost に Secure の
// cookie を置けない WebKit（iOS の Simulator の Safari を含む）でも owner で入れる。
// 秘密は起動ごとに作り直して OS の一時ディレクトリに置き、.dev.vars と本番の秘密には触れない。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { connect } from "node:net";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSPECTOR_OFFSET,
  OWNER_EMAIL,
  writeLocalConfig,
  writeLocalSecrets,
} from "./local-dev.mjs";
import { mintSessionValue, SESSION_COOKIE_NAME } from "./session-cookie.mjs";

const WORKER_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * 開発の wrangler dev（8787、inspector 9229）と E2E（8790 から）を避ける。
 * 内側の wrangler dev は port + 1、inspector は E2E と同じく port からの差で決める。
 */
const DEFAULT_PORT = 8780;
const MAX_PORT = 65535 - INSPECTOR_OFFSET;

const USAGE = `usage: pnpm dev:owner [--port <n>]

owner としてログインした状態の wiki を http://localhost:<port>（既定は ${DEFAULT_PORT}）で開く。
ローカルの D1（pnpm db:migrate で作るもの）を使う。本番（--remote）には向けられない。`;

/**
 * @param {string[]} argv
 * @returns {{ port: number }}
 */
export function parseArgs(argv) {
  // pnpm dev:owner -- --port 8700 のように渡しても受ける（deploy.mjs の extraArgs と同じ）
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let port = DEFAULT_PORT;
  for (let i = 0; i < args.length; i++) {
    const arg = /** @type {string} */ (args[i]);
    if (arg === "--remote") {
      throw new Error("dev:owner only runs locally; --remote is not supported");
    }
    let value;
    if (arg === "--port") value = args[++i];
    else if (arg.startsWith("--port=")) value = arg.slice("--port=".length);
    else throw new Error(`unknown argument: ${arg}`);
    port = Number(value);
    if (!/^\d+$/.test(value ?? "") || port < 1024 || port > MAX_PORT) {
      throw new Error(`--port must be an integer between 1024 and ${MAX_PORT}`);
    }
  }
  return { port };
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Host ヘッダーが、proxy が受けたポートの loopback の名前か。DNS rebinding では、外のページが
 * 自分のドメインを 127.0.0.1 に向け直して proxy に届くが、Host はそのドメインのままなので拒める。
 * @param {string | undefined} host
 * @param {number} port
 */
export function isLoopbackHost(host, port) {
  if (host === undefined || !/^[^/?#@\\\s]+$/.test(host)) return false;
  let url;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(url.hostname) && url.port === String(port);
}

/**
 * Cookie ヘッダーから同名のセッション cookie を除く。別のポートの localhost で置かれた cookie も
 * ブラウザは送ってくるので、残すと Worker がどちらを読むかが定まらない。
 * @param {string | undefined} cookie
 */
function withoutSessionCookie(cookie) {
  return (cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !part.startsWith(`${SESSION_COOKIE_NAME}=`));
}

/**
 * owner の cookie を足してよいリクエストか。ブラウザが cookie を持っていれば SameSite=Lax で
 * 別の site からのリクエストには付かないが、proxy はブラウザの外で足すのでその制限が効かない。
 * 代わりに Sec-Fetch-Site で、wiki 自身のページ（same-origin）と、アドレスバーやブックマークから
 * 開いたとき（none）に限る。same-site は別のポートの localhost（ほかの開発サーバー）なので除く。
 * 付けないブラウザや curl は区別できないので足す。
 * @param {string | string[] | undefined} fetchSite
 */
function isOwnRequest(fetchSite) {
  return fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "none";
}

/**
 * proxy のリクエストの処理。Host を書き換えずに渡すのは、Worker が CSRF の検査で Origin を
 * リクエストの URL（Host から作られる）と比べるため。
 * @param {{ upstreamPort: number; sessionSecret: string; email: string }} options
 * @returns {http.RequestListener}
 */
export function createProxyHandler({ upstreamPort, sessionSecret, email }) {
  return (req, res) => {
    if (!isLoopbackHost(req.headers.host, req.socket.localPort ?? -1)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("dev:owner accepts only localhost, 127.0.0.1 or [::1] with its port as Host\n");
      return;
    }
    // absolute-form（GET http://other/ ...）をそのまま渡すと、上流が Host と URL のどちらから宛先を
    // 決めるかが実装次第になり、Host を検査した意味がなくなる
    if (!req.url?.startsWith("/")) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("dev:owner accepts only origin-form request targets\n");
      return;
    }
    const headers = { ...req.headers };
    const cookies = withoutSessionCookie(headers.cookie);
    // Authorization 付き（API token や MCP の確かめ）に cookie を足すと、Worker は併用として 400 にする
    if (headers.authorization === undefined && isOwnRequest(headers["sec-fetch-site"])) {
      cookies.push(`${SESSION_COOKIE_NAME}=${mintSessionValue(sessionSecret, email)}`);
    }
    if (cookies.length > 0) headers.cookie = cookies.join("; ");
    else delete headers.cookie;

    const upstream = http.request(
      { host: "127.0.0.1", port: upstreamPort, method: req.method, path: req.url, headers },
      (upstreamRes) => {
        // ログアウトなどで Worker が cookie を消しても、ブラウザの別のポートの localhost の
        // cookie を巻き込まないよう、セッション cookie の Set-Cookie はブラウザに渡さない
        const responseHeaders = { ...upstreamRes.headers };
        const setCookie = responseHeaders["set-cookie"]?.filter(
          (line) => !line.startsWith(`${SESSION_COOKIE_NAME}=`),
        );
        if (setCookie === undefined || setCookie.length === 0) delete responseHeaders["set-cookie"];
        else responseHeaders["set-cookie"] = setCookie;
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, responseHeaders);
        upstreamRes.pipe(res);
      },
    );
    // ブラウザが途中で切ったら上流へのリクエストも切り、読む相手のいない応答を wrangler dev に残さない
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.on("error", (error) => {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`wrangler dev did not respond: ${error.message}\n`);
    });
    req.pipe(upstream);
  };
}

/** @param {number} port */
function portInUse(port) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} port
 */
async function waitForHealthy(child, port) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // pid が無いのは起動そのものに失敗したとき（理由は error のイベントで出す）
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      throw new Error("wrangler dev exited before it became ready");
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/healthz`);
      if (res.ok) return;
    } catch {
      // 起動中
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("wrangler dev did not become ready within 60 seconds");
}

/**
 * 127.0.0.1 と ::1 の両方で待つ。localhost をどちらに引くかはブラウザと OS で違う。
 * IPv6 が無い環境では ::1 を諦める。
 * @param {http.RequestListener} handler
 * @param {number} port
 * @returns {Promise<http.Server[]>}
 */
async function listenOnLoopback(handler, port) {
  /** @type {http.Server[]} */
  const servers = [];
  for (const host of ["127.0.0.1", "::1"]) {
    const server = http.createServer(handler);
    try {
      await new Promise((done, fail) => {
        server.once("error", fail);
        server.listen(port, host, () => done(undefined));
      });
      servers.push(server);
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (host === "::1" && (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT")) continue;
      for (const s of servers) s.close();
      throw error;
    }
  }
  return servers;
}

/**
 * proxy を通した /api/me が owner を返すか確かめる。wrangler dev が --env-file を読まなかったとき
 * （環境変数で読まない設定にされたときなど）は owner の経路が閉じ、画面は匿名のまま開くので、
 * 起動の時点で止める。
 * @param {number} port
 */
async function assertOwner(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/me`);
  const body = /** @type {{ kind?: unknown } | undefined} */ (
    await res.json().catch(() => undefined)
  );
  if (body?.kind !== "owner") {
    throw new Error(
      `self-check failed: /api/me through the proxy returned ${res.status} ${JSON.stringify(body?.kind)}, ` +
        "not owner. wrangler dev did not pick up the session secret from --env-file.",
    );
  }
}

/** @param {string[]} argv */
async function run(argv) {
  let port;
  try {
    ({ port } = parseArgs(argv));
  } catch (error) {
    console.error(`${/** @type {Error} */ (error).message}\n\n${USAGE}`);
    return 2;
  }
  const upstreamPort = port + 1;
  const inspectorPort = port + INSPECTOR_OFFSET;

  /** @type {string | undefined} */
  let dir;
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let child;
  /** @type {http.Server[]} */
  let servers = [];
  let stopping = false;
  /** @type {NodeJS.Timeout | undefined} */
  let killTimer;

  // wrangler は workerd を子に持つので、detached で作ったプロセスグループごと止める
  /** @param {NodeJS.Signals} signal */
  const signalGroup = (signal) => {
    try {
      if (child?.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      // すでに終わっている
    }
  };
  const cleanup = () => {
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
    servers = [];
    signalGroup("SIGKILL");
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  };
  // 秘密を含む一時ディレクトリと wrangler dev を残さない範囲:
  // - SIGINT、SIGTERM、SIGHUP の 1 回目は wrangler dev を SIGTERM で止め、5 秒で終わらなければ
  //   SIGKILL にする。終わったら後片付けをして 0 で終える。wrangler dev を起動する前なら、
  //   後片付けをして 128 + シグナルの番号で終える
  // - 2 回目はその場で SIGKILL を送り、一時ディレクトリを消して終える
  // - 例外などで process が終わるときは exit で同じ後片付けをする
  // この process 自身が SIGKILL で止められたときは何も消せない。
  // ハンドラが無いと、Node はシグナルで exit を出さずに終わるので、一時ディレクトリを作る前に置く。
  /** @param {NodeJS.Signals} signal */
  const onSignal = (signal) => {
    const code = 128 + (osConstants.signals[signal] ?? 0);
    if (stopping) {
      signalGroup("SIGKILL");
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      process.exit(code);
    }
    stopping = true;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      cleanup();
      process.exit(code);
    }
    signalGroup("SIGTERM");
    killTimer = setTimeout(() => signalGroup("SIGKILL"), 5000);
  };
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
    process.on(signal, onSignal);
  }
  process.on("exit", cleanup);

  for (const p of [port, upstreamPort, inspectorPort]) {
    if (await portInUse(p)) {
      console.error(`port ${p} is in use. Pick another base port with --port.`);
      return 1;
    }
  }

  dir = mkdtempSync(join(tmpdir(), "personal-wiki-dev-owner-"));
  const sessionSecret = randomBytes(32).toString("base64");
  /** @type {Promise<number | null>} */
  let exited;
  try {
    const config = writeLocalConfig(dir);
    const envFile = writeLocalSecrets(dir, { sessionSecret, audience: "dev-owner-audience" });
    // テストは wrangler の代わりに、シグナルの扱いを決められる小さなサーバーを起動する。
    // 手元の環境変数に残っていて気づかないまま別物を起動しないよう、使ったときは知らせる。
    const override = process.env.DEV_OWNER_WRANGLER;
    if (override)
      console.error(`DEV_OWNER_WRANGLER is set: starting ${override} instead of wrangler`);
    const spawned = spawn(
      override || join(WORKER_DIR, "node_modules/.bin/wrangler"),
      [
        "dev",
        "-c",
        config,
        "--env-file",
        envFile,
        // 設定を一時ディレクトリに移しても、pnpm dev と pnpm db:migrate と同じローカルの D1 を使う
        "--persist-to",
        join(WORKER_DIR, ".wrangler/state"),
        "--port",
        String(upstreamPort),
        "--inspector-port",
        String(inspectorPort),
        "--ip",
        "127.0.0.1",
        "--show-interactive-dev-session=false",
      ],
      {
        cwd: dir,
        // LOAD_DEV_VARS が false だと wrangler は --env-file も読まない。INCLUDE_PROCESS_ENV が
        // true だと手元の環境変数が Worker の env に入り、乱数の秘密の代わりにシェルの値が使われうる
        env: {
          ...process.env,
          CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "true",
          CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
        },
        stdio: ["ignore", "inherit", "inherit"],
        detached: true,
      },
    );
    child = spawned;
    exited = new Promise((done) => {
      spawned.once("exit", (code) => done(code));
      spawned.once("error", (error) => {
        console.error(`failed to start wrangler dev: ${error.message}`);
        done(1);
      });
    });
    await waitForHealthy(spawned, upstreamPort);
    if (!stopping) {
      servers = await listenOnLoopback(
        createProxyHandler({ upstreamPort, sessionSecret, email: OWNER_EMAIL }),
        port,
      );
      await assertOwner(port);
    }
  } catch (error) {
    if (!stopping) console.error(/** @type {Error} */ (error).message);
    clearTimeout(killTimer);
    cleanup();
    return stopping ? 0 : 1;
  }

  if (!stopping) {
    console.log(
      `\ndev:owner: open http://localhost:${port} (signed in as ${OWNER_EMAIL}).\n` +
        "Logging out does not stick: reloading signs you in again. " +
        `For the anonymous view, open http://localhost:${upstreamPort}.\n`,
    );
  }

  const code = await exited;
  clearTimeout(killTimer);
  cleanup();
  // wrangler は SIGTERM で 143 を返すので、こちらから止めたときは正常の終了にする
  return stopping ? 0 : (code ?? 1);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await run(process.argv.slice(2));
}
