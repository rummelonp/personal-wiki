import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type ConsentDescription,
  type GrantSummary,
} from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";
import { generateCookie, getCookie, setCookie } from "hono/cookie";
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
import { readOwnerAuthConfig } from "./owner-config";
import type { Scope } from "./principal";
import { signJson, verifyJson } from "./signed-value";

/**
 * OAuth の認可サーバーのルートを登録する。OAuth を閉じた環境（isOAuthEnabled）ではどれも 404 にする。
 * - メタデータ 2 つ、トークン、client の登録は匿名に開き、レスポンスはライブラリが作る（クライアントは wiki の
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
    .get(OAUTH_GRANTS_PATH, allowAnonymous(), (c) => showGrants(c, now))
    .post(OAUTH_GRANTS_REVOKE_PATH, requireOwner(), (c) => revokeGrantFromForm(c, now));
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
    return new Response(
      consentPage(consent, handle, { registeredAt, now: now(), siteName: siteNameOf(c.env) }),
      { headers },
    );
  } catch (error) {
    return authorizationFailure(siteNameOf(c.env), error, failureMessage);
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
  const siteName = siteNameOf(c.env);
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return errorPage(siteName, 400, UNREADABLE_SUBMISSION);
  }
  const handle = form.get("handle");
  const decision = form.get("decision");
  const oauth = helpersOf(c);
  let failureMessage = FAILURE_MESSAGES.consent;
  try {
    // 空の handle は使用済みや期限切れとは違い、同意画面から送られた値ではない
    if (typeof handle !== "string" || handle === "") {
      return errorPage(siteName, 400, UNREADABLE_SUBMISSION);
    }
    if (decision === "deny") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const access = form.get("access");
    const scope = typeof access === "string" ? ACCESS_CHOICES.get(access) : undefined;
    if (decision !== "approve" || scope === undefined) {
      return errorPage(siteName, 400, UNREADABLE_SUBMISSION);
    }
    const approved = await oauth.approveConsent(c.req.raw, handle, { scope: [...scope] });
    failureMessage = FAILURE_MESSAGES.other;
    let redirectTo: string;
    try {
      // 同じ client の以前の grant とトークンは、ライブラリが失効させる（revokeExistingGrants の既定）
      ({ redirectTo } = await oauth.completeAuthorization({
        // 認可のリクエストはフォームからではなく、同意画面を開いたときに保存したものを使う
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
        return errorPage(siteName, 400, "接続しようとしたアプリの登録が見つかりません。");
      }
      throw error;
    }
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    return authorizationFailure(siteName, error, failureMessage);
  }
}

function redirectToClient(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

const UNREADABLE_SUBMISSION = "送信の内容を読み取れませんでした。";

/**
 * この画面で出すエラーの文。ライブラリのエラーはほぼ invalid_request で code では見分けられず、英語の
 * description を照合すると版上げで黙って外れるので、失敗した呼び出しで文を選ぶ。
 * - request: 認可のリクエストの解析（client_id や redirect URI を確かめられない）
 * - consent: 同意の送信（handle が使用済み、期限切れ、別のブラウザのもの）
 * - other: 上のどちらでもない失敗（同意を受け付けた後の処理、承認する scope の検証など）
 */
const FAILURE_MESSAGES = {
  request: "接続を求めたアプリか、トークンの送り先を確かめられませんでした。",
  consent:
    "この同意画面はもう使えません。開いてから時間がたったか、すでに送信したか、別のブラウザで開いた画面です。",
  other: "接続を完了できませんでした。",
};

/**
 * client と redirect URI を検証できたエラーだけ、client へ error を付けて戻す。それ以外（検証前の
 * エラー、使用済みや期限切れの handle、別のブラウザで開いた同意画面）は、送り先を信用できないので
 * この画面で表示する。KV の障害などは 500 にする。
 */
export function authorizationFailure(siteName: string, error: unknown, message: string): Response {
  if (error instanceof AuthorizationError) {
    if (error.redirectTo !== undefined) return redirectToClient(error.redirectTo);
    console.error(
      JSON.stringify({
        event: "oauth.authorization_failed",
        code: error.code,
        description: error.description,
      }),
    );
    // approveConsent は handle の失敗と同じ呼び出しで scope の検証の失敗も投げ、呼び出しでは分けられないので
    // code で分ける。handle を消費する前の失敗なので、使用済みと伝える consent の文は当てない
    return errorPage(
      siteName,
      400,
      error.code === "invalid_scope" ? FAILURE_MESSAGES.other : message,
    );
  }
  if (error instanceof CimdFetchError) {
    return errorPage(siteName, 400, "接続するアプリの情報を取得できませんでした。");
  }
  throw error;
}

