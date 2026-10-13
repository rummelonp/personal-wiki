// コミットされた wrangler.jsonc と、デプロイ先ごとの値（deploy.env）から、デプロイ用の設定を合成する。
// 合成結果は apps/worker/wrangler.deploy.json に書く。`main` と `migrations_dir` は設定ファイルからの
// 相対パスなので、wrangler.jsonc と同じディレクトリに置かないと解決できなくなる。
// wrangler が設定ファイルに書き戻す値（自動プロビジョニングで得た ID など）も、追跡対象の
// wrangler.jsonc ではなくこの生成物に入る。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const WORKER_DIR = fileURLToPath(new URL("..", import.meta.url));
export const BASE_CONFIG_PATH = `${WORKER_DIR}wrangler.jsonc`;
export const DEPLOY_ENV_PATH = `${WORKER_DIR}deploy.env`;
export const GENERATED_CONFIG_PATH = `${WORKER_DIR}wrangler.deploy.json`;

// wrangler.jsonc の bindings の名前。値を差し替える対象をこの名前で探す。
const D1_BINDING = "DB";
const R2_BINDING = "BUCKET";

/**
 * @typedef {{
 *   hostname: string;
 *   d1DatabaseName: string;
 *   d1DatabaseId: string;
 *   r2BucketName: string;
 *   accountId: string | undefined;
 * }} DeployValues
 */

/**
 * 文字列リテラルの終わりの位置を返す。`start` は開きの引用符の位置。
 * @param {string} text
 * @param {number} start
 */
function stringEnd(text, start) {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  return i;
}

/**
 * JSONC のコメントと末尾カンマを取り除く。文字列リテラルの中の `//` などには触れない。
 * @param {string} text
 * @returns {string}
 */
export function stripJsonc(text) {
  let withoutComments = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      const end = stringEnd(text, i);
      withoutComments += text.slice(i, end + 1);
      i = end + 1;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      withoutComments += ch;
      i++;
    }
  }

  let out = "";
  i = 0;
  while (i < withoutComments.length) {
    const ch = withoutComments[i];
    if (ch === '"') {
      const end = stringEnd(withoutComments, i);
      out += withoutComments.slice(i, end + 1);
      i = end + 1;
    } else if (ch === "," && /^\s*[}\]]/.test(withoutComments.slice(i + 1))) {
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * deploy.env の内容から、デプロイ先ごとの値を取り出す。足りない必須の値はすべてまとめて報告する。
 * @param {string} envText
 * @returns {{ values: DeployValues } | { missing: string[] }}
 */
export function readDeployValues(envText) {
  const env = parseEnv(envText);
  /** @param {string} key */
  const get = (key) => {
    const value = env[key]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const hostname = get("WIKI_HOSTNAME");
  const d1DatabaseId = get("D1_DATABASE_ID");
  const missing = [];
  if (hostname === undefined) missing.push("WIKI_HOSTNAME");
  if (d1DatabaseId === undefined) missing.push("D1_DATABASE_ID");
  if (hostname === undefined || d1DatabaseId === undefined) return { missing };
  return {
    values: {
      hostname,
      d1DatabaseId,
      d1DatabaseName: get("D1_DATABASE_NAME") ?? "personal-wiki",
      r2BucketName: get("R2_BUCKET_NAME") ?? "personal-wiki",
      accountId: get("CLOUDFLARE_ACCOUNT_ID"),
    },
  };
}

/**
 * wrangler.jsonc を表すオブジェクトに、デプロイ先ごとの値を重ねる。入力は変更しない。
 * 差し替える箇所は binding の名前で探し、見つからなければ例外にする。
 * @param {Record<string, any>} base
 * @param {DeployValues} values
 * @returns {Record<string, any>}
 */
export function composeConfig(base, values) {
  /** @type {Record<string, any>} */
  const config = structuredClone(base);
  config.routes = [{ pattern: values.hostname, custom_domain: true }];
  const d1 = (config.d1_databases ?? []).find(
    (/** @type {{ binding: string }} */ b) => b.binding === D1_BINDING,
  );
  if (d1 === undefined)
    throw new Error(`wrangler.jsonc に D1 binding "${D1_BINDING}" がありません`);
  d1.database_name = values.d1DatabaseName;
  d1.database_id = values.d1DatabaseId;
  const r2 = (config.r2_buckets ?? []).find(
    (/** @type {{ binding: string }} */ b) => b.binding === R2_BINDING,
  );
  if (r2 === undefined)
    throw new Error(`wrangler.jsonc に R2 binding "${R2_BINDING}" がありません`);
  r2.bucket_name = values.r2BucketName;
  if (values.accountId !== undefined) config.account_id = values.accountId;
  return config;
}

/**
 * deploy.env を読んで設定を合成し、wrangler.deploy.json に書いてそのパスを返す。
 * 値が足りないときは、何が足りないかを説明する例外を投げる。
 * @returns {string}
 */
export function writeGeneratedConfig() {
  if (!existsSync(DEPLOY_ENV_PATH)) {
    throw new Error(
      "apps/worker/deploy.env がありません。deploy.env.example をコピーして値を書いてください",
    );
  }
  const result = readDeployValues(readFileSync(DEPLOY_ENV_PATH, "utf8"));
  if ("missing" in result) {
    throw new Error(`apps/worker/deploy.env に次の値がありません: ${result.missing.join(", ")}`);
  }
  const base = JSON.parse(stripJsonc(readFileSync(BASE_CONFIG_PATH, "utf8")));
  const config = composeConfig(base, result.values);
  writeFileSync(GENERATED_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  return GENERATED_CONFIG_PATH;
}
