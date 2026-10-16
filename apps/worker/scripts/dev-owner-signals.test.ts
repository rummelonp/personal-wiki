import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { INSPECTOR_OFFSET } from "./local-dev.mjs";

/*
 * dev-owner を別の process で起動し、シグナルや起動の失敗の後に、秘密を置いた一時ディレクトリと
 * wrangler dev（偽物）とその子が残らないことを確かめる。TMPDIR をテストのディレクトリに向けるので、
 * 一時ディレクトリの有無はそこを見ればわかる。
 */

const SCRIPT = fileURLToPath(new URL("./dev-owner.mjs", import.meta.url));
const FAKE_WRANGLER = fileURLToPath(new URL("./fixtures/fake-wrangler.mjs", import.meta.url));

function portInUse(port: number): Promise<boolean> {
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
 * 開発、E2E、レーンの dev:owner の範囲を避け、proxy と上流と inspector の 3 つが空いている基準のポート。
 * 空きを確かめてから使うまでの間に、別の worktree で同時に走るテストと同じポートを取り合わないよう、
 * 探し始めを pid でずらす。
 */
async function freeBasePort(): Promise<number> {
  const slots = 100;
  const first = process.pid % slots;
  for (let i = 0; i < slots; i++) {
    const port = 18700 + ((first + i) % slots) * 10;
    const used = await Promise.all([port, port + 1, port + INSPECTOR_OFFSET].map(portInUse));
    if (!used.some(Boolean)) return port;
  }
  throw new Error("no free port for dev-owner tests");
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Run {
  child: ChildProcess;
  port: number;
  tmp: string;
  output: () => string;
  exited: Promise<number | null>;
  /** 偽の wrangler と、その子の pid。起動を待ってから読む。 */
  pids: () => number[];
}

const runs: Run[] = [];
afterEach(() => {
  for (const run of runs) {
    run.child.kill("SIGKILL");
    if (existsSync(join(run.tmp, "pids.json"))) {
      for (const pid of run.pids()) if (isAlive(pid)) process.kill(pid, "SIGKILL");
    }
    rmSync(run.tmp, { recursive: true, force: true });
  }
  runs.length = 0;
});

async function startDevOwner(env: Record<string, string> = {}): Promise<Run> {
  const port = await freeBasePort();
  const tmp = mkdtempSync(join(tmpdir(), "dev-owner-signals-"));
  const pidFile = join(tmp, "pids.json");
  let output = "";
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], {
    env: {
      ...process.env,
      TMPDIR: tmp,
      DEV_OWNER_WRANGLER: FAKE_WRANGLER,
      FAKE_WRANGLER_PID_FILE: pidFile,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  const run: Run = {
    child,
    port,
    tmp,
    output: () => output,
    exited,
    pids: () => JSON.parse(readFileSync(pidFile, "utf8")),
  };
  runs.push(run);
  return run;
}

function secretDirs(run: Run): string[] {
  return readdirSync(run.tmp).filter((name) => name.startsWith("personal-wiki-dev-owner-"));
}

async function expectNothingLeft(run: Run): Promise<void> {
  expect(secretDirs(run)).toEqual([]);
  await until(
    () => run.pids().every((pid) => !isAlive(pid)),
    "fake wrangler and its child to exit",
  );
  expect(await portInUse(run.port)).toBe(false);
  expect(await portInUse(run.port + 1)).toBe(false);
}

const ready = (run: Run) => until(() => run.output().includes("dev:owner: open"), "ready message");
const spawned = (run: Run) =>
  until(
    () => existsSync(join(run.tmp, "pids.json")) && secretDirs(run).length === 1,
    "fake wrangler to start",
  );

describe("dev-owner の後片付け", { timeout: 20_000 }, () => {
  it("起動した後の SIGHUP で wrangler dev を止め、一時ディレクトリを消して 0 で終える", async () => {
    // wrangler に --env-file を読ませない設定が環境にあっても、dev-owner が上書きして owner で入れる
    const run = await startDevOwner({ CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" });
    await ready(run);
    run.child.kill("SIGHUP");
    expect(await run.exited).toBe(0);
    await expectNothingLeft(run);
  });

  it("起動を待つ間の SIGINT でも残さない", async () => {
    const run = await startDevOwner({ FAKE_WRANGLER_NEVER_READY: "1" });
    await spawned(run);
    run.child.kill("SIGINT");
    expect(await run.exited).toBe(0);
    await expectNothingLeft(run);
  });

  it("SIGTERM で終わらない wrangler dev も、2 回目の SIGINT で猶予を待たずに止める", async () => {
    const run = await startDevOwner({ FAKE_WRANGLER_IGNORE_SIGTERM: "1" });
    await ready(run);
    const start = Date.now();
    run.child.kill("SIGINT");
    await new Promise((done) => setTimeout(done, 200));
    run.child.kill("SIGINT");
    expect(await run.exited).toBe(130);
    // 1 回目の SIGKILL までの猶予（5 秒）より早く終わる
    expect(Date.now() - start).toBeLessThan(4000);
    await expectNothingLeft(run);
  });

  it("proxy を通した /api/me が owner でなければ、起動を失敗にして残さない", async () => {
    const run = await startDevOwner({ FAKE_WRANGLER_SKIP_ENV_FILE: "1" });
    expect(await run.exited).toBe(1);
    expect(run.output()).toContain("self-check failed");
    expect(run.output()).not.toContain("dev:owner: open");
    await expectNothingLeft(run);
  });
});
