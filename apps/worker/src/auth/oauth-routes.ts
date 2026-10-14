import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type ConsentDescription,
  type GrantSummary,
} from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../env";
import { allowAnonymous, requireOwner } from "./middleware";
import { boundRegistrationRequest } from "./oauth-registration";
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  isOAuthEnabled,
  mcpResourceOf,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_GRANTS_PATH,
  OAUTH_GRANTS_REVOKE_PATH,
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
 * - メタデータ 2 つ、トークン、client の登録は匿名に開き、応答はライブラリが作る（クライアントは wiki の
 *   資格情報を持たない）。トークンと登録の Authorization は resolvePrincipal が読まずにライブラリへ渡す。
 *   登録は、ライブラリに渡す前に本文の大きさを断り、KV に書く前に oauth-registration.ts の検査を通す
 * - 認可（同意画面）と接続の一覧は owner のセッションを要る。無ければ /_auth/login を経由して戻す。
 *   Access の対象は /_auth/login のままで、/_auth/oauth/* は Access を通さない
 * CORS と OPTIONS は扱わない。想定するクライアント（claude.ai など）はサーバーから呼ぶので、ブラウザで
 * 動く MCP のクライアントは対象にしない。
 */
export function registerOAuthRoutes(app: Hono<AppEnv>, { now }: { now: () => number }) {
  const serveProtocol = (
    c: Context<AppEnv>,
    request: Request = c.req.raw,
  ): Response | Promise<Response> => {
    if (!isOAuthEnabled(c.env)) return c.notFound();
    const server = oauthServerFor(c.env, new URL(c.req.url).origin, now);
    return server.fetch(request, c.env, executionContextOf(c));
  };
  return app
    .get(AUTHORIZATION_SERVER_METADATA_PATH, allowAnonymous(), (c) => serveProtocol(c))
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
    .post(OAUTH_TOKEN_PATH, allowAnonymous(), (c) => serveProtocol(c))
    .post(OAUTH_REGISTER_PATH, allowAnonymous(), async (c) => {
      if (!isOAuthEnabled(c.env)) return c.notFound();
      const bounded = await boundRegistrationRequest(c.req.raw);
      if (bounded instanceof Response) return bounded;
      return serveProtocol(c, bounded);
    })
    .get(OAUTH_AUTHORIZE_PATH, allowAnonymous(), showConsent)
    .post(OAUTH_AUTHORIZE_PATH, requireOwner(), decideConsent)
    .get(OAUTH_GRANTS_PATH, allowAnonymous(), showGrants)
    .post(OAUTH_GRANTS_REVOKE_PATH, requireOwner(), revokeGrantFromForm);
}

function redirectToLogin(c: Context<AppEnv>): Response {
  const { pathname, search } = new URL(c.req.url);
  return c.redirect(`/_auth/login?return=${encodeURIComponent(pathname + search)}`, 302);
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
  return oauthServerFor(c.env, new URL(c.req.url).origin).getOAuthApi(c.env);
}

async function showConsent(c: Context<AppEnv>): Promise<Response> {
  if (!isOAuthEnabled(c.env)) return c.notFound();
  if (c.get("principal").kind !== "owner") return redirectToLogin(c);
  const oauth = helpersOf(c);
  try {
    const request = await oauth.parseAuthRequest(c.req.raw);
    // ライブラリは公開 client にだけ PKCE を求める。client_secret を持つ client でも、code が漏れたときに
    // 交換させないよう PKCE を必須にする
    if (!request.codeChallenge) {
      return redirectToClient(
        authorizationErrorRedirect(request, "invalid_request", "PKCE（S256）が必要です"),
      );
    }
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
const ACCESS_CHOICES: ReadonlyMap<string, readonly Scope[]> = new Map([
  ["read", ["read"]],
  ["write", ["read", "write"]],
]);

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
    const scope = typeof access === "string" ? ACCESS_CHOICES.get(access) : undefined;
    if (decision !== "approve" || scope === undefined) {
      return errorPage(400, "許可する権限を選んでから送信してください。");
    }
    const approved = await oauth.approveConsent(c.req.raw, handle, { scope: [...scope] });
    let redirectTo: string;
    try {
      // 同じ client の以前の grant とトークンは、ライブラリが失効させる（revokeExistingGrants の既定）
      ({ redirectTo } = await oauth.completeAuthorization({
        // 認可の要求はフォームからではなく、同意画面を開いたときに保存したものを使う
        request: approved.request,
        userId: OAUTH_USER_ID,
        metadata: {},
        scope: approved.request.scope,
        props: {},
      }));
    } catch (error) {
      // 同意画面を開いた後で client が消えると、ライブラリは AuthorizationError ではない Error を投げる
      if (
        !(error instanceof AuthorizationError) &&
        (await oauth.lookupClient(approved.request.clientId)) === null
      ) {
        return errorPage(400, "接続しようとしたクライアントの登録が見つかりません。");
      }
      throw error;
    }
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    return authorizationFailure(error);
  }
}

