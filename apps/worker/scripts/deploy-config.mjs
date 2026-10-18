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
 *   siteName: string | undefined;
 *   d1DatabaseName: string;
 *   d1DatabaseId: string;
 *   r2BucketName: string | undefined;
 *   oauthKvNamespaceId: string | undefined;
 *   oauthRedirectUris: string | undefined;
 *   linkRewriteCron: string | undefined;
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
  "SITE_NAME",
  "D1_DATABASE_ID",
  "D1_DATABASE_NAME",
  "R2_BUCKET_NAME",
  "OAUTH_KV_NAMESPACE_ID",
  "OAUTH_REDIRECT_URIS",
  "LINK_REWRITE_CRON",
  "CLOUDFLARE_ACCOUNT_ID",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
  "OWNER_EMAILS",
]);
const OWNER_AUTH_KEYS = ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OWNER_EMAILS"];
const SITE_NAME_MAX_CHARS = 40;
const SITE_NAME_FORBIDDEN_PATTERN = /[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200c\u200d])\p{Cf}/u;
const SITE_NAME_VISIBLE_PATTERN = /[^\s\u200c\u200d]/u;

/**
 * packages/domain/src/site-name.ts の isValidSiteName と同じ規則。この script は node でそのまま動かす
 * ので TypeScript の domain を読めず、写している（食い違わないことは deploy-config.test.ts が確かめる）。
 * @param {string} name
 */
export function isValidSiteNameText(name) {
  return (
    SITE_NAME_VISIBLE_PATTERN.test(name) &&
    [...name].length <= SITE_NAME_MAX_CHARS &&
    !SITE_NAME_FORBIDDEN_PATTERN.test(name)
  );
}
const SITE_NAME_LINE_PATTERN = /^\s*(?:export\s+)?SITE_NAME\s*=(.*)$/;
const HOSTNAME_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KV_NAMESPACE_ID_PATTERN = /^[0-9a-f]{32}$/i;

/**
 * 引用符で囲まない値の `#` は、node の parseEnv が行末のコメントとして切り捨てる（`My #1 wiki` は
 * `My`、`C#` は `C`）。切れた値は parseEnv の結果から区別できないので、元の行で見つける。
 * 値が `#` で始まるときは、値が空で後ろがコメントなので含めない。
 * @param {string} envText
 */
