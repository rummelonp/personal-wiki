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
const OAUTH_KV_BINDING = "OAUTH_KV";

/**
 * @typedef {{
 *   hostname: string;
 *   d1DatabaseName: string;
 *   d1DatabaseId: string;
 *   r2BucketName: string | undefined;
 *   oauthKvNamespaceId: string | undefined;
 *   accountId: string | undefined;
 *   ownerAuth: OwnerAuthValues | undefined;
 * }} DeployValues
 */

/**
 * owner のログイン（Cloudflare Access）の設定。Worker の vars に入れる。
 * SESSION_SECRET は秘密なのでここに含めず、`wrangler secret put` で入れる。
 * @typedef {{ teamDomain: string; audience: string; ownerEmails: string }} OwnerAuthValues
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

const KNOWN_KEYS = new Set([
  "WIKI_HOSTNAME",
  "D1_DATABASE_ID",
  "D1_DATABASE_NAME",
  "R2_BUCKET_NAME",
  "OAUTH_KV_NAMESPACE_ID",
  "CLOUDFLARE_ACCOUNT_ID",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
  "OWNER_EMAILS",
]);
const OWNER_AUTH_KEYS = ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OWNER_EMAILS"];
const HOSTNAME_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KV_NAMESPACE_ID_PATTERN = /^[0-9a-f]{32}$/i;

/**
 * deploy.env の内容から、デプロイ先ごとの値を取り出す。
 * 必須の値の欠落と形式の誤りは、すべてまとめて problems で返す。
 * R2_BUCKET_NAME が空なら r2BucketName は undefined になり、R2 を使わない構成にする。
 * OAUTH_KV_NAMESPACE_ID が空なら oauthKvNamespaceId は undefined になり、OAuth を閉じた構成にして警告する。
 * owner のログインの 3 つの値は、すべて空なら ownerAuth を undefined にして警告する。一部だけなら
 * problems にする（ログインできないままデプロイしても気づきにくいため）。
 * @param {string} envText
 * @returns {{ values: DeployValues; warnings: string[] } | { problems: string[] }}
 */
