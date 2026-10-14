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

/** 開発で使う 5173（vite）と 8787（wrangler dev）を避ける。 */
export const E2E_PORT = 8790;
/** wrangler dev の既定の 9229 は開発中の wrangler dev が使うので、別の値に固定する。 */
const INSPECTOR_PORT = 9339;
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

export async function startStack(): Promise<Stack> {
  if (await portInUse(E2E_PORT)) {
    throw new Error(`ポート ${E2E_PORT} が使用中。前の E2E のサーバーが残っていないか確かめる`);
  }
  // 繰り返し実行するときにビルドを省く（web のソースを変えていないときだけ使う）
  if (process.env.E2E_SKIP_BUILD !== "1") {
    await run("pnpm", ["exec", "vite", "build", "--logLevel", "warn"], { cwd: WEB_DIR });
  }

  const dir = mkdtempSync(join(tmpdir(), "personal-wiki-e2e-"));
  const sessionSecret = randomBytes(32).toString("base64");
  const config = writeConfig(dir);
  const envFile = writeSecrets(dir, sessionSecret);
  const persist = join(dir, "state");
  const wrangler = join(WORKER_DIR, "node_modules/.bin/wrangler");

  await run(
    wrangler,
    ["d1", "migrations", "apply", "DB", "--local", "--persist-to", persist, "-c", config],
    // migration の確認の質問を出させない
    { cwd: dir, env: { ...process.env, CI: "1" } },
  );

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
    { cwd: dir, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-20_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const stop = async () => {
    if (child.exitCode === null) {
      const exited = new Promise((done) => child.once("exit", done));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
    }
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    await waitForHealthy(child, () => output);
  } catch (error) {
    await stop();
    throw error;
  }
  return { origin: E2E_ORIGIN, sessionSecret, stop };
}