function siteNameHasUnquotedHash(envText) {
  for (const line of envText.split(/\r?\n/)) {
    const raw = SITE_NAME_LINE_PATTERN.exec(line)?.[1]?.trim();
    if (raw === undefined || /^["'`]/.test(raw)) continue;
    if (raw.indexOf("#") > 0) return true;
  }
  return false;
}

/**
 * deploy.env の内容から、デプロイ先ごとの値を取り出す。
 * 必須の値の欠落と形式の誤りは、すべてまとめて problems で返す。
 * SITE_NAME が空なら siteName は undefined になり、web と Worker は既定の名前を使う。長さと使える文字の
 * 規則に反する名前と、引用符で囲まずに # を含む名前（# 以降が黙って切れる）は problems にする。
 * R2_BUCKET_NAME が空なら r2BucketName は undefined になり、R2 を使わない構成にする。
 * OAUTH_KV_NAMESPACE_ID が空なら oauthKvNamespaceId は undefined になり、OAuth を閉じた構成にして警告する。
 * OAUTH_REDIRECT_URIS は、Worker が client の登録で完全一致で比べるので、正規化した形でなければ弾く。
 * LINK_REWRITE_CRON が空なら linkRewriteCron は undefined になり、Cron を使わない構成にする。
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
  const siteName = get("SITE_NAME");
  const problems = [];
  if (siteName !== undefined) {
    // 改行や制御文字は、HTML の title、MCP の表示名、OAuth の画面に混ざると壊れやすい
    if (!isValidSiteNameText(siteName)) {
      problems.push(
        `SITE_NAME は制御文字（改行を含む）、U+2028 と U+2029、書式文字（文字の向きを変える文字やゼロ幅空白など。U+200C と U+200D は除く）を含まず、U+200C と U+200D と空白だけにもならない ${SITE_NAME_MAX_CHARS} 文字以内にしてください`,
      );
    }
  }
  if (siteNameHasUnquotedHash(envText)) {
    problems.push(
      'SITE_NAME に # を含めるときは、値全体を "" で囲んでください（囲まないと、# 以降が行末のコメントとして読み捨てられます）',
    );
  }
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
      "OAUTH_KV_NAMESPACE_ID が無いので、OAuth（claude.ai や Claude Desktop のカスタムコネクタ、Claude Code や Codex などのコーディングエージェントからの MCP 接続）は使えません（Bearer トークンの MCP は使えます）",
    );
  } else if (!KV_NAMESPACE_ID_PATTERN.test(oauthKvNamespaceId)) {
    problems.push(
      "OAUTH_KV_NAMESPACE_ID は wrangler kv namespace create が表示する 32 桁の 16 進の id にしてください",
    );
  }
  const oauthRedirectUris = readOAuthRedirectUris(get("OAUTH_REDIRECT_URIS"), problems);
  const linkRewriteCron = readLinkRewriteCron(get("LINK_REWRITE_CRON"), problems);
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
      siteName,
      d1DatabaseId,
      d1DatabaseName: get("D1_DATABASE_NAME") ?? "personal-wiki",
      r2BucketName: get("R2_BUCKET_NAME"),
      oauthKvNamespaceId,
      oauthRedirectUris,
      linkRewriteCron,
      accountId: get("CLOUDFLARE_ACCOUNT_ID"),
      ownerAuth,
    },
    warnings,
  };
}

/**
 * https か、ループバックの http だけを許す（ライブラリが登録で受け付ける範囲に合わせる）。
 * @param {string | undefined} value
 * @param {string[]} problems
 * @returns {string | undefined} カンマ区切りに並べ直した値
 */
function readOAuthRedirectUris(value, problems) {
  if (value === undefined) return undefined;
  const uris = value
    .split(",")
    .map((uri) => uri.trim())
    .filter((uri) => uri !== "");
  for (const uri of uris) {
    if (!isRedirectUri(uri)) {
      problems.push(
        `OAUTH_REDIRECT_URIS の ${uri} は、https（またはループバックの http）の、正規化した URL にしてください`,
      );
    }
  }
  return uris.length === 0 ? undefined : uris.join(",");
}

// 分 時 日 月 曜日。Cloudflare が受ける範囲（名前、L、W、#）の厳密な検査は wrangler と API に任せ、
// フィールド数の誤りと、複数の式や余計な文字をここで弾く
const CRON_FIELD_PATTERN = /^[0-9A-Za-z*/,\-?#]+$/;

/**
 * @param {string | undefined} value
 * @param {string[]} problems
 * @returns {string | undefined} フィールドの間を空白 1 つに揃えた値
 */
function readLinkRewriteCron(value, problems) {
  if (value === undefined) return undefined;
  const fields = value.split(/\s+/);
  if (fields.length !== 5 || !fields.every((field) => CRON_FIELD_PATTERN.test(field))) {
    problems.push(
      "LINK_REWRITE_CRON は cron 式 1 つ（分 時 日 月 曜日の 5 フィールド。例 */5 * * * *）にしてください",
    );
    return undefined;
  }
  return fields.join(" ");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** @param {string} uri */
function isRedirectUri(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  return secure && url.hash === "" && url.username === "" && url.href === uri;
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
 * siteName があれば vars の SITE_NAME に入れる。web には Worker の vars では届かないので、
 * deploy.mjs が生成した設定から読んでビルドに渡す。
 * ownerAuth があれば vars に入れる。無ければ vars に入れず、Worker はログインを拒む。
 * oauthRedirectUris があれば vars の OAUTH_REDIRECT_URIS に入れる。
 * linkRewriteCron は triggers.crons に入れる。無いときも空の配列を入れる。wrangler は crons が
 * 未定義だとデプロイ済みの schedule に触れないので、deploy.env から消しても Cron が止まらなくなる。
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
  if (values.siteName !== undefined) {
    config.vars = { ...config.vars, SITE_NAME: values.siteName };
  }
  if (values.ownerAuth !== undefined) {
    config.vars = {
      ...config.vars,
      ACCESS_TEAM_DOMAIN: values.ownerAuth.teamDomain,
      ACCESS_AUD: values.ownerAuth.audience,
      OWNER_EMAILS: values.ownerAuth.ownerEmails,
    };
  }
  if (values.oauthRedirectUris !== undefined) {
    config.vars = { ...config.vars, OAUTH_REDIRECT_URIS: values.oauthRedirectUris };
  }
  config.triggers = {
    ...config.triggers,
    crons: values.linkRewriteCron === undefined ? [] : [values.linkRewriteCron],
  };
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