const BASE_PAGE_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  // Firefox などは favicon の取得にも img-src を当てる。data: や外部の origin は使わないので足さない
  "img-src 'self'",
];

// オリジンとしてそのまま CSP の source に書いてよい形。`;` や空白を含む値で指示を足させない
const CSP_ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/;

/**
 * form-action に client の redirect URI のオリジンも入れる。Chrome は form の送信後のリダイレクト先にも
 * form-action を当てるので、'self' だけでは承認後の client への遷移が止まる。
 * script は CONSENT_SUBMIT_GUARD の hash だけを許す。
 */
function consentPagePolicy(redirectUri: string): string {
  const sources = ["'self'"];
  const { origin } = new URL(redirectUri);
  if (CSP_ORIGIN_PATTERN.test(origin)) sources.push(origin);
  return [
    ...BASE_PAGE_POLICY,
    `script-src ${CONSENT_SCRIPT_SOURCE}`,
    `form-action ${sources.join(" ")}`,
  ].join("; ");
}

/**
 * 同意の form を 1 回だけ送らせる。handle は 1 回で使い切るので、2 回目の送信は失敗の画面になり、
 * ブラウザは 1 回目の応答（client への遷移）を捨てる。1 回目で作った grant は code を交換されないまま、
 * KV の有効期限（10 分）で消えるまで残る。同じ client の以前の grant は、1 回目の承認の時点で取り消されている。
 * ボタンを submit の中で無効にすると、押したボタンの decision が送信の内容から落ちるので、無効にするのは
 * 送信の内容ができた後にし、それまでの 2 回目の送信は sent で止める。
 * フォームの状態の復元や bfcache からの復帰で画面を開き直したときは、ボタンを押せる状態に戻す。
 * bfcache から戻した画面の handle は使用済みなので、押すと失敗の画面になる。
 * JS が無い環境ではこの script が動かないだけで、form はそのまま送れる。
 */
const CONSENT_SUBMIT_GUARD = `(() => {
  const form = document.querySelector(".consent-form");
  const buttons = form.querySelectorAll("button");
  let sent = false;
  form.addEventListener("submit", (event) => {
    if (sent) {
      event.preventDefault();
      return;
    }
    sent = true;
    setTimeout(() => {
      for (const button of buttons) button.disabled = true;
    });
  });
  addEventListener("pageshow", (event) => {
    if (event.persisted) sent = false;
    for (const button of buttons) button.disabled = sent;
  });
})();`;

/**
 * CONSENT_SUBMIT_GUARD を許す CSP の source。要求の中で計算すると、計算に失敗したときに同意の記録だけが
 * KV に残るので、定数で持つ。script と一致することは単体テストが確かめる。
 */
const CONSENT_SCRIPT_SOURCE = "'sha256-/OqX9RESOREtZ6plj+MY88BllJ+rkySF60VCJ1pKDNg='";

/** 1 ページに出す接続の数。1 件ごとに KV の読み取りが grant と client で 2 回かかる */
const GRANTS_PAGE_SIZE = 50;
// KV の list の cursor と、ライブラリが作る grant の id の形。外れた値は KV に渡さない
const KV_CURSOR_PATTERN = /^[A-Za-z0-9_\-+/=.]{1,1024}$/;
const GRANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * owner が許可した接続（grant）の一覧。grant を取り消すと、その grant のアクセストークンと更新トークンが
 * すべて失効する。client の登録は残るが、使われなければ期限で消える。
 */
