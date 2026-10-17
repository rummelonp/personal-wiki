// ローカル専用: wrangler dev を owner のログインつきで起動するための設定と秘密を、一時ディレクトリに
// 書く。dev:owner と E2E（apps/web/e2e/support/stack.ts）が使う。
// wrangler は設定ファイルの隣の .dev.vars を読むので、設定ごと一時ディレクトリに移し、秘密は
// --env-file で渡す（--env-file があると .dev.vars は読まれない）。手元の .dev.vars の値で
// 結果が変わらず、乱数の SESSION_SECRET 以外の秘密に触れない。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripJsonc } from "./deploy-config.mjs";

const WORKER_DIR = fileURLToPath(new URL("..", import.meta.url));

export const OWNER_EMAIL = "owner@example.test";

/**
 * inspector のポートの、wrangler dev を受けるポートからの差。dev:owner と E2E で同じ差にして、
 * どちらのポートを変えても互いの inspector と開発の 9229 に重ならないようにする。
 */
export const INSPECTOR_OFFSET = 549;

/**
 * wrangler dev に渡す環境変数。base（既定はこの process の環境）に、--env-file の読み込みと
 * 手元の環境変数の扱いを固定する 2 つを重ねる。
 * LOAD_DEV_VARS が false だと wrangler は --env-file も読まない。INCLUDE_PROCESS_ENV が true だと
 * 手元の環境変数が Worker の env に入り、乱数の秘密の代わりにシェルの値が使われうる。
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function localWranglerEnv(base = process.env) {
  return {
    ...base,
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "true",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
  };
}

/**
 * binding の設定に remote があるか。あると wrangler dev はその binding だけ Cloudflare 上の本物の
 * 資源につなぐので、ローカル専用の秘密で owner になった画面から本番のデータを書き換えうる。
 * binding は配列の要素（d1_databases など）か、単独のオブジェクト（ai など）として置かれる。
 * @param {Record<string, unknown>} config
 * @returns {string[]} remote を持つ binding の置き場所
 */
function remoteBindings(config) {
  /** @type {string[]} */
  const found = [];
  /** @param {unknown} value */
  const isRemote = (value) =>
    typeof value === "object" &&
    value !== null &&
    "remote" in value &&
    /** @type {{ remote: unknown }} */ (value).remote !== false;
  for (const [key, value] of Object.entries(config)) {
    // vars のキーは利用者が付ける変数名で、remote という名前の変数を binding と取り違えない
    if (key === "vars") continue;
    if (Array.isArray(value)) {
      value.forEach((element, index) => {
        if (isRemote(element)) found.push(`${key}[${index}]`);
      });
    } else if (isRemote(value)) {
      found.push(key);
    }
  }
  return found;
}

/**
 * wrangler.jsonc の内容を、一時ディレクトリから読める設定に直す。
 * routes などデプロイ先のホスト名に関わる値は外し、相対パスは apps/worker からの絶対パスにする。
 * @param {Record<string, any>} base
 * @returns {Record<string, any>}
 */
export function toLocalConfig(base) {
  const remote = remoteBindings(base);
  if (remote.length > 0) {
    throw new Error(
      `wrangler.jsonc has bindings with "remote" (${remote.join(", ")}); local runs must not reach Cloudflare resources`,
    );
  }
  const config = structuredClone(base);
  delete config.$schema;
  delete config.routes;
  delete config.workers_dev;
  delete config.preview_urls;
  config.main = join(WORKER_DIR, config.main);
  for (const db of config.d1_databases) db.migrations_dir = join(WORKER_DIR, db.migrations_dir);
  config.assets.directory = join(WORKER_DIR, config.assets.directory);
  return config;
}

/**
 * apps/worker/wrangler.jsonc を元にした設定を dir に書き、そのパスを返す。
 * @param {string} dir
 * @returns {string}
 */
export function writeLocalConfig(dir) {
  const base = JSON.parse(stripJsonc(readFileSync(join(WORKER_DIR, "wrangler.jsonc"), "utf8")));
  const path = join(dir, "wrangler.json");
  writeFileSync(path, JSON.stringify(toLocalConfig(base), null, 2));
  return path;
}

/**
 * owner のログインの設定は 1 つでも欠けると owner の経路が閉じる（src/auth/owner-config.ts）。
 * Access の値は /_auth/login でしか使わず、ローカルではログインを通さずに cookie を作るので、
 * 形だけ満たす。
 * @param {string} dir
 * @param {{ sessionSecret: string; audience: string }} options
 * @returns {string}
 */
export function writeLocalSecrets(dir, { sessionSecret, audience }) {
  const path = join(dir, "secrets.env");
  writeFileSync(
    path,
    [
      "ACCESS_TEAM_DOMAIN=access.example.test",
      `ACCESS_AUD=${audience}`,
      `OWNER_EMAILS=${OWNER_EMAIL}`,
      `SESSION_SECRET=${sessionSecret}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return path;
}
