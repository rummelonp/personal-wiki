// デプロイ先の Cloudflare アカウントに対する操作を、deploy.env の値で合成した設定を使って実行する。
//   node scripts/deploy.mjs deploy [wrangler deploy の引数]（先に apps/web をビルドする）
//   node scripts/deploy.mjs migrate [wrangler d1 migrations apply の引数]
// 追跡対象の wrangler.jsonc にはデプロイ先の値が無く、wrangler の自動プロビジョニングが書き戻す先も
// 生成した設定になるので、追跡ファイルは変わらない。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
     R2 は添付で使う。ダッシュボードで R2 を有効にしてから作る（有効化前は省略してよい）
       pnpm exec wrangler r2 bucket create personal-wiki --update-config=false
     claude.ai や Claude Desktop のカスタムコネクタ、Claude Code や Codex などのコーディングエージェント（OAuth）から
     MCP に接続するときだけ、KV を作る
       pnpm exec wrangler kv namespace create personal-wiki-oauth --update-config=false
  3. cp deploy.env.example deploy.env を実行し、ホスト名と database_id を書く
       R2 を作ったときだけ R2_BUCKET_NAME を書く。空のままなら R2 の binding を付けずにデプロイする
       KV を作ったときだけ OAUTH_KV_NAMESPACE_ID に表示された id を書く。空のままなら OAuth は閉じる
       ホスト名の DNS ゾーンが、ログインしたアカウントにあること（custom_domain の前提）
       サイト名を変えるときだけ SITE_NAME に書く。空のままなら personal-wiki
       /llms.txt にサイトの説明文を出すときだけ SITE_DESCRIPTION に書く
       MCP 経由の rename で積んだリンクの書き換えを自動で進めるときだけ、LINK_REWRITE_CRON に cron 式を書く
         空のままなら Cron は付けない。アカウント全体で Cron Trigger は 5 本までなので、既定は空にしてある
         推奨は * * * * * か */5 * * * *。1 回の発火で 1 リンク元を進め、積んだ分が無ければ D1 の読み取りは数行で済む
         空に戻してデプロイすると、デプロイ済みの Cron も外れる
  4. owner のログイン（ブラウザからの閲覧、編集）を使うときだけ:
       Cloudflare Zero Trust で /_auth/login だけを対象にした Access のアプリケーションを作り、
       deploy.env に ACCESS_TEAM_DOMAIN、ACCESS_AUD、OWNER_EMAILS を書く
       Access のポリシーでも owner のメールアドレスだけを許可し、ログイン方法にはメールアドレスを
       検証する IdP（One-time PIN など）を使う（Worker は JWT の email を信じて owner にする）
       手順 6 の後で、セッション cookie の署名鍵（32 文字以上）を secret で入れる（deploy.env には書かない）
         openssl rand -base64 32 | pnpm exec wrangler secret put SESSION_SECRET --config wrangler.deploy.json
  5. pnpm db:migrate:remote
  6. pnpm deploy:remote
  7. pnpm -s api-token issue <name> --scopes read,write --remote
       標準出力のトークンを控える
  8. MCP 接続（API token で接続する場合）
       claude mcp add --transport http personal-wiki https://<ホスト名>/mcp \\
         --header "Authorization: Bearer <トークン>"
  9. claude.ai や Claude Desktop のカスタムコネクタ、Claude Code や Codex などのコーディングエージェント
     （手順 2 の KV と手順 4 の owner のログインが要る）:
       コネクタかエージェントの MCP の URL に https://<ホスト名>/mcp を入れて接続する。ブラウザで同意画面が開くので、
       「接続するアプリ」の名前と「トークンの送り先」を確かめ、「読み取り」か「読み書き」を選んで許可する
       （ログインしていなければ /_auth/login を経由してから同意画面に戻る）
       client の登録は、redirect URI が claude.ai の戻り先か deploy.env の OAUTH_REDIRECT_URIS に
       あるものだけを受け付け、1 日（UTC）に 20 件までにする。上限に達した日は新しい接続だけが止まる
       コーディングエージェントの callback は OAUTH_REDIRECT_URIS に足す
       （足し方は docs/deploy.md の「コーディングエージェントから接続する」にある）
       許可した接続は https://<ホスト名>/_auth/oauth/grants で見て、取り消せる（取り消すとその接続の
       トークンはすぐに使えなくなる）。同意画面と一覧に出る client_id が同じアプリを許可し直すと、
       以前の許可とトークンは自動で取り消される。client_id が変わると以前の許可は残るので、一覧から取り消す