function redirectToClient(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

/**
 * client と redirect URI を検証できた誤りだけ、client へ error を付けて戻す。それ以外（検証前の
 * 誤り、使用済みや期限切れの handle、別のブラウザで開いた同意画面）は、送り先を信用できないので
 * この画面で表示する。KV の障害などは 500 にする。
 */
function authorizationFailure(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    if (error.redirectTo !== undefined) return redirectToClient(error.redirectTo);
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

/** 1 ページに出す接続の数。1 件ごとに KV の読み取りが grant と client で 2 回かかる */
const GRANTS_PAGE_SIZE = 50;
// KV の list の cursor と、ライブラリが作る grant の id の形。外れた値は KV に渡さない
const KV_CURSOR_PATTERN = /^[A-Za-z0-9_\-+/=.]{1,1024}$/;
const GRANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * owner が許可した接続（grant）の一覧。grant を取り消すと、その grant のアクセストークンと更新トークンが
 * すべて失効する。client の登録は残るが、使われなければ期限で消える。
 */
async function showGrants(c: Context<AppEnv>): Promise<Response> {
  if (!isOAuthEnabled(c.env)) return c.notFound();
  if (c.get("principal").kind !== "owner") return redirectToLogin(c);
  const cursor = c.req.query("cursor");
  if (cursor !== undefined && !KV_CURSOR_PATTERN.test(cursor)) {
    return errorPage(400, "一覧の続きの位置が読めません。", "最初のページから開き直してください。");
  }
  const oauth = helpersOf(c);
  const page = await oauth.listUserGrants(OAUTH_USER_ID, {
    limit: GRANTS_PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
  });
  const clientIds = [...new Set(page.items.map((grant) => grant.clientId))];
  const clients = new Map(
    await Promise.all(
      clientIds.map(async (id) => [id, (await oauth.lookupClient(id))?.clientName] as const),
    ),
  );
  const grants = page.items.toSorted((a, b) => b.createdAt - a.createdAt);
  return new Response(grantsPage(grants, clients, page.cursor), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [...BASE_PAGE_POLICY, "form-action 'self'"].join("; "),
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex",
    },
  });
}

async function revokeGrantFromForm(c: Context<AppEnv>): Promise<Response> {
  if (!isOAuthEnabled(c.env)) return c.notFound();
  const grantId = await c.req
    .formData()
    .then((form) => form.get("grant"))
    .catch(() => null);
  if (typeof grantId !== "string" || !GRANT_ID_PATTERN.test(grantId)) {
    return errorPage(400, "取り消す接続を読めない送信です。", "接続の一覧から開き直してください。");
  }
  await helpersOf(c).revokeGrant(grantId, OAUTH_USER_ID);
  return new Response(null, {
    status: 303,
    headers: { Location: OAUTH_GRANTS_PATH, "Cache-Control": "no-store" },
  });
}

