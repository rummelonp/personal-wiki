import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type ConsentDescription,
  type GrantSummary,
} from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";
import themeCss from "../../../web/src/theme.css";
import type { AppEnv } from "../env";
import { siteNameOf } from "../site-name";
import { allowAnonymous, requireOwner } from "./middleware";
import pageCss from "./oauth-page.css";
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
        resource_name: siteNameOf(c.env),
      });
    })
    .post(OAUTH_TOKEN_PATH, allowAnonymous(), (c) => serveProtocol(c))
    .post(OAUTH_REGISTER_PATH, allowAnonymous(), async (c) => {
      if (!isOAuthEnabled(c.env)) return c.notFound();
      const bounded = await boundRegistrationRequest(c.req.raw);
      if (bounded instanceof Response) return bounded;
      return serveProtocol(c, bounded);
    })
    .get(OAUTH_AUTHORIZE_PATH, allowAnonymous(), (c) => showConsent(c, now))
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

async function showConsent(c: Context<AppEnv>, now: () => number): Promise<Response> {
  if (!isOAuthEnabled(c.env)) return c.notFound();
  if (c.get("principal").kind !== "owner") return redirectToLogin(c);
  const oauth = helpersOf(c);
  let failureMessage = FAILURE_MESSAGES.request;
  try {
    const request = await oauth.parseAuthRequest(c.req.raw);
    failureMessage = FAILURE_MESSAGES.other;
    // ライブラリは公開 client にだけ PKCE を求める。client_secret を持つ client でも、code が漏れたときに
    // 交換させないよう PKCE を必須にする
    if (!request.codeChallenge) {
      return redirectToClient(
        authorizationErrorRedirect(request, "invalid_request", "PKCE（S256）が必要です"),
      );
    }
    // describeConsent を先に呼ぶ。client の参照に失敗したとき、KV に同意の記録を残さないため
    const consent = await oauth.describeConsent(request);
    const registeredAt = await registrationTimeOf(oauth, consent);
    const { handle, headers } = await oauth.beginConsent(request);
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Content-Security-Policy", consentPagePolicy(consent.redirectUri));
    headers.set("X-Robots-Tag", "noindex");
    return new Response(consentPage(consent, handle, { registeredAt, now: now() }), { headers });
  } catch (error) {
    return authorizationFailure(error, failureMessage);
  }
}

/** Date が表せる範囲（epoch ミリ秒）。範囲外の値は toISOString が RangeError を投げる */
const MAX_DATE_MS = 8.64e15;

/**
 * client の登録時刻（epoch ミリ秒）。記録が無い、読めない、Date で表せないときは null で、
 * 同意画面は登録の行を出さない。CIMD の client の registrationDate は登録でなく取得の時刻なので、
 * 登録した client にだけ返す。
 */
export async function registrationTimeOf(
  oauth: Pick<ReturnType<typeof helpersOf>, "lookupClient">,
  consent: Pick<ConsentDescription, "clientId" | "clientDomain">,
): Promise<number | null> {
  if (consent.clientDomain !== undefined) return null;
  try {
    const seconds: unknown = (await oauth.lookupClient(consent.clientId))?.registrationDate;
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
    const ms = seconds * 1000;
    return Math.abs(ms) <= MAX_DATE_MS ? ms : null;
  } catch {
    return null;
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
    return errorPage(400, "送信の内容を読み取れませんでした。");
  }
  const handle = form.get("handle");
  const decision = form.get("decision");
  const oauth = helpersOf(c);
  let failureMessage = FAILURE_MESSAGES.consent;
  try {
    if (typeof handle !== "string") {
      return errorPage(400, "送信の内容を読み取れませんでした。");
    }
    if (decision === "deny") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const access = form.get("access");
    const scope = typeof access === "string" ? ACCESS_CHOICES.get(access) : undefined;
    if (decision !== "approve" || scope === undefined) {
      return errorPage(400, "送信の内容を読み取れませんでした。");
    }
    const approved = await oauth.approveConsent(c.req.raw, handle, { scope: [...scope] });
    failureMessage = FAILURE_MESSAGES.other;
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
        return errorPage(400, "接続しようとしたアプリの登録が見つかりません。");
      }
      throw error;
    }
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    return authorizationFailure(error, failureMessage);
  }
}