更新のとき（migration を含む版をデプロイするとき）は、次の順に実行する:
  pnpm db:migrate:remote
  pnpm deploy:remote
  read -rs WIKI_TOKEN && export WIKI_TOKEN
  pnpm derived:rebuild --remote
  デプロイが migration より先だと、保存と一覧が表の無いエラーで止まる。
  derived:rebuild は全ページの派生データ（links、tags、一覧の抜粋、検索の索引）を作り直す。
  write の token は環境変数 WIKI_TOKEN から読む。
  Worker を前の版に戻して再デプロイしたあとも実行する。前の版は新しい派生データ（抜粋など）を
  書かないので、戻している間に保存したページの分が古いまま残る

ここでの deploy は wrangler の自動プロビジョニングを無効にする（--x-provision=false）。
D1、R2、KV は手順 2 で作ったものだけを使う。

owner のセッションを切るとき:
  - SESSION_SECRET を入れ替えると、発行済みのセッション cookie はすべてすぐに無効になる。
    cookie や秘密が漏れたときはこれを行う（手順 4 と同じコマンドで新しい値を入れる）
  - wiki のログアウトは wiki の cookie だけを消す。Access のセッションは
    https://<ホスト名>/cdn-cgi/access/logout を開くと切れる`;

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

/**
 * 合成した設定の vars からサイト名を読む。web のビルドに渡す値を deploy.env の読み直しでなく
 * 生成した設定から取るのは、Worker に入る値と同じものにするため。
 * @param {string} configPath
 * @returns {string | undefined}
 */
export function generatedSiteName(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  return config.vars?.SITE_NAME;
}

/**
 * 合成した設定の routes からホスト名を読む。deploy.env の読み直しでなく生成した設定から取るのは、
 * Worker のデプロイ先と同じ値にするため。
 * @param {string} configPath
 * @returns {string}
 */
export function generatedHostname(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const hostname = config.routes?.[0]?.pattern;
  if (typeof hostname !== "string")
    throw new Error(`${configPath} に routes のホスト名がありません`);
  return hostname;
}

/** Worker の sitemap.xml のパス（src/sitemap-xml.ts の SITEMAP_XML_PATH）。 */
export const SITEMAP_PATH = "/sitemap.xml";

/**
 * robots.txt の末尾に `Sitemap:` の行を足した本文。`Sitemap:` は RFC 9309 でグループを終わらせず、
 * どの User-agent にも属さないが、読み手が直前のグループの行と取り違えないよう空行を挟む。
 * Google の robots.txt の説明と同じく、URL はスキームとホストを含む絶対 URL にする。
 * @param {string} text
 * @param {string} hostname
 */
export function robotsTxtWithSitemap(text, hostname) {
  const body = text.replace(/\n*$/, "\n");
  return `${body}\nSitemap: https://${hostname}${SITEMAP_PATH}\n`;
}

/**
 * ビルドした web の robots.txt に `Sitemap:` の行を足す。行に要るホスト名を repo の
 * apps/web/public/robots.txt には書けないので、デプロイのときだけ dist に足す。
 * @param {string} hostname
 */
function addSitemapToRobotsTxt(hostname) {
  const path = fileURLToPath(new URL("../../web/dist/robots.txt", import.meta.url));
  writeFileSync(path, robotsTxtWithSitemap(readFileSync(path, "utf8"), hostname));
}

/**
 * web のビルドに渡す環境変数。シェルに残っている VITE_SITE_NAME を拾って、Worker に入れる値と
 * 食い違わないよう、siteName が無いときは取り除く。
 * @param {NodeJS.ProcessEnv} base
 * @param {string | undefined} siteName
 * @returns {NodeJS.ProcessEnv}
 */
export function webBuildEnv(base, siteName) {
  const { VITE_SITE_NAME: _, ...rest } = base;
  return siteName === undefined ? rest : { ...rest, VITE_SITE_NAME: siteName };
}

/**
 * wrangler.jsonc の assets.directory（apps/web/dist）を作る。古いビルドのままデプロイしないため毎回作る。
 * @param {string | undefined} siteName
 */
function buildWeb(siteName) {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync("pnpm", ["--filter", "@personal-wiki/web", "build"], {
    cwd,
    stdio: "inherit",
    env: webBuildEnv(process.env, siteName),
  });
  return result.status ?? 1;
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
  if (command === "migrate") return runWrangler(migrateArgs(configPath, extra));
  const built = buildWeb(generatedSiteName(configPath));
  if (built !== 0) return built;
  addSitemapToRobotsTxt(generatedHostname(configPath));
  return runWrangler(deployArgs(configPath, extra));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
