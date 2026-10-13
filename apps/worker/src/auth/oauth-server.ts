import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import type { Bindings } from "../env";
import { registrationGate } from "./oauth-registration";
import { readOwnerAuthConfig } from "./owner-config";
import type { Principal, Scope } from "./principal";

/*
 * claude.ai などのカスタムコネクタが /mcp に接続するための OAuth の認可サーバー。
 * 発行したアクセストークンは /mcp だけで受け付ける（audience が /mcp。REST の /api/* は api_tokens だけ）。
 * OAUTH_KV か owner のログインの設定が無い環境では OAuth を閉じる。エンドポイントは 404、/mcp の 401 は
 * 素の Bearer の challenge になる。
 *
 * KV の無料枠（1 日に書き込み 1,000 回、読み取り 100,000 回）に収めるための見積もり:
 * - /mcp の呼び出しは 1 回ごとに KV の読み取りが 1 回
 * - アクセストークンの更新は 1 回で書き込み 2 回（grant と新しいトークン）。1 時間ごとに更新し続けても
 *   1 クライアントで 1 日 48 回
 * - 接続（登録、同意、コードの交換）は 1 回で 5〜6 回
 */

export const MCP_PATH = "/mcp";
export const OAUTH_AUTHORIZE_PATH = "/_auth/oauth/authorize";
export const OAUTH_TOKEN_PATH = "/_auth/oauth/token";
export const OAUTH_REGISTER_PATH = "/_auth/oauth/register";
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
/** RFC 9728 の、リソースのパスを well-known の後ろに挿し込んだ URL */
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

export const OAUTH_SCOPES: readonly Scope[] = ["read", "write"];

/** owner 一人の wiki なので、grant の利用者は常にこの値 */
export const OAUTH_USER_ID = "owner";

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;

/**
 * アクセストークンを長くすると更新の書き込みは減るが、漏れたときに使える時間が延びる。
 * 1 時間でも書き込みは無料枠の 1 割に満たないので、MCP のクライアントが想定する既定の長さに合わせる。
 */
const ACCESS_TOKEN_TTL_SECONDS = HOUR_SECONDS;
/**
 * 更新トークンは 30 日使われなければ失効し、使われ続ける限り延びる。月に 1 回も使わないコネクタは
 * 接続し直してもらう。
 */
const REFRESH_TOKEN_TTL_SECONDS = 30 * DAY_SECONDS;
const REFRESH_TOKEN_IDLE_TTL_SECONDS = 30 * DAY_SECONDS;
/**
 * 登録した client は使われなければ 90 日で消える（期限の半分を過ぎた client は、トークンの交換か更新が
 * 成功したときにライブラリが延ばす）。登録は匿名で呼べるので、期限を無くすと使われない登録が KV に
 * 溜まり続ける。
 */
const CLIENT_REGISTRATION_TTL_SECONDS = 90 * DAY_SECONDS;

/**
 * OAUTH_KV と owner のログインの設定がそろったときだけ OAuth を開く。同意画面は owner のセッションを
 * 要るので、ログインできない環境でメタデータを出すと、クライアントは登録まで進んでから同意で行き詰まる。
 */
export function isOAuthEnabled(env: Bindings): boolean {
  return env.OAUTH_KV !== undefined && readOwnerAuthConfig(env) !== null;
}

export function mcpResourceOf(origin: string): string {
  return `${origin}${MCP_PATH}`;
}

/**
 * issuer とリソースの URL はリクエストのオリジンから決める（テストの http://localhost も同じ扱いにする）。
 * 登録の検査（oauth-registration.ts）が env と時計を閉じ込めるので、使い回さずにリクエストごとに作る。
 * コンストラクタは設定を持つだけで、KV にも触らない。now は登録数を数える日付にだけ使う。
 */
export function oauthServerFor(
  env: Bindings,
  origin: string,
  now: () => number = Date.now,
): OAuthAuthorizationServer<Bindings> {
  return new OAuthAuthorizationServer<Bindings>({
    issuer: origin,
    resources: [mcpResourceOf(origin)],
    defaultResource: mcpResourceOf(origin),
    authorizeEndpoint: `${origin}${OAUTH_AUTHORIZE_PATH}`,
    tokenEndpoint: `${origin}${OAUTH_TOKEN_PATH}`,
    clientRegistrationEndpoint: `${origin}${OAUTH_REGISTER_PATH}`,
    scopesSupported: [...OAUTH_SCOPES],
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    refreshTokenIdleTTL: REFRESH_TOKEN_IDLE_TTL_SECONDS,
    clientRegistrationTTL: CLIENT_REGISTRATION_TTL_SECONDS,
    clientRegistrationCallback: registrationGate(env, now),
  });
}

/** ライブラリのアクセストークンは `{userId}:{grantId}:{secret}` の形をとる。 */
export function isOAuthAccessTokenShape(token: string): boolean {
  const parts = token.split(":");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function isScope(value: string): value is Scope {
  return (OAUTH_SCOPES as readonly string[]).includes(value);
}

/**
 * OAuth のアクセストークンを principal にする。無効なら null。
 * /mcp 以外では検証せずに null にする。audience が /mcp なので他のパスでは通らないが、KV の読み取りも
 * 無料枠を使うので、通らないと分かっている検証で減らさない。
 */
export async function authenticateOAuthAccessToken(
  env: Bindings,
  url: URL,
  token: string,
): Promise<Principal | null> {
  if (!isOAuthEnabled(env) || url.pathname !== MCP_PATH) return null;
  const validated = await oauthServerFor(env, url.origin).validateToken(
    mcpResourceOf(url.origin),
    token,
    env,
  );
  if (validated === null) return null;
  return {
    kind: "token",
    issuer: "oauth",
    name: validated.clientId,
    scopes: validated.scope.filter(isScope),
  };
}

/**
 * 401 に付ける WWW-Authenticate。OAuth が使える /mcp では、MCP のクライアントが認可サーバーを
 * 見つけられるよう resource_metadata を付ける。scope は付けず、クライアントにメタデータの
 * scopes_supported（read と write）を要求させる。どこまで許すかは同意画面で owner が決める。
 */
export function bearerChallenge(env: Bindings, url: URL): string {
  if (!isOAuthEnabled(env) || url.pathname !== MCP_PATH) return "Bearer";
  return `Bearer realm="OAuth", resource_metadata="${url.origin}${PROTECTED_RESOURCE_METADATA_PATH}"`;
}