function redirectToClient(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

/**
 * この画面で出す誤りの文。ライブラリの誤りはほぼ invalid_request で code では見分けられず、英語の
 * description を照合すると版上げで黙って外れるので、失敗した呼び出しで文を選ぶ。
 * - request: 認可の要求の解析（client_id や redirect URI を確かめられない）
 * - consent: 同意の送信（handle が使用済み、期限切れ、別のブラウザのもの）
 */
const FAILURE_MESSAGES = {
  request: "接続を求めたアプリか、トークンの送り先を確かめられませんでした。",
  consent:
    "この同意画面はもう使えません。開いてから時間がたったか、すでに送信したか、別のブラウザで開いた画面です。",
  other: "接続を完了できませんでした。",
};

/**
 * client と redirect URI を検証できた誤りだけ、client へ error を付けて戻す。それ以外（検証前の
 * 誤り、使用済みや期限切れの handle、別のブラウザで開いた同意画面）は、送り先を信用できないので
 * この画面で表示する。KV の障害などは 500 にする。
 */
function authorizationFailure(error: unknown, message: string): Response {
  if (error instanceof AuthorizationError) {
    if (error.redirectTo !== undefined) return redirectToClient(error.redirectTo);
    console.error(
      JSON.stringify({
        event: "oauth.authorization_failed",
        code: error.code,
        description: error.description,
      }),
    );
    return errorPage(400, message);
  }
  if (error instanceof CimdFetchError) {
    return errorPage(400, "接続するアプリの情報を取得できませんでした。");
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
    return errorPage(
      400,
      "一覧の続きを開けませんでした。",
      "最初のページから開き直してください。",
      "許可した接続の一覧を開けません",
    );
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
    return errorPage(
      400,
      "どの接続を取り消すかを読み取れませんでした。",
      "接続の一覧から開き直してください。",
      "取り消せません",
    );
  }
  await helpersOf(c).revokeGrant(grantId, OAUTH_USER_ID);
  return new Response(null, {
    status: 303,
    headers: { Location: OAUTH_GRANTS_PATH, "Cache-Control": "no-store" },
  });
}

/**
 * `2026/10/01 12:34 UTC` の形。同意画面と一覧は CSP で script を持たず、端末のタイムゾーンで書き直せない
 * ので、UTC と明記して出す。
 */
function formatUtcMinutes(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "/")} ${iso.slice(11, 16)} UTC`;
}

function formatEpochSeconds(seconds: number | undefined): string {
  return seconds === undefined ? "なし" : formatUtcMinutes(seconds * 1000);
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
        ? "（登録が消えたアプリ）"
        : escapeHtml(truncate(name, CONSENT_NAME_LENGTH));
    const scope = describeScopes(grant.scope) ?? "（なし）";
    const host = grant.redirectUri === undefined ? "" : safeHost(grant.redirectUri);
    return `<li>
<p><strong>${label}</strong><small class="note">client_id: <code>${escapeHtml(grant.clientId)}</code></small></p>
<p class="meta">権限: ${scope}${host === "" ? "" : `<br>送り先: ${escapeHtml(host)}`}<br>許可: ${formatEpochSeconds(grant.createdAt)}<br>期限: ${formatEpochSeconds(grant.expiresAt)}</p>
<form method="post" action="${OAUTH_GRANTS_REVOKE_PATH}">
<input type="hidden" name="grant" value="${escapeHtml(grant.id)}">
<button class="button button-danger">取り消す</button>
</form>
</li>`;
  });
  const list =
    rows.length > 0
      ? `<p class="lead">取り消すと、その接続はすぐに使えなくなります。同じアプリを許可し直すと、以前の許可は自動で取り消されます。</p>
