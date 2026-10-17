import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  INSPECTOR_OFFSET,
  OWNER_EMAIL,
  writeLocalConfig,
  writeLocalSecrets,
} from "../../../worker/scripts/local-dev.mjs";

/*
 * E2E 用のローカルのスタック。web をビルドし、毎回新しい一時ディレクトリの D1 に migration を当てて
 * wrangler dev を起動する。開発用の .wrangler/state と apps/worker/.dev.vars には触れない。
 */

const run = promisify(execFile);

const WEB_DIR = resolve(import.meta.dirname, "../..");
export const WORKER_DIR = resolve(WEB_DIR, "../worker");

/**
 * 開発で使う 5173（vite）と 8787（wrangler dev）を避ける。別の worktree の E2E と同時に流すときは
 * E2E_PORT で変える。
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8790);
/**
 * wrangler dev の既定の 9229 は開発中の wrangler dev が使うので避ける。E2E_PORT を変えたときに
 * 重ならないよう、E2E_PORT からの差で決める（既定は 9339）。
 */
const INSPECTOR_PORT = E2E_PORT + INSPECTOR_OFFSET;
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;
export { OWNER_EMAIL };

export interface Stack {
  origin: string;
  sessionSecret: string;
  /** wrangler dev が使う設定と D1 の保存先。テストが D1 に直接行を足す（principals.ts）のに使う */
  configPath: string;
  persistDir: string;
  stop: () => Promise<void>;
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "localhost", port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

async function waitForHealthy(child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev が終了した（${child.exitCode}）\n${log()}`);
    }
    try {
      const res = await fetch(`${E2E_ORIGIN}/api/healthz`);
      if (res.ok) return;
    } catch {
      // 起動中
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`wrangler dev が 60 秒以内に応答しなかった\n${log()}`);
}

async function waitForPortsClosed(ports: number[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const open = [];
    for (const port of ports) if (await portInUse(port)) open.push(port);
    if (open.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`E2E のサーバーを止めたあともポート ${open.join(", ")} が使用中`);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** 準備の段階ごとの所要時間。テストの report に載らないので、遅くなったときにどこが伸びたかをここで見る。 */
export const setupTimings: { label: string; ms: number }[] = [];

export async function timed<T>(label: string, task: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await task();
  } finally {
    setupTimings.push({ label, ms: performance.now() - start });
  }
}

/** 一時ディレクトリに設定と秘密を書き、migration を当てて wrangler dev を起動する。 */
async function launch(
  dir: string,
  build: Promise<void>,
): Promise<{
  child: ChildProcess;
  sessionSecret: string;
  configPath: string;
  persistDir: string;
  log: () => string;
}> {
  const sessionSecret = randomBytes(32).toString("base64");
  const config = writeLocalConfig(dir);
  const envFile = writeLocalSecrets(dir, { sessionSecret, audience: "e2e-audience" });
  const persist = join(dir, "state");
  const wrangler = join(WORKER_DIR, "node_modules/.bin/wrangler");

  await timed("migration", () =>
    run(
      wrangler,
      ["d1", "migrations", "apply", "DB", "--local", "--persist-to", persist, "-c", config],
      // migration の確認の質問を出させない
      { cwd: dir, env: { ...process.env, CI: "1" } },
    ),
  );
  // wrangler dev は起動時に assets のディレクトリを読むので、build の出力がそろってから起動する
  await build;

  let output = "";
  const child = spawn(
    wrangler,
    [
      "dev",
      "-c",
      config,
      "--env-file",
      envFile,
      "--persist-to",
      persist,
      "--port",
      String(E2E_PORT),
      "--inspector-port",
      String(INSPECTOR_PORT),
      "--ip",
      "localhost",
      "--show-interactive-dev-session=false",
      "--log-level",
      "warn",
    ],
    {
      cwd: dir,
      // LOAD_DEV_VARS が false だと wrangler は --env-file も読まない。INCLUDE_PROCESS_ENV が
      // true だと手元の環境変数が Worker の env に入り、乱数の秘密の代わりにシェルの値が使われうる
      env: {
        ...process.env,
        CI: "1",
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "true",
        CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-20_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return { child, sessionSecret, configPath: config, persistDir: persist, log: () => output };
}

export async function startStack(): Promise<Stack> {
  if (await portInUse(E2E_PORT)) {
    throw new Error(`ポート ${E2E_PORT} が使用中。前の E2E のサーバーが残っていないか確かめる`);
  }
  // 繰り返し実行するときにビルドを省く（web のソースを変えていないときだけ使う）
  const build =
    process.env.E2E_SKIP_BUILD === "1"
      ? Promise.resolve()
      : timed("build", async () => {
          // Worker は SITE_NAME を持たず既定の名前を出すので、シェルに残った VITE_SITE_NAME を web に渡さない
          const { VITE_SITE_NAME: _, ...env } = process.env;
          await run("pnpm", ["exec", "vite", "build", "--logLevel", "warn"], { cwd: WEB_DIR, env });
        });
  // migration が先に失敗すると build は待たれないまま終わるので、未処理の reject にしない
  build.catch(() => {});

  const dir = mkdtempSync(join(tmpdir(), "personal-wiki-e2e-"));
  let launched: Awaited<ReturnType<typeof launch>>;
  try {
    launched = await launch(dir, build);
  } catch (error) {
    // secrets.env を含む一時ディレクトリを残さない
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const { child, sessionSecret, configPath, persistDir, log } = launched;

  // wrangler は workerd を子に持つので、プロセスグループ（detached で作った）ごと止める。
  // wrangler だけを止めると workerd が残り、8790 と 9339 を握ったままになることがある
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      // すでに終わっている
    }
  };
  // teardown を通らずに終わったとき（中断など）も残さない
  const killOnExit = () => signalGroup("SIGKILL");
  process.once("exit", killOnExit);

  const stop = async () => {
    process.off("exit", killOnExit);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((done) => child.once("exit", done));
      signalGroup("SIGTERM");
      const timer = setTimeout(() => signalGroup("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
    }
    // 子の workerd は wrangler より後に終わることがある
    signalGroup("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
    await waitForPortsClosed([E2E_PORT, INSPECTOR_PORT]);
  };

  try {
    await timed("起動", () => waitForHealthy(child, log));
  } catch (error) {
    await stop();
    throw error;
  }
  return { origin: E2E_ORIGIN, sessionSecret, configPath, persistDir, stop };
}