async function showGrants(c: Context<AppEnv>, now: () => number): Promise<Response> {
  if (!isOAuthEnabled(c.env)) return c.notFound();
  if (c.get("principal").kind !== "owner") return redirectToLogin(c);
  const cursor = c.req.query("cursor");
  if (cursor !== undefined && !KV_CURSOR_PATTERN.test(cursor)) {
    return errorPage(
      siteNameOf(c.env),
      400,
      "一覧の続きを開けませんでした。",
      "最初のページから開き直してください。",
      "許可した接続の一覧を開けません",
    );
  }
  const notice = getCookie(c, NOTICE_COOKIE_NAME);
  if (notice === undefined) return grantsResponse(c, { cursor });
  const res = await grantsResponse(c, { cursor, noticeHtml: await noticeHtmlOf(c, notice, now) });
  // 検証できない値も消す。読んだ後に残すと、開き直した一覧に同じ知らせが出る
  res.headers.append(
    "Set-Cookie",
    generateCookie(NOTICE_COOKIE_NAME, "", {
      ...NOTICE_COOKIE_ATTRIBUTES,
      maxAge: 0,
      expires: new Date(0),
    }),
  );
  return res;
}

async function grantsResponse(
  c: Context<AppEnv>,
  { cursor, noticeHtml = "" }: { cursor?: string | undefined; noticeHtml?: string },
): Promise<Response> {
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
  return new Response(grantsPage(grants, clients, page.cursor, siteNameOf(c.env), noticeHtml), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [...BASE_PAGE_POLICY, "form-action 'self'"].join("; "),
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex",
    },
  });
}

async function revokeGrantFromForm(c: Context<AppEnv>, now: () => number): Promise<Response> {
  if (!isOAuthEnabled(c.env)) return c.notFound();
  const grantId = await c.req
    .formData()
    .then((form) => form.get("grant"))
    .catch(() => null);
  if (typeof grantId !== "string" || !GRANT_ID_PATTERN.test(grantId)) {
    return errorPage(
      siteNameOf(c.env),
      400,
      "どの接続を取り消すかを読み取れませんでした。",
      "接続の一覧から開き直してください。",
      "取り消せません",
    );
  }
  const oauth = helpersOf(c);
  const revoked = await findGrant(oauth, grantId);
  await oauth.revokeGrant(grantId, OAUTH_USER_ID);
  const secret = readOwnerAuthConfig(c.env)?.sessionSecret;
  if (secret !== undefined) {
    const notice: RevokeNotice =
      revoked === undefined
        ? { k: "absent" }
        : { k: "revoked", c: revoked.clientId, t: revoked.createdAt };
    const value = await signJson(secret, NOTICE_SIGNING_CONTEXT, {
      ...notice,
      exp: Math.floor(now() / 1000) + NOTICE_TTL_SECONDS,
    });
    setCookie(c, NOTICE_COOKIE_NAME, value, {
      ...NOTICE_COOKIE_ATTRIBUTES,
      maxAge: NOTICE_TTL_SECONDS,
    });
  }
  return c.redirect(OAUTH_GRANTS_PATH, 303);
}

/*
 * 取り消しの結果の知らせは、一覧へのリダイレクトの先へ cookie で渡す。取り消しの応答を一覧の HTML にすると、
 * 戻る、再読み込みで送信をやり直させ、アドレス欄に GET では開けない取り消しの URL が残る。
 * 名前や日時を URL で渡すと、書き換えた URL で任意の文や、取り消していない接続を取り消したと出せる。
 * cookie にも文は載せず、知らせの種類と、取り消した grant の client_id と許可の日時だけを載せ、名前は
 * 一覧を開くときに引く。owner のセッションと同じ秘密に、用途を分けて署名する。
 * http の localhost の WebKit のように Secure の cookie を受け付けないブラウザでは、知らせが出ないだけで、
 * 取り消しと一覧への遷移は変わらない。
 */
const NOTICE_COOKIE_NAME = "__Host-wiki_oauth_notice";
const NOTICE_SIGNING_CONTEXT = "personal-wiki/oauth-revoke-notice/v1.";
/** リダイレクトの直後に読むだけなので短くする */
const NOTICE_TTL_SECONDS = 60;
/** 発行と削除で揃えないと、ブラウザが削除を別の cookie として扱う */
const NOTICE_COOKIE_ATTRIBUTES = {
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
} as const;

/** t は grant を許可した時刻（epoch 秒） */
type RevokeNotice = { k: "absent" } | { k: "revoked"; c: string; t: number };

