#!/usr/bin/env node
// dev-owner のテストで wrangler dev の代わりに起動する。受ける引数は dev-owner が渡すものだけ。
// workerd を子に持つ wrangler を真似て子を 1 つ起動し、自分と子の pid を FAKE_WRANGLER_PID_FILE に書く。
// 振る舞いは環境変数で変える:
// - FAKE_WRANGLER_NEVER_READY=1: /api/healthz が 503 のまま
// - FAKE_WRANGLER_IGNORE_SIGTERM=1: SIGTERM で終わらない
// - FAKE_WRANGLER_SKIP_ENV_FILE=1: --env-file を読まず、owner の経路が閉じる
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { OWNER_EMAIL } from "../local-dev.mjs";
import { mintSessionValue, SESSION_COOKIE_NAME } from "../session-cookie.mjs";

const args = process.argv.slice(2);
/** @param {string} name */
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

// wrangler と同じく、CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false なら --env-file を読まない
/** @type {string | undefined} */
let secret;
const envFile = option("--env-file");
if (
  envFile !== undefined &&
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV !== "false" &&
  process.env.FAKE_WRANGLER_SKIP_ENV_FILE !== "1"
) {
  const line = readFileSync(envFile, "utf8")
    .split("\n")
    .find((l) => l.startsWith("SESSION_SECRET="));
  secret = line?.slice("SESSION_SECRET=".length);
}

/** @param {string | undefined} cookie */
function isOwner(cookie) {
  if (secret === undefined) return false;
  const value = (cookie ?? "")
    .split("; ")
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.slice(SESSION_COOKIE_NAME.length + 1);
  if (value === undefined) return false;
  const { exp } = JSON.parse(Buffer.from(value.split(".")[0] ?? "", "base64url").toString());
  return value === mintSessionValue(secret, OWNER_EMAIL, exp);
}

if (process.env.FAKE_WRANGLER_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => {});

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
const pidFile = process.env.FAKE_WRANGLER_PID_FILE;
if (pidFile !== undefined) {
  writeFileSync(pidFile, JSON.stringify([process.pid, grandchild.pid]));
}

http
  .createServer((req, res) => {
    if (req.url === "/api/healthz") {
      res.writeHead(process.env.FAKE_WRANGLER_NEVER_READY === "1" ? 503 : 200);
      res.end();
      return;
    }
    if (req.url === "/api/me") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ kind: isOwner(req.headers.cookie) ? "owner" : "anonymous" }));
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(Number(option("--port")), "127.0.0.1");