export function readDeployValues(envText) {
  // エディタによっては先頭に BOM が付き、最初のキー名が一致しなくなる
  const env = parseEnv(envText.replace(/^\uFEFF/, ""));
  /** @param {string} key */
  const get = (key) => {
    const value = env[key]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const warnings = Object.keys(env)
    .filter((key) => !KNOWN_KEYS.has(key))
    .map((key) => `未知のキー ${key} は使われません`);
  const hostname = get("WIKI_HOSTNAME");
  const d1DatabaseId = get("D1_DATABASE_ID");
  const problems = [];
  if (hostname === undefined) problems.push("WIKI_HOSTNAME がありません");
  else if (!HOSTNAME_PATTERN.test(hostname)) {
    problems.push("WIKI_HOSTNAME はスキームやパスを含まないホスト名だけにしてください");
  }
  if (d1DatabaseId === undefined) problems.push("D1_DATABASE_ID がありません");
  else if (!UUID_PATTERN.test(d1DatabaseId)) {
    problems.push(
      "D1_DATABASE_ID は UUID 形式（wrangler d1 create が表示する database_id）にしてください",
    );
  }
  const oauthKvNamespaceId = get("OAUTH_KV_NAMESPACE_ID");
  if (oauthKvNamespaceId === undefined) {
    warnings.push(
      "OAUTH_KV_NAMESPACE_ID が無いので、OAuth（claude.ai などのカスタムコネクタからの MCP 接続）は使えません（Bearer トークンの MCP は使えます）",
    );
  } else if (!KV_NAMESPACE_ID_PATTERN.test(oauthKvNamespaceId)) {
    problems.push(
      "OAUTH_KV_NAMESPACE_ID は wrangler kv namespace create が表示する 32 桁の 16 進の id にしてください",
    );
  }
  const ownerAuth = readOwnerAuth(get, problems, warnings);
  if (oauthKvNamespaceId !== undefined && ownerAuth === undefined) {
    warnings.push(
      "OAUTH_KV_NAMESPACE_ID はありますが、owner のログインが無いので OAuth は使えません（同意画面に owner のログインが要ります）",
    );
  }
  if (problems.length > 0 || hostname === undefined || d1DatabaseId === undefined) {
    return { problems };
  }
  return {
    values: {
      hostname,
      d1DatabaseId,
      d1DatabaseName: get("D1_DATABASE_NAME") ?? "personal-wiki",
      r2BucketName: get("R2_BUCKET_NAME"),
      oauthKvNamespaceId,
      accountId: get("CLOUDFLARE_ACCOUNT_ID"),
      ownerAuth,
    },
    warnings,
  };
}

const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+$/;

/**
 * @param {(key: string) => string | undefined} get
 * @param {string[]} problems
 * @param {string[]} warnings
 * @returns {OwnerAuthValues | undefined}
 */
function readOwnerAuth(get, problems, warnings) {
  const present = OWNER_AUTH_KEYS.filter((key) => get(key) !== undefined);
  if (present.length === 0) {
    warnings.push(
      `${OWNER_AUTH_KEYS.join("、")} が無いので、owner のログインは使えません（token の API と MCP は使えます）`,
    );
    return undefined;
  }
  const missing = OWNER_AUTH_KEYS.filter((key) => get(key) === undefined);
  for (const key of missing) problems.push(`${key} がありません（owner のログインに要ります）`);
  const teamDomain = get("ACCESS_TEAM_DOMAIN");
  const audience = get("ACCESS_AUD");
  const emails = get("OWNER_EMAILS")
    ?.split(",")
    .map((email) => email.trim())
    .filter((email) => email !== "");
  if (teamDomain !== undefined && !HOSTNAME_PATTERN.test(teamDomain)) {
    problems.push(
      "ACCESS_TEAM_DOMAIN はスキームやパスを含まないホスト名（<team>.cloudflareaccess.com）にしてください",
    );
  }
  if (audience !== undefined && /\s/.test(audience)) {
    problems.push("ACCESS_AUD は Access のアプリケーションの AUD タグをそのまま書いてください");
  }
  if (
    emails !== undefined &&
    (emails.length === 0 || !emails.every((e) => EMAIL_PATTERN.test(e)))
  ) {
    problems.push("OWNER_EMAILS はメールアドレスをカンマで区切って書いてください");
  }
  if (teamDomain === undefined || audience === undefined || emails === undefined) return undefined;
  return { teamDomain, audience, ownerEmails: emails.join(",") };
}

/**
 * wrangler.jsonc を表すオブジェクトに、デプロイ先ごとの値を重ねる。入力は変更しない。
 * 差し替える箇所は binding の名前で探し、見つからなければ例外にする。
 * routes は元の内容を捨てて、ホスト名 1 件の custom_domain に置き換える。
 * r2BucketName が無いときは、R2 の binding を設定から外す。
 * oauthKvNamespaceId が無いときは、OAuth の KV の binding を設定から外す（Worker は OAuth を閉じる）。
 * ownerAuth があれば vars に入れる。無ければ vars に入れず、Worker はログインを拒む。
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
  const buckets = config.r2_buckets ?? [];
  if (values.r2BucketName === undefined) {
    const rest = buckets.filter((/** @type {{ binding: string }} */ b) => b.binding !== R2_BINDING);
    if (rest.length > 0) config.r2_buckets = rest;
    else delete config.r2_buckets;
  } else {
    const r2 = buckets.find((/** @type {{ binding: string }} */ b) => b.binding === R2_BINDING);
    if (r2 === undefined)
      throw new Error(`wrangler.jsonc に R2 binding "${R2_BINDING}" がありません`);
    r2.bucket_name = values.r2BucketName;
  }
  const namespaces = config.kv_namespaces ?? [];
  if (values.oauthKvNamespaceId === undefined) {
    const rest = namespaces.filter(
      (/** @type {{ binding: string }} */ b) => b.binding !== OAUTH_KV_BINDING,
    );
    if (rest.length > 0) config.kv_namespaces = rest;
    else delete config.kv_namespaces;
  } else {
    const kv = namespaces.find(
      (/** @type {{ binding: string }} */ b) => b.binding === OAUTH_KV_BINDING,
    );
    if (kv === undefined)
      throw new Error(`wrangler.jsonc に KV binding "${OAUTH_KV_BINDING}" がありません`);
    kv.id = values.oauthKvNamespaceId;
  }
  if (values.accountId !== undefined) config.account_id = values.accountId;
  if (values.ownerAuth !== undefined) {
    config.vars = {
      ...config.vars,
      ACCESS_TEAM_DOMAIN: values.ownerAuth.teamDomain,
      ACCESS_AUD: values.ownerAuth.audience,
      OWNER_EMAILS: values.ownerAuth.ownerEmails,
    };
  }
  return config;
}

/**
 * @typedef {{ envPath: string; basePath: string; outPath: string; warn: (message: string) => void }} GenerateOptions
 */

/**
 * deploy.env を読んで設定を合成し、wrangler.deploy.json に書いてそのパスを返す。
 * 値が足りない、または誤っているときは、その内容を説明する例外を投げる。
 * @param {Partial<GenerateOptions>} [options] テストで差し替える。生成物は basePath と同じディレクトリに置く
 * @returns {string}
 */
export function writeGeneratedConfig(options = {}) {
  const {
    envPath = DEPLOY_ENV_PATH,
    basePath = BASE_CONFIG_PATH,
    outPath = GENERATED_CONFIG_PATH,
    warn = (message) => process.stderr.write(`warning: ${message}\n`),
  } = options;
  if (!existsSync(envPath)) {
    throw new Error(`${envPath} がありません。deploy.env.example をコピーして値を書いてください`);
  }
  const result = readDeployValues(readFileSync(envPath, "utf8"));
  if ("problems" in result) {
    throw new Error(
      `${envPath} を直してください:\n${result.problems.map((p) => `- ${p}`).join("\n")}`,
    );
  }
  for (const message of result.warnings) warn(`${envPath}: ${message}`);
  let base;
  try {
    base = JSON.parse(stripJsonc(readFileSync(basePath, "utf8")));
  } catch (error) {
    throw new Error(`${basePath} を読めません: ${error instanceof Error ? error.message : error}`);
  }
  const config = composeConfig(base, result.values);
  writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`);
  return outPath;
}