/** 署名と期限を検証できなければ、知らせを出さない */
async function noticeHtmlOf(c: Context<AppEnv>, value: string, now: () => number): Promise<string> {
  const secret = readOwnerAuthConfig(c.env)?.sessionSecret;
  if (secret === undefined) return "";
  const payload = await verifyJson(secret, NOTICE_SIGNING_CONTEXT, value);
  if (payload === null || typeof payload.exp !== "number" || payload.exp * 1000 <= now()) {
    return "";
  }
  if (payload.k === "absent") {
    return `<p class="done">取り消す接続は、すでにありませんでした。</p>`;
  }
  if (payload.k !== "revoked" || typeof payload.c !== "string" || typeof payload.t !== "number") {
    return "";
  }
  const name = (await helpersOf(c).lookupClient(payload.c))?.clientName;
  // 許可の日時を括弧で添えるので、名前が無いときの括弧付きの表示は使わず、二重にしない
  const label = name === undefined ? UNREGISTERED_CLIENT_LABEL : clientLabelHtml(name);
  return `<p class="done">${label}（${formatEpochSeconds(payload.t)} に許可）の接続を取り消しました。</p>`;
}

async function findGrant(
  oauth: Pick<ReturnType<typeof helpersOf>, "listUserGrants">,
  grantId: string,
): Promise<GrantSummary | undefined> {
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(OAUTH_USER_ID, cursor === undefined ? {} : { cursor });
    const found = page.items.find((grant) => grant.id === grantId);
    if (found !== undefined) return found;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return undefined;
}

/**
 * `2026/10/01 12:34 UTC` の形。同意画面と一覧は日時を script で端末のタイムゾーンに書き直さないので、
 * UTC と明記して出す。
 */
function formatUtcMinutes(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "/")} ${iso.slice(11, 16)} UTC`;
}

function formatEpochSeconds(seconds: number | undefined): string {
  return seconds === undefined ? "なし" : formatUtcMinutes(seconds * 1000);
}

/**
 * エラーの画面と一覧は行き止まりになりやすいので、wiki のトップへの出口を 1 つ置く。同意の画面には置かない。
 * 許可か拒否を選ばせる画面で、別の出口があると選ばずに離れる操作が増える。
 */
const BACK_LINK = `<p class="back"><a href="/">wiki に戻る</a></p>`;

function grantsPage(
  grants: readonly GrantSummary[],
  clientNames: ReadonlyMap<string, string | undefined>,
  nextCursor: string | undefined,
  siteName: string,
  noticeHtml: string,
): string {
  const rows = grants.map((grant) => {
    const label = clientLabelHtml(clientNames.get(grant.clientId));
    const scope = describeScopesHtml(grant.scope) ?? "（なし）";
    const host = grant.redirectUri === undefined ? "" : safeHost(grant.redirectUri);
    // 読み上げでボタンを区別する。名前は client が決める値で重複しうるので、許可の日時も添える。
    // aria-label は中身を置き換えるので、見える「取り消す」を属性に書き写すことになり、片方だけ直すと食い違う
    return `<li>
<p><strong>${label}</strong><small class="note">client_id: <code>${escapeHtml(grant.clientId)}</code></small></p>
<p class="meta">権限: ${scope}${host === "" ? "" : `<br>送り先: ${escapeHtml(host)}`}<br>許可: ${formatEpochSeconds(grant.createdAt)}<br>期限: ${formatEpochSeconds(grant.expiresAt)}</p>
<form method="post" action="${OAUTH_GRANTS_REVOKE_PATH}">
<input type="hidden" name="grant" value="${escapeHtml(grant.id)}">
<button class="button button-danger">取り消す<span class="visually-hidden">: ${label}、${formatEpochSeconds(grant.createdAt)} に許可</span></button>
</form>
</li>`;
  });
  const list =
    rows.length > 0
      ? `<p class="lead">取り消すと、その接続はすぐに使えなくなります。client_id が同じアプリを許可し直すと、以前の許可は自動で取り消されます。</p>
<ul class="grants">\n${rows.join("\n")}\n</ul>`
      : "<p>許可した接続はありません。</p>";
  const more =
    nextCursor === undefined
      ? ""
      : `<p><a href="${OAUTH_GRANTS_PATH}?cursor=${encodeURIComponent(nextCursor)}">続きを見る</a></p>`;
  return pageHtml(
    "許可した接続",
    `<h1>許可した接続</h1>