function formatEpochSeconds(seconds: number | undefined): string {
  if (seconds === undefined) return "なし";
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function grantsPage(
  grants: readonly GrantSummary[],
  clientNames: ReadonlyMap<string, string | undefined>,
  nextCursor: string | undefined,
): string {
  const rows = grants.map((grant) => {
    const name = clientNames.get(grant.clientId);
    const label =
      name === undefined
        ? "（登録が消えたクライアント）"
        : escapeHtml(truncate(name, CONSENT_NAME_LENGTH));
    const scope = grant.scope.length > 0 ? grant.scope.map(escapeHtml).join(" ") : "（なし）";
    const host = grant.redirectUri === undefined ? "" : safeHost(grant.redirectUri);
    return `<li>
<p><strong>${label}</strong><br><small>client_id: <code>${escapeHtml(grant.clientId)}</code></small></p>
<p>権限: ${scope}${host === "" ? "" : `<br>送り先: ${escapeHtml(host)}`}<br>許可: ${formatEpochSeconds(grant.createdAt)}<br>期限: ${formatEpochSeconds(grant.expiresAt)}</p>
<form method="post" action="${OAUTH_GRANTS_REVOKE_PATH}">
<input type="hidden" name="grant" value="${escapeHtml(grant.id)}">
<button>取り消す</button>
</form>
</li>`;
  });
  const list =
    rows.length > 0
      ? `<ul class="grants">\n${rows.join("\n")}\n</ul>`
      : "<p>許可した接続はありません。</p>";
  const more =
    nextCursor === undefined
      ? ""
      : `<p><a href="${OAUTH_GRANTS_PATH}?cursor=${encodeURIComponent(nextCursor)}">続きを見る</a></p>`;
  return pageHtml(
    "許可した接続",
    `<h1>許可した接続</h1>
<p>取り消すと、その接続のトークンはすぐに使えなくなります。同じクライアントを同意画面で許可し直すと、
以前の許可は自動で取り消されます。</p>
${list}
${more}`,
  );
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return "";
  }
}

function errorPage(
  status: number,
  message: string,
  hint = "接続するアプリから、もう一度接続をやり直してください。",
): Response {
  const body = pageHtml(
    "接続できません",
    `<h1>接続できません</h1>
<p>${escapeHtml(message)}</p>
<p>${escapeHtml(hint)}</p>`,
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

/** 登録では 100 文字まで受け付けるが、見出しが画面を埋めないよう短く切る */
const CONSENT_NAME_LENGTH = 40;

function truncate(value: string, length: number): string {
  const chars = [...value];
  return chars.length > length ? `${chars.slice(0, length).join("")}…` : value;
}

/**
 * client 名、redirect URI、scope は client が登録時に決める値なので、すべてエスケープする。
 * 権限の既定は、要求に関わらず read にする。write は owner が選んだときだけ許す。
 */
function consentPage(consent: ConsentDescription, handle: string): string {
  const name = escapeHtml(truncate(consent.clientName, CONSENT_NAME_LENGTH));
  const requested =
    consent.scope.length > 0 ? consent.scope.map(escapeHtml).join(" ") : "（指定なし）";
  const loopback = consent.redirectIsLoopback
    ? `<p class="warn">送り先はこのコンピュータ上のアプリです。どのアプリでも待ち受けられるので、いま自分で接続を始めた場合だけ許可してください。</p>`
    : "";
  return pageHtml(
    "接続の許可",
    `<h1>${name} に wiki への接続を許可しますか</h1>
<dl>
<dt>クライアント</dt>
<dd>${name}<br><small>名前はクライアントの自己申告で、確認されていません。</small><br><small>client_id: <code>${escapeHtml(consent.clientId)}</code></small></dd>
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
<label><input type="radio" name="access" value="read" checked> 読み取り（read）: draft を含むページを読む</label>
<label><input type="radio" name="access" value="write"> 読み書き（read と write）: ページを作成・更新する。公開範囲は変えられない</label>
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
.grants { list-style: none; padding: 0; }
.grants li { border-top: 1px solid #ccc; padding: 0.5rem 0; }
.warn { border-left: 4px solid #c60; padding-left: 0.5rem; }
</style>
<main>
${main}
</main>
</html>
`;
}
