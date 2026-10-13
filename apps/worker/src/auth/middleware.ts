import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { matchedRoutes } from "hono/route";
import type { RouterRoute } from "hono/types";
import type { AppEnv } from "../env";
import { findActiveApiToken, recordApiTokenUse } from "./api-tokens";
import { readOwnerAuthConfig } from "./owner-config";
import { type Principal, principalHasScope, type Scope } from "./principal";
import { sessionCookieOf, verifySessionValue } from "./session";
import { hashApiToken, isWellFormedApiToken } from "./token";

/*
 * 認可の流れ（createApp が登録順を固定する）:
 *   1. rejectAmbiguousCredentials: セッション cookie と Authorization の併用を 400 にする
 *   2. rejectCrossSiteCookieWrites: セッション cookie 付きの変更系に CSRF の検査を掛ける
 *   3. resolvePrincipal: Authorization かセッション cookie からリクエストの principal を決める
 *   4. enforceDeclaredPolicy: 宣言の無い登録がマッチしていれば、どのハンドラも呼ばずに 404 にする
 *   5. ルートごとの宣言（requireScope、requireToken、requireOwner、allowAnonymous）: principal と
 *      scope を検査する
 *
 * 4 が保証すること: マッチした登録のうち、基盤の middleware と宣言を除くすべて（ハンドラや
 * 宣言でない middleware）について、それより前に同じ path・同じ method の宣言が登録されている。
 * 1 つでも満たさなければリクエスト全体を拒否する。ALL の宣言（use、all）は ALL の登録しか守らない。
 * `.use(p, requireToken("read")).put(p, h)` を通すと、write を書き忘れた h が read で動くため。
 *
 * そのため宣言は、守りたい登録と同じ path に付ける。
 *   - `.get("/api/pages/:slug", requireToken("read"), handler)` のように同じ呼び出しで付けるのが基本。
 *   - `.use("/api/*", requireToken("read"))` は path が "/api/*" の登録（mount など）にしか効かず、
 *     "/api/pages" のハンドラを守らない。prefix で一括して守る書き方は、宣言漏れを隠すので採らない。
 *   - 宣言は守る登録より前に置く。後ろに置いた宣言は数えない。
 * 保証の単位は (path, method)。Hono の登録情報からは `.get(p, policy, h1, h2)` と
 * `.get(p, policy, h1).get(p, h2)` を区別できないので、同じ path・method に前の登録の宣言があれば
 * それが効く。別の path や別の method の宣言、catch-all の allowAnonymous() には便乗できない。
 */

const policies = new WeakSet<MiddlewareHandler>();
const baseMiddlewares = new WeakSet<MiddlewareHandler>();