<ul class="grants">\n${rows.join("\n")}\n</ul>`
      : "<p>許可した接続はありません。</p>";
  const more =
    nextCursor === undefined
      ? ""
      : `<p><a href="${OAUTH_GRANTS_PATH}?cursor=${encodeURIComponent(nextCursor)}">続きを見る</a></p>`;
  return pageHtml(
    "許可した接続",
    `<h1>許可した接続</h1>
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
  hint = "接続するアプリから、接続をやり直してください。",
  heading = "接続できません",
): Response {
  const body = pageHtml(
    escapeHtml(heading),
    `<h1>${escapeHtml(heading)}</h1>
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

/** 「3 分前（2026/10/01 00:00 UTC）」の形。時計のずれで未来になった場合も 1 分以内に丸める */
export function describeRegistration(registeredAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - registeredAt) / 60_000));
  const age =
    minutes < 1
      ? "1 分以内"
      : minutes < 60
        ? `${minutes} 分前`
        : minutes < 24 * 60
          ? `${Math.floor(minutes / 60)} 時間前`
          : `${Math.floor(minutes / (24 * 60))} 日前`;
  return `${age}（${formatUtcMinutes(registeredAt)}）`;
}

/**
 * scope の並びを、同意画面と一覧に出す権限の名前にして HTML にエスケープする。空なら null。
 * write は read を含む（principal.ts の hasScope）ので、write があれば read の有無によらず「読み書き」に
 * まとめる。知らない scope は client が要求できる任意の文字列なので、名前を当てずにそのまま並べる。
 */
export function describeScopes(scopes: readonly string[]): string | null {
  const known = scopes.includes("write")
    ? ["読み書き"]
    : scopes.includes("read")
      ? ["読み取り"]
      : [];
  const unknown = scopes.filter((scope) => scope !== "read" && scope !== "write").map(escapeHtml);
  const names = [...known, ...unknown];
  return names.length > 0 ? names.join("、") : null;
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
export function consentPage(
  consent: ConsentDescription,
  handle: string,
  { registeredAt, now }: { registeredAt: number | null; now: number },
): string {
  const name = escapeHtml(truncate(consent.clientName, CONSENT_NAME_LENGTH));
  const requested = describeScopes(consent.scope) ?? "（指定なし）";
  const loopback = consent.redirectIsLoopback
    ? `<p class="warn">送り先はこのコンピュータ上のアプリです。どのアプリでも待ち受けられます。</p>`
    : "";
  const registered =
    registeredAt === null
      ? ""
      : `<div><dt>登録</dt>
<dd>${escapeHtml(describeRegistration(registeredAt, now))}<small class="note">つなぎ直した接続では、以前に登録した日時が出ることがあります。日時だけでは、自分が始めた接続かは判断できません。</small></dd></div>
`;
  return pageHtml(
    "接続の許可",
    `<h1>${name} に wiki への接続を許可しますか</h1>
<dl class="facts">
<div><dt>接続するアプリ</dt>
<dd>${name}<small class="note">この名前はアプリ自身が名乗ったもので、確かめられていません。</small><small class="note">client_id: <code>${escapeHtml(consent.clientId)}</code></small></dd></div>
<div><dt>トークンの送り先</dt>
<dd><strong>${escapeHtml(consent.redirectHost)}</strong><code class="uri">${escapeHtml(consent.redirectUri)}</code></dd></div>
${registered}<div><dt>要求された権限</dt>
<dd>${requested}</dd></div>
</dl>
<p class="warn">この接続を、いま自分で始めた場合だけ許可してください。他の人から送られたリンクで開いた場合は、許可しないでください。送り先が claude.ai でも、接続を始めた人が自分とは限りません。</p>
${loopback}
<form method="post" class="consent-form">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<fieldset class="choices">
<legend>許可する権限</legend>
<label class="choice"><input type="radio" name="access" value="read" checked><span><strong>読み取り</strong>: 下書きを含むすべてのページを読めます。</span></label>
<label class="choice"><input type="radio" name="access" value="write"><span><strong>読み書き</strong>: 読み取りに加えて、ページの作成と書き換えができます。公開中のページも書き換えられます。削除、画像の添付、公開と下書きの切り替えはできません。</span></label>
</fieldset>
<div class="actions"><button class="button button-primary" name="decision" value="approve">許可する</button><button class="button button-quiet" name="decision" value="deny">拒否する</button></div>
</form>`,
  );
}

function pageHtml(title: string, main: string): string {
  return `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
${themeCss}
${pageCss}
</style>
<p class="brand">personal-wiki</p>
<main class="sheet">
${main}
</main>
</html>
`;
}
