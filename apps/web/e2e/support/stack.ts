import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { stripJsonc } from "../../../worker/scripts/deploy-config.mjs";

/*
 * E2E 用のローカルのスタック。web をビルドし、毎回新しい一時ディレクトリの D1 に migration を当てて
 * wrangler dev を起動する。開発用の .wrangler/state と apps/worker/.dev.vars には触れない。
 */

const run = promisify(execFile);

const WEB_DIR = resolve(import.meta.dirname, "../..");
const WORKER_DIR = resolve(WEB_DIR, "../worker");

/**
 * 開発で使う 5173（vite）と 8787（wrangler dev）を避ける。別の worktree の E2E と同時に流すときは
 * E2E_PORT で変える。
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8790);
/**
 * wrangler dev の既定の 9229 は開発中の wrangler dev が使うので避ける。E2E_PORT を変えたときに
 * 重ならないよう、E2E_PORT からの差で決める（既定は 9339）。
 */
const INSPECTOR_PORT = E2E_PORT + 549;
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;
export const OWNER_EMAIL = "owner@example.test";

export interface Stack {
  origin: string;
  sessionSecret: string;
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

/**
 * apps/worker/wrangler.jsonc を元に、一時ディレクトリに置く設定を作る。
 * wrangler は設定ファイルの隣の .dev.vars を読むので、設定ごと一時ディレクトリに移し、
 * 秘密は --env-file で渡す（--env-file があると .dev.vars は読まれない）。
 * routes はデプロイ先のホスト名なので外す。
 */
function writeConfig(dir: string): string {
  const base = JSON.parse(stripJsonc(readFileSync(join(WORKER_DIR, "wrangler.jsonc"), "utf8")));
  delete base.$schema;
  delete base.routes;
  delete base.workers_dev;
  delete base.preview_urls;
  base.main = join(WORKER_DIR, base.main);
  for (const db of base.d1_databases) db.migrations_dir = join(WORKER_DIR, db.migrations_dir);
  base.assets.directory = join(WORKER_DIR, base.assets.directory);
  const path = join(dir, "wrangler.json");
  writeFileSync(path, JSON.stringify(base, null, 2));
  return path;
}

function writeSecrets(dir: string, sessionSecret: string): string {
  // owner のログインの設定は 1 つでも欠けると owner の経路が閉じる（auth/owner-config.ts）。
  // Access の値は /_auth/login でしか使わず、E2E はログインを通さずに cookie を作るので、形だけ満たす
  const path = join(dir, "secrets.env");
  writeFileSync(
    path,
    [
      "ACCESS_TEAM_DOMAIN=access.example.test",
      "ACCESS_AUD=e2e-audience",
      `OWNER_EMAILS=${OWNER_EMAIL}`,
      `SESSION_SECRET=${sessionSecret}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return path;
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
): Promise<{ child: ChildProcess; sessionSecret: string; log: () => string }> {
  const sessionSecret = randomBytes(32).toString("base64");
  const config = writeConfig(dir);
  const envFile = writeSecrets(dir, sessionSecret);
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
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-20_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return { child, sessionSecret, log: () => output };
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
          await run("pnpm", ["exec", "vite", "build", "--logLevel", "warn"], { cwd: WEB_DIR });
        });
  // migration が先に失敗すると build は待たれないまま終わるので、未処理の reject にしない
  build.catch(() => {});

  const dir = mkdtempSync(join(tmpdir(), "personal-wiki-e2e-"));
  let launched: { child: ChildProcess; sessionSecret: string; log: () => string };
  try {
    launched = await launch(dir, build);
  } catch (error) {
    // secrets.env を含む一時ディレクトリを残さない
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const { child, sessionSecret, log } = launched;

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
  return { origin: E2E_ORIGIN, sessionSecret, stop };
}