/** ルートが受け付ける principal を宣言する middleware として登録する。 */
function definePolicy(handler: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> {
  policies.add(handler as MiddlewareHandler);
  return handler;
}

/**
 * 全ルートに共通の基盤の middleware（認証、CORS、セキュリティヘッダーなど）として登録する。
 * wildcard の path（`*` で終わる）に `use()` で置いたときだけ enforceDeclaredPolicy の検査から
 * 外れる。外れるので、ハンドラの代わりに応答を作る middleware（principal に関係なく内容を返すもの）
 * には使わない。
 */
export function defineBaseMiddleware<T extends MiddlewareHandler>(handler: T): T {
  baseMiddlewares.add(handler as MiddlewareHandler);
  return handler;
}

// app.route() で onError を持つ子 app を合成すると、Hono はハンドラを包み、元の関数を
// このキーに残す。辿らないと子 app の宣言を見落とし、そのルートがすべて 404 になる。
const COMPOSED_HANDLER = "__COMPOSED_HANDLER";

function isRegisteredIn(set: WeakSet<MiddlewareHandler>, handler: unknown): boolean {
  let current = handler;
  while (typeof current === "function") {
    if (set.has(current as MiddlewareHandler)) return true;
    current = (current as unknown as Record<string, unknown>)[COMPOSED_HANDLER];
  }
  return false;
}

// 基盤として扱うのは wildcard の use() に置いた登録だけにする。個別ルートのハンドラを
// defineBaseMiddleware で包んで宣言を逃れる書き方を通さないため。
function isBaseRegistration(route: RouterRoute): boolean {
  return (
    route.method === "ALL" &&
    route.path.endsWith("*") &&
    isRegisteredIn(baseMiddlewares, route.handler)
  );
}

/** `routes` は Hono が返すマッチ順（登録順）のまま渡す。 */
function everyRouteDeclared(routes: readonly RouterRoute[]): boolean {
  const declared: RouterRoute[] = [];
  for (const route of routes) {
    if (isBaseRegistration(route)) continue;
    if (isRegisteredIn(policies, route.handler)) {
      declared.push(route);
      continue;
    }
    const covered = declared.some(
      (policy) => policy.path === route.path && policy.method === route.method,
    );
    if (!covered) return false;
  }
  return true;
}

/**
 * 不正な形式・未登録・失効済みのトークンを区別させないため、どれも同じ応答にする。
 * error パラメータ（RFC 6750 の invalid_token など）も付けない。
 */
function unauthorized(c: Context<AppEnv>): Response {
  return c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
}

/**
 * どちらの権限で動いたかを曖昧にしないため、セッション cookie と Authorization の併用は中身を
 * 見ずに拒否する。cookie の名前で絞るのは、zone の Bot 系の機能や Access が付ける cookie を
 * cookie jar ごと送り返すクライアントの Bearer を止めないため。
 */
export const rejectAmbiguousCredentials = defineBaseMiddleware(
  createMiddleware<AppEnv>(async (c, next) => {
    if (sessionCookieOf(c) !== undefined && c.req.header("Authorization") !== undefined) {
      return c.json({ error: "ambiguous_credentials" }, 400);
    }
    await next();
  }),
);

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * セッション cookie はブラウザが自動で付けるので、cookie 付きの変更系は同一オリジンのページから
 * 送られたことを確かめる。SameSite=Lax だけでは、同じサイトの別のサブドメインからの要求を防げない。
 * - Sec-Fetch-Site があれば same-origin、Origin があればリクエストのオリジンと一致すること。
 *   どちらも無い要求は拒む（ブラウザは変更系の fetch にどちらかを必ず付ける）。
 * - Content-Type は application/json に限る。フォームの送信（text/plain など）は preflight 無しに
 *   別のオリジンから送れるため、それを受け付ける型を残さない。
 * cookie の検証より前に置き、署名の有無に関係なく掛ける（ログアウトのように、期限切れの cookie
 * でも受け付けるルートを守るため）。Bearer の要求は rejectAmbiguousCredentials で cookie を
 * 持てないので、この検査を受けない。
 */
export const rejectCrossSiteCookieWrites = defineBaseMiddleware(
  createMiddleware<AppEnv>(async (c, next) => {
    if (UNSAFE_METHODS.has(c.req.method) && sessionCookieOf(c) !== undefined) {
      if (!isSameOriginRequest(c) || !isJsonContentType(c.req.header("Content-Type"))) {
        return c.json({ error: "csrf_rejected" }, 403);
      }
    }
    await next();
  }),
);

function isSameOriginRequest(c: Context<AppEnv>): boolean {
  const fetchSite = c.req.header("Sec-Fetch-Site");
  const origin = c.req.header("Origin");
  if (fetchSite === undefined && origin === undefined) return false;
  if (fetchSite !== undefined && fetchSite !== "same-origin") return false;
  if (origin !== undefined && origin !== new URL(c.req.url).origin) return false;
  return true;
}

function isJsonContentType(header: string | undefined): boolean {
  const mediaType = header?.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

const BEARER_PATTERN = /^Bearer +([^ ]+) *$/i;

export interface ResolvePrincipalOptions {
  /** UNIX エポックのミリ秒。テストで時刻を進めるために差し替える。 */
  now: () => number;
}

/**
 * Authorization が付いていれば有効な Bearer トークンでなければならず、公開ルートであっても
 * 無効なトークンは 401 にする（送った資格情報が黙って無視されないように）。
 * Authorization が無ければセッション cookie を見て、有効なら owner、無い・無効なら anonymous にする。
 * cookie を 401 にしないのは、期限切れの cookie を持つブラウザが匿名で読めるページまで失わないため。
 *
 * キャッシュの制御もここで行う。匿名を受け付けるルートも principal で内容が変わりうるので、
 * principal が決まった後の応答には Vary を付け、匿名以外の応答は共有キャッシュに載せない
 * （401 と 400 の早期返却はキャッシュされないステータスなので付けない）。ルートの宣言ではなく
 * principal を起点にするのは、宣言の種類を増やしたときに付け忘れないようにするため。
 */
export function resolvePrincipal({ now }: ResolvePrincipalOptions): MiddlewareHandler<AppEnv> {
  return defineBaseMiddleware(
    createMiddleware<AppEnv>(async (c, next) => {
      const principal = await authenticate(c, now);
      if (principal === null) return unauthorized(c);
      c.set("principal", principal);
      await next();
      // next() の後に付けるのは、ハンドラが c.json などを使わずに返した Response にも効かせるため
      c.header("Vary", "Authorization, Cookie", { append: true });
      if (principal.kind !== "anonymous") c.header("Cache-Control", "private, no-store");
    }),
  );
}

/** 資格情報が無効なら null。 */
async function authenticate(c: Context<AppEnv>, now: () => number): Promise<Principal | null> {
  const authorization = c.req.header("Authorization");
  if (authorization === undefined) return authenticateSession(c, now);

  const token = BEARER_PATTERN.exec(authorization)?.[1];
  if (token === undefined || !isWellFormedApiToken(token)) return null;

  const found = await findActiveApiToken(c.env.DB, await hashApiToken(token));
  if (found === null) return null;

  // waitUntil に回さず待つ。書くのは 1 トークンあたり 1 時間に 1 回なので遅延は小さく、
  // 応答の時点で記録が終わっている方がテストと運用で扱いやすい。
  await recordApiTokenUse(c.env.DB, found, now());
  return { kind: "token", name: found.name, scopes: found.scopes };
}

/** 設定が 1 つでも欠けていれば、cookie の中身に関係なく anonymous にする。 */
async function authenticateSession(c: Context<AppEnv>, now: () => number): Promise<Principal> {
  const value = sessionCookieOf(c);
  if (value === undefined) return { kind: "anonymous" };
  const config = readOwnerAuthConfig(c.env);
  if (config === null) return { kind: "anonymous" };
  return (await verifySessionValue(config, value, now()))
    ? { kind: "owner" }
    : { kind: "anonymous" };
}

/**
 * 存在しないパスと同じ応答にする。500 にしないのは、宣言漏れと未知のパスをこの段階では
 * 区別できず、匿名の探索に対して宣言漏れの有無を見せないため。
 */
export const enforceDeclaredPolicy = defineBaseMiddleware(
  createMiddleware<AppEnv>(async (c, next) => {
    if (!everyRouteDeclared(matchedRoutes(c))) return c.notFound();
    await next();
  }),
);

function currentPrincipal(c: Context<AppEnv>): Principal {
  // resolvePrincipal より前に宣言が走る登録順の誤りでは未設定になる。anonymous として拒否側に倒す
  return c.get("principal") ?? { kind: "anonymous" };
}

/** owner と、`scope` を持つ token を受け付ける。scope の判定は principalHasScope に任せる。 */
export function requireScope(scope: Scope): MiddlewareHandler<AppEnv> {
  return definePolicy(
    createMiddleware<AppEnv>(async (c, next) => {
      const principal = currentPrincipal(c);
      if (principal.kind === "anonymous") return unauthorized(c);
      if (!principalHasScope(principal, scope)) return c.json({ error: "forbidden" }, 403);
      await next();
    }),
  );
}

/** Bearer トークンだけを受け付け、`scope` を要求する。owner のセッションでは入れない（/mcp 用）。 */
export function requireToken(scope: Scope): MiddlewareHandler<AppEnv> {
  return definePolicy(
    createMiddleware<AppEnv>(async (c, next) => {
      const principal = currentPrincipal(c);
      if (principal.kind === "anonymous") return unauthorized(c);
      if (principal.kind !== "token" || !principalHasScope(principal, scope)) {
        return c.json({ error: "forbidden" }, 403);
      }
      await next();
    }),
  );
}

/** owner だけを受け付ける。token は scope に関係なく 403 にする（visibility の変更など）。 */
export function requireOwner(): MiddlewareHandler<AppEnv> {
  return definePolicy(
    createMiddleware<AppEnv>(async (c, next) => {
      const principal = currentPrincipal(c);
      if (principal.kind === "anonymous") return unauthorized(c);
      if (principal.kind !== "owner") return c.json({ error: "forbidden" }, 403);
      await next();
    }),
  );
}

/** 呼び出し元を問わないルート（ヘルスチェック、SPA の配信など）であることを宣言する。 */
export function allowAnonymous(): MiddlewareHandler<AppEnv> {
  return definePolicy(createMiddleware<AppEnv>(async (_c, next) => next()));
}