${noticeHtml}
${list}
${more}
${BACK_LINK}`,
    siteName,
  );
}

const UNREGISTERED_CLIENT_LABEL = "登録が消えたアプリ";

function clientLabelHtml(name: string | undefined): string {
  return name === undefined
    ? `（${UNREGISTERED_CLIENT_LABEL}）`
    : escapeHtml(truncate(name, CONSENT_NAME_LENGTH));
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return "";
  }
}

function errorPage(
  siteName: string,
  status: number,
  message: string,
  hint = "接続するアプリから、接続をやり直してください。",
  heading = "接続できません",
): Response {
  const body = pageHtml(
    escapeHtml(heading),
    `<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(message)}</p>
<p>${escapeHtml(hint)}</p>
${BACK_LINK}`,
    siteName,
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

/**
 * URL の区切り（`/`、`?`、`&`、`#`）の直後に折り返せる位置を作る。CSS の overflow-wrap だけでは
 * 行の幅いっぱいで切れ、語の途中で折り返す。`//` のように区切りが続く間では切らない。
 * 区切ってからそれぞれをエスケープするので、足すタグは `<wbr>` だけになる。
 */
export function breakableUriHtml(uri: string): string {
  return uri
    .split(/(?<=[/?&#])(?![/?&#])/)
    .map(escapeHtml)
    .join("<wbr>");
}

/** 「3分前（2026/10/01 00:00 UTC）」の形。時計のずれで未来になった場合も「1分以内」に丸める */
export function describeRegistration(registeredAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - registeredAt) / 60_000));
  const age =
    minutes < 1
      ? "1分以内"
      : minutes < 60
        ? `${minutes}分前`
        : minutes < 24 * 60
          ? `${Math.floor(minutes / 60)}時間前`
          : `${Math.floor(minutes / (24 * 60))}日前`;
  return `${age}（${formatUtcMinutes(registeredAt)}）`;
}

/**
 * scope の並びを、同意画面と一覧に出す権限の名前にして HTML にエスケープする。空なら null。
 * write は read を含む（principal.ts の hasScope）ので、write があれば read の有無によらず「読み書き」に
 * まとめる。知らない scope は client が要求できる任意の文字列なので、名前を当てずにそのまま並べる。
 */
export function describeScopesHtml(scopes: readonly string[]): string | null {
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
  { registeredAt, now, siteName }: { registeredAt: number | null; now: number; siteName: string },
): string {
  const name = escapeHtml(truncate(consent.clientName, CONSENT_NAME_LENGTH));
  const requested = describeScopesHtml(consent.scope) ?? "（指定なし）";
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
<dd><strong>${escapeHtml(consent.redirectHost)}</strong><code class="uri">${breakableUriHtml(consent.redirectUri)}</code></dd></div>
${registered}<div><dt>要求された権限</dt>
<dd>${requested}</dd></div>
</dl>
<p class="warn">この接続を、いま自分で始めた場合だけ許可してください。他の人から送られたリンクで開いた場合は、許可しないでください。送り先が claude.ai でも、接続を始めた人が自分とは限りません。</p>
${loopback}
<form method="post" class="consent-form" autocomplete="off">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<fieldset class="choices">
<legend>許可する権限</legend>
<label class="choice"><input type="radio" name="access" value="read" checked><span><strong>読み取り</strong>: 下書きを含むすべてのページを読めます。</span></label>
<label class="choice"><input type="radio" name="access" value="write"><span><strong>読み書き</strong>: 読み取りに加えて、ページの作成と書き換えができます。公開中のページも書き換えられます。削除、画像の添付、公開と下書きの切り替えはできません。</span></label>
</fieldset>
<div class="actions"><button class="button button-primary" name="decision" value="approve">許可する</button><button class="button button-quiet" name="decision" value="deny">拒否する</button></div>
</form>
<script>${CONSENT_SUBMIT_GUARD}</script>`,
    siteName,
  );
}

/**
 * SPA（apps/web/index.html）と同じ icon を指す。パスは wrangler.jsonc の run_worker_first で Worker を通さない
 * ものに限る。Worker を通すと owner には private, no-store が付き、キャッシュが効かない。
 */
const ICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">`;

function pageHtml(title: string, main: string, siteName: string): string {
  return `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
${ICON_LINKS}
<style>
${themeCss}
${pageCss}
</style>
<p class="brand">${escapeHtml(siteName)}</p>
<main class="sheet">
${main}
</main>
</html>
`;
}
