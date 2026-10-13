// デプロイ先の Cloudflare アカウントに対する操作を、deploy.env の値で合成した設定を使って実行する。
//   node scripts/deploy.mjs deploy [wrangler deploy の引数]
//   node scripts/deploy.mjs migrate [wrangler d1 migrations apply の引数]
// 追跡対象の wrangler.jsonc にはデプロイ先の値が無く、wrangler の自動プロビジョニングが書き戻す先も
// 生成した設定になるので、追跡ファイルは変わらない。
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeGeneratedConfig } from "./deploy-config.mjs";

export const HELP = `usage:
  pnpm deploy:remote [-- <wrangler deploy の引数>]
  pnpm db:migrate:remote [-- <wrangler d1 migrations apply の引数>]
  node scripts/deploy.mjs config      合成した設定を wrangler.deploy.json に書くだけで終わる

初回のセットアップ（apps/worker で実行する）:
  1. pnpm exec wrangler login
  2. D1 を作る。表示された database_id を次の手順で使う
       --update-config=false を付けないと、wrangler が追跡対象の wrangler.jsonc に binding を書き込む
       pnpm exec wrangler d1 create personal-wiki --update-config=false
     R2 は添付とバックアップで使う。ダッシュボードで R2 を有効にしてから作る（有効化前は省略してよい）
       pnpm exec wrangler r2 bucket create personal-wiki --update-config=false
  3. cp deploy.env.example deploy.env を実行し、ホスト名と database_id を書く
       R2 を作ったときだけ R2_BUCKET_NAME を書く。空のままなら R2 の binding を付けずにデプロイする
       ホスト名の DNS ゾーンが、ログインしたアカウントにあること（custom_domain の前提）
  4. pnpm db:migrate:remote
  5. pnpm deploy:remote
  6. pnpm -s api-token issue <name> --scopes read,write --remote
       標準出力のトークンを控える
  7. MCP 接続（MCP エンドポイントの実装後。パスは実装に合わせる）
       claude mcp add --transport http personal-wiki https://<ホスト名>/mcp \\
         --header "Authorization: Bearer <トークン>"

ここでの deploy は wrangler の自動プロビジョニングを無効にする（--x-provision=false）。
D1 と R2 は手順 2 で作ったものだけを使う。`;

/**
 * wrangler deploy の引数。deploy.env に ID があるので、リソースの自動作成は止める。
 * @param {string} configPath
 * @param {string[]} extra
 */
export function deployArgs(configPath, extra) {
  return ["deploy", "--config", configPath, "--x-provision=false", ...extra];
}

/**
 * @param {string} configPath
 * @param {string[]} extra
 */
export function migrateArgs(configPath, extra) {
  return ["d1", "migrations", "apply", "DB", "--remote", "--config", configPath, ...extra];
}

/** @param {string[]} args */
function runWrangler(args) {
  const require = createRequire(import.meta.url);
  const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync(process.execPath, [wranglerBin, ...args], { cwd, stdio: "inherit" });
  return result.status ?? 1;
}

/**
 * pnpm は `--` をそのまま渡してくるので、wrangler には渡さない。
 * @param {string[]} rest
 */
export function extraArgs(rest) {
  return rest[0] === "--" ? rest.slice(1) : rest;
}

/** @param {string[]} argv */
function main(argv) {
  const [command, ...rest] = argv;
  const extra = extraArgs(rest);
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command !== "deploy" && command !== "migrate" && command !== "config") {
    process.stderr.write(`unknown command: ${command}\n${HELP}\n`);
    return 1;
  }
  const configPath = writeGeneratedConfig();
  if (command === "config") {
    process.stdout.write(`${configPath}\n`);
    return 0;
  }
  return runWrangler(
    command === "deploy" ? deployArgs(configPath, extra) : migrateArgs(configPath, extra),
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
