import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../env";
import { allowAnonymous, requireOwner } from "./middleware";
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  isOAuthEnabled,
  mcpResourceOf,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_SCOPES,
  OAUTH_TOKEN_PATH,
  OAUTH_USER_ID,
  oauthServerFor,
  PROTECTED_RESOURCE_METADATA_PATH,
} from "./oauth-server";
import type { Scope } from "./principal";

/**
 * OAuth の認可サーバーのルートを登録する。OAuth を閉じた環境（isOAuthEnabled）ではどれも 404 にする。
 * - メタデータ 2 つ、トークン、client の登録は匿名に開く（クライアントは wiki の資格情報を持たない）。
 *   トークンと登録の Authorization は resolvePrincipal が読まずにライブラリへ渡す
 * - 認可（同意画面）は owner のセッションを要る。無ければ /_auth/login を経由して戻す。Access の対象は
 *   /_auth/login のままで、/_auth/oauth/* は Access を通さない
 */
export function registerOAuthRoutes(app: Hono<AppEnv>) {
  return app
    .get(AUTHORIZATION_SERVER_METADATA_PATH, allowAnonymous(), serveProtocol)
    .get(PROTECTED_RESOURCE_METADATA_PATH, allowAnonymous(), (c) => {
      if (!isOAuthEnabled(c.env)) return c.notFound();
      const { origin } = new URL(c.req.url);
      return c.json({
        resource: mcpResourceOf(origin),
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        scopes_supported: [...OAUTH_SCOPES],
        resource_name: "personal-wiki",
      });
    })
    .post(OAUTH_TOKEN_PATH, allowAnonymous(), serveProtocol)
    .post(OAUTH_REGISTER_PATH, allowAnonymous(), serveProtocol)
    .get(OAUTH_AUTHORIZE_PATH, allowAnonymous(), showConsent)
    .post(OAUTH_AUTHORIZE_PATH, requireOwner(), decideConsent);
}

/** ライブラリが応答を作るエンドポイント（メタデータ、トークン、登録）。 */
function serveProtocol(c: Context<AppEnv>): Response | Promise<Response> {
  if (!isOAuthEnabled(c.env)) return c.notFound();
  return oauthServerFor(new URL(c.req.url).origin).fetch(c.req.raw, c.env, executionContextOf(c));
}

// ライブラリはこれらのエンドポイントで ctx を使わない（API のハンドラを持つ構成でだけ渡す）。
// app.request で呼ぶテストには ExecutionContext が無いので、そのときだけ空の実装を渡す。
const NO_EXECUTION_CONTEXT = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

function executionContextOf(c: Context<AppEnv>): ExecutionContext {
  try {
    return c.executionCtx as ExecutionContext;
  } catch {
    return NO_EXECUTION_CONTEXT;
  }
}

function helpersOf(c: Context<AppEnv>) {
  return oauthServerFor(new URL(c.req.url).origin).getOAuthApi(c.env);
}

async function showConsent(c: Context<AppEnv>): Promise<Response> {
  if (!isOAuthEnabled(c.env)) return c.notFound();
  if (c.get("principal").kind !== "owner") {
    const { pathname, search } = new URL(c.req.url);
    return c.redirect(`/_auth/login?return=${encodeURIComponent(pathname + search)}`, 302);
  }
  const oauth = helpersOf(c);
  try {
    const request = await oauth.parseAuthRequest(c.req.raw);
    // describeConsent を先に呼ぶ。client の参照に失敗したとき、KV に同意の記録を残さないため
    const consent = await oauth.describeConsent(request);
    const { handle, headers } = await oauth.beginConsent(request);
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Content-Security-Policy", consentPagePolicy(consent.redirectUri));
    headers.set("X-Robots-Tag", "noindex");
    return new Response(consentPage(consent, handle), { headers });
  } catch (error) {
    return authorizationFailure(error);
  }
}

/** 同意画面のラジオボタンの値と、許可する scope */
const ACCESS_CHOICES: Readonly<Record<string, readonly Scope[]>> = {
  read: ["read"],
  write: ["read", "write"],
};

async function decideConsent(c: Context<AppEnv>): Promise<Response> {
  if (!isOAuthEnabled(c.env)) return c.notFound();
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return errorPage(400, "同意画面のフォームとして読めない送信です。");
  }
  const handle = form.get("handle");
  const decision = form.get("decision");
  const oauth = helpersOf(c);
  try {
    if (typeof handle !== "string") {
      return errorPage(400, "同意画面のフォームとして読めない送信です。");
    }
    if (decision === "deny") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const access = form.get("access");
    const scope = typeof access === "string" ? ACCESS_CHOICES[access] : undefined;
    if (decision !== "approve" || scope === undefined) {
      return errorPage(400, "許可する権限を選んでから送信してください。");
    }
    const approved = await oauth.approveConsent(c.req.raw, handle, { scope: [...scope] });
    const { redirectTo } = await oauth.completeAuthorization({
      // 認可の要求はフォームからではなく、同意画面を開いたときに保存したものを使う
      request: approved.request,
      userId: OAUTH_USER_ID,
      metadata: {},
      scope: approved.request.scope,
      props: {},
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    return authorizationFailure(error);
  }
}

/**
 * client と redirect URI を検証できた誤りだけ、client へ error を付けて戻す。それ以外（検証前の
 * 誤り、使用済みや期限切れの handle、別のブラウザで開いた同意画面）は、送り先を信用できないので
 * この画面で表示する。KV の障害などは 500 にする。
 */
function authorizationFailure(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    if (error.redirectTo !== undefined) {
      return new Response(null, {
        status: 302,
        headers: { Location: error.redirectTo, "Cache-Control": "no-store" },
      });
    }
    return errorPage(400, error.description);
  }
  if (error instanceof CimdFetchError) {
    return errorPage(400, "クライアントの情報を取得できませんでした。");
  }
  throw error;
}

const BASE_PAGE_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
];

// オリジンとしてそのまま CSP の source に書いてよい形。`;` や空白を含む値で指示を足させない
const CSP_ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/;

/**
 * form-action に client の redirect URI のオリジンも入れる。Chrome は form の送信後のリダイレクト先にも
 * form-action を当てるので、'self' だけでは承認後の client への遷移が止まる。
 */
function consentPagePolicy(redirectUri: string): string {
  const sources = ["'self'"];
  const { origin } = new URL(redirectUri);
  if (CSP_ORIGIN_PATTERN.test(origin)) sources.push(origin);
  return [...BASE_PAGE_POLICY, `form-action ${sources.join(" ")}`].join("; ");
}

function errorPage(status: number, message: string): Response {
  const body = pageHtml(
    "接続できません",
    `<h1>接続できません</h1>
<p>${escapeHtml(message)}</p>
<p>接続するアプリから、もう一度接続をやり直してください。</p>`,
  );
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [...BASE_PAGE_POLICY, "form-action 'none'"].join("; "),
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** client 名、redirect URI、scope は client が登録時に決める値なので、すべてエスケープする。 */
function consentPage(consent: ConsentDescription, handle: string): string {
  const name = escapeHtml(consent.clientName);
  const requested =
    consent.scope.length > 0 ? consent.scope.map(escapeHtml).join(" ") : "（指定なし）";
  const preferWrite = consent.scope.includes("write");
  const loopback = consent.redirectIsLoopback
    ? `<p class="warn">送り先はこのコンピュータ上のアプリです。どのアプリでも待ち受けられるので、いま自分で接続を始めた場合だけ許可してください。</p>`
    : "";
  return pageHtml(
    "接続の許可",
    `<h1>${name} に wiki への接続を許可しますか</h1>
<dl>
<dt>クライアント</dt>
<dd>${name}<br><small>名前はクライアントの自己申告で、確認されていません。</small></dd>
<dt>トークンの送り先</dt>
<dd><strong>${escapeHtml(consent.redirectHost)}</strong><br><code>${escapeHtml(consent.redirectUri)}</code></dd>
<dt>要求された権限</dt>
<dd>${requested}</dd>
</dl>
${loopback}
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<fieldset>
<legend>許可する権限</legend>
<label><input type="radio" name="access" value="read"${preferWrite ? "" : " checked"}> 読み取り（read）: draft を含むページを読む</label>
<label><input type="radio" name="access" value="write"${preferWrite ? " checked" : ""}> 読み書き（read と write）: ページを作成・更新する。公開範囲は変えられない</label>
</fieldset>
<p><button name="decision" value="approve">許可する</button> <button name="decision" value="deny">拒否する</button></p>
</form>`,
  );
}

function pageHtml(title: string, main: string): string {
  return `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body { font-family: system-ui, sans-serif; line-height: 1.6; margin: 0 auto; max-width: 40rem; padding: 1rem; }
dt { font-weight: bold; margin-top: 0.5rem; }
dd { margin-left: 0; overflow-wrap: anywhere; }
label { display: block; margin: 0.25rem 0; }
.warn { border-left: 4px solid #c60; padding-left: 0.5rem; }
</style>
<main>
${main}
</main>
</html>
`;
}
