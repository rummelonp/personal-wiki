import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { matchedRoutes } from "hono/route";
import type { RouterRoute } from "hono/types";
import type { AppEnv } from "../env";
import { mediaTypeOf, uploadContentTypeOf } from "../media-type";
import { ATTACHMENT_UPLOAD_PATH } from "../paths";
import { findActiveApiToken, recordApiTokenUse } from "./api-tokens";
import {
  authenticateOAuthAccessToken,
  bearerChallenge,
  isOAuthAccessTokenShape,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_GRANTS_REVOKE_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_TOKEN_PATH,
} from "./oauth-server";
import { readOwnerAuthConfig } from "./owner-config";
import { type Principal, principalHasScope, type Scope } from "./principal";
import {
  SESSION_COOKIE_ATTRIBUTES,
  SESSION_COOKIE_NAME,
  sessionCookieOf,
  verifySessionValue,
} from "./session";
import { hashApiToken, isWellFormedApiToken } from "./token";

/*
 * 認可の流れ（createApp が登録順を固定する）:
 *   1. rejectAmbiguousCredentials: セッション cookie と Authorization の併用を 400 にする
 *   2. rejectCrossSiteCookieWrites: セッション cookie 付きの変更系に CSRF の検査を掛ける
 *   3. resolvePrincipal: Authorization かセッション cookie からリクエストの principal を決める
 *   4. enforceDeclaredPolicy: 宣言の無い登録がマッチしていれば、どのハンドラも呼ばずに 404 にする
 *   5. ルートごとの宣言（requireScope、requireToken、requireOwner、allowAnonymousRead、
 *      allowAnonymous）: principal と
 *      scope を検査する
 *
 * 4 が保証すること: マッチした登録のうち、基盤の middleware と宣言を除くすべて（ハンドラや
 * 宣言でない middleware）について、それより前に同じ path、同じ method の宣言が登録されている。
 * 1 つでも満たさなければリクエスト全体を拒否する。ALL の宣言（use、all）は ALL の登録しか守らない。
 * `.use(p, requireToken("read")).put(p, h)` を通すと、write を書き忘れた h が read で動くため。
 *
 * そのため宣言は、守りたい登録と同じ path に付ける。
 *   - `.get("/api/pages/:slug", requireToken("read"), handler)` のように同じ呼び出しで付けるのが基本。
 *   - `.use("/api/*", requireToken("read"))` は path が "/api/*" の登録（mount など）にしか効かず、
 *     "/api/pages" のハンドラを守らない。prefix で一括して守る書き方は、宣言漏れを隠すので採らない。
 *   - 宣言は守る登録より前に置く。後ろに置いた宣言は数えない。
 * 保証の単位は (path, method)。Hono の登録情報からは `.get(p, policy, h1, h2)` と
 * `.get(p, policy, h1).get(p, h2)` を区別できないので、同じ path と method に前の登録の宣言があれば
 * それが効く。別の path や別の method の宣言、catch-all の allowAnonymous() には便乗できない。
 */

export type PolicyKind =
  | "requireScope"
  | "requireToken"
  | "requireOwner"
  | "allowAnonymousRead"
  | "allowAnonymous";

const policies = new WeakMap<MiddlewareHandler, PolicyKind>();
const baseMiddlewares = new WeakSet<MiddlewareHandler>();

/** ルートが受け付ける principal を宣言する middleware として登録する。 */
function definePolicy(
  kind: PolicyKind,
  handler: MiddlewareHandler<AppEnv>,
): MiddlewareHandler<AppEnv> {
  policies.set(handler as MiddlewareHandler, kind);
  return handler;
}

/**
 * 全ルートに共通の基盤の middleware（認証、CORS、セキュリティヘッダーなど）として登録する。
 * wildcard の path（`*` で終わる）に `use()` で置いたときだけ enforceDeclaredPolicy の検査から
 * 外れる。外れるので、ハンドラの代わりにレスポンスを作る middleware（principal に関係なく内容を返すもの）
 * には使わない。
 */
export function defineBaseMiddleware<T extends MiddlewareHandler>(handler: T): T {
  baseMiddlewares.add(handler as MiddlewareHandler);
  return handler;
}

// app.route() で onError を持つ子 app を合成すると、Hono はハンドラを包み、元の関数を
// このキーに残す。辿らないと子 app の宣言を見落とし、そのルートがすべて 404 になる。
const COMPOSED_HANDLER = "__COMPOSED_HANDLER";

/** 合成で包まれた外側から元の関数までを順に返す。 */
function* unwrapComposed(handler: unknown): Generator<MiddlewareHandler> {
  let current = handler;
  while (typeof current === "function") {
    yield current as MiddlewareHandler;
    current = (current as unknown as Record<string, unknown>)[COMPOSED_HANDLER];
  }
}

function isBaseMiddleware(handler: unknown): boolean {
  for (const fn of unwrapComposed(handler)) if (baseMiddlewares.has(fn)) return true;
  return false;
}

/**
 * `app.routes` の登録が宣言なら、その種類を返す。宣言でなければ undefined。
 * 匿名に開くルートを漏れなく検査するテストが、登録の一覧から宣言の種類で絞り込むためにも使う。
 */
export function policyKindOf(handler: unknown): PolicyKind | undefined {
  for (const fn of unwrapComposed(handler)) {
    const kind = policies.get(fn);
    if (kind !== undefined) return kind;
  }
  return undefined;
}

// 基盤として扱うのは wildcard の use() に置いた登録だけにする。個別ルートのハンドラを
// defineBaseMiddleware で包んで宣言を逃れる書き方を通さないため。
function isBaseRegistration(route: RouterRoute): boolean {
  return route.method === "ALL" && route.path.endsWith("*") && isBaseMiddleware(route.handler);
}

/** `routes` は Hono が返すマッチ順（登録順）のまま渡す。 */
function everyRouteDeclared(routes: readonly RouterRoute[]): boolean {
  const declared: RouterRoute[] = [];
  for (const route of routes) {
    if (isBaseRegistration(route)) continue;
    if (policyKindOf(route.handler) !== undefined) {
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
 * 不正な形式、未登録、失効済みのトークンを区別させないため、どれも同じレスポンスにする。
 * error パラメータ（RFC 6750 の invalid_token など）も付けない。
 */
function unauthorized(c: Context<AppEnv>): Response {
  return c.json({ error: "unauthorized" }, 401, {
    "WWW-Authenticate": bearerChallenge(c.env, new URL(c.req.url)),
  });
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
 * 送られたことを確かめる。SameSite=Lax だけでは、同じサイトの別のサブドメインからのリクエストを防げない。
 * - Sec-Fetch-Site があれば same-origin、Origin があればリクエストのオリジンと一致すること。
 *   どちらも無いリクエストは拒む（ブラウザは変更系の fetch にどちらかを必ず付ける）。
 * - Content-Type は application/json に限る。フォームの送信（text/plain など）は preflight 無しに
 *   別のオリジンから送れるため、それを受け付ける型を残さない。
 * cookie の検証より前に置き、署名の有無に関係なく掛ける（ログアウトのように、期限切れの cookie
 * でも受け付けるルートを守るため）。Bearer のリクエストは rejectAmbiguousCredentials で cookie を
 * 持てないので、この検査を受けない。
 *
 * OAuth の同意画面（POST /_auth/oauth/authorize）だけはフォームの送信を受け付ける。承認のレスポンスはクライアントの
 * redirect URI への遷移なので fetch では送れない。同一オリジンの検査は掛けたままにし、加えて同意画面を
 * 開いたブラウザに結び付いた 1 回限りの handle（oauth-routes.ts）で守る。
 * 接続の取り消し（POST /_auth/oauth/grants/revoke）も、script を持たないページのフォームから送るので
 * 受け付ける。こちらは同一オリジンの検査だけで守る（できるのは owner の接続を切ることだけ）。
 *
 * 添付のアップロード（POST /api/attachments）は本文が画像のバイト列なので、JSON の代わりに添付として
 * 受ける image/* の 5 種（media-type.ts の uploadContentTypeOf）を許す。どれも CORS で safelist されない type なので、
 * 別のオリジンからは preflight が要り、フォームからも送れない。JSON に限ったのと同じ保護になる。
 * 同一オリジンの検査は掛けたままにする。
 */
const FORM_POST_PATHS: ReadonlySet<string> = new Set([
  OAUTH_AUTHORIZE_PATH,
  OAUTH_GRANTS_REVOKE_PATH,
]);

/** JSON の代わりに、添付として受ける content type を許すパス。FORM_POST_PATHS と違い型は限る。 */
const ATTACHMENT_POST_PATHS: ReadonlySet<string> = new Set([ATTACHMENT_UPLOAD_PATH]);

export const rejectCrossSiteCookieWrites = defineBaseMiddleware(
  createMiddleware<AppEnv>(async (c, next) => {
    if (UNSAFE_METHODS.has(c.req.method) && sessionCookieOf(c) !== undefined) {
      const isPost = c.req.method === "POST";
      const contentType = c.req.header("Content-Type");
      const acceptsForm = isPost && FORM_POST_PATHS.has(c.req.path);
      const acceptsAttachment =
        isPost &&
        ATTACHMENT_POST_PATHS.has(c.req.path) &&
        uploadContentTypeOf(contentType) !== null;
      if (
        !isSameOriginRequest(c) ||
        !(acceptsForm || acceptsAttachment || mediaTypeOf(contentType) === "application/json")
      ) {
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

const BEARER_PATTERN = /^Bearer +([^ ]+) *$/i;

export interface ResolvePrincipalOptions {
  /** UNIX エポックのミリ秒。テストで時刻を進めるために差し替える。 */
  now: () => number;
}

/**
 * Authorization が付いていれば有効な Bearer トークンでなければならず、公開ルートであっても
 * 無効なトークンは 401 にする（送った資格情報が黙って無視されないように）。
 * Authorization が無ければセッション cookie を見て、有効なら owner、無ければ anonymous にする。
 * 検証できない cookie は、ここでは 401 にせず staleSession 付きの anonymous にする。401 にするかは
 * ルートの宣言が決める。
 * - ページの読み取り（allowAnonymousRead）は 401 にして、ログインが切れたことを画面に伝える。匿名で
 *   200 を返すと、owner のつもりの画面が draft の欠けた一覧を黙って出す
 * - SPA の配信や /api/me などの allowAnonymous() のルートは匿名として 200 を返す。HTML まで 401 に
 *   すると、ブラウザが画面を開けず、ログインへ進む導線も出せない
 * cookie を消すのは /api/me だけにする。読み取りの 401 で消すと、開いたままの owner の画面では次の
 * 読み取りが匿名の 200 になり、401 を表示しない呼び出しがあると通知が 1 回も出ないまま匿名の内容に
 * 入れ替わる。SPA は起動時に必ず /api/me を呼ぶので、再読み込みすれば匿名の表示に戻る。
 *
 * キャッシュの制御もここで行う。ルートの宣言ではなく principal を起点にするのは、宣言の種類や
 * 匿名に開くルートを増やしたときに付け忘れないようにするため（401 と 400 の早期返却は
 * キャッシュされないステータスなので付けない）。
 * - principal で内容が変わりうるので、principal が決まった後のレスポンスには Vary を付ける
 * - owner と token のレスポンスは private, no-store で上書きする
 * - 匿名のレスポンスは、ハンドラが Cache-Control を付けていなければ no-store にする。public から draft に
 *   戻したページは直ちに title で引けなくなる必要があり、ETag はあっても If-None-Match に応じないので、
 *   no-cache で再検証させても得るものが無い。id で取った draft の本文を共有キャッシュに置かせない意味も
 *   ある。キャッシュさせてよいレスポンス（SPA の HTML の no-cache など）は、ハンドラが明示して外す
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
      else if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
    }),
  );
}

/**
 * Bearer トークンの種類ごとの検証。形で振り分け、どの形にも当たらないトークンは無効にする。
 * 形が重ならない（api_tokens は `:` を含まない base64url）ので、並び順は結果に影響しない。
 */
interface BearerResolver {
  accepts(token: string): boolean;
  /** 無効なら null */
  resolve(c: Context<AppEnv>, token: string, now: () => number): Promise<Principal | null>;
}

const apiTokenResolver: BearerResolver = {
  accepts: isWellFormedApiToken,
  async resolve(c, token, now) {
    const found = await findActiveApiToken(c.env.DB, await hashApiToken(token));
    if (found === null) return null;
    // waitUntil に回さず待つ。書くのは 1 トークンあたり 1 時間に 1 回なので遅延は小さく、
    // レスポンスの時点で記録が終わっている方がテストと運用で扱いやすい。
    await recordApiTokenUse(c.env.DB, found, now());
    return {
      kind: "token",
      issuer: "api",
      id: found.id,
      name: found.name,
      scopes: found.scopes,
    };
  },
};

const oauthTokenResolver: BearerResolver = {
  accepts: isOAuthAccessTokenShape,
  resolve: (c, token) => authenticateOAuthAccessToken(c.env, new URL(c.req.url), token),
};

const BEARER_RESOLVERS: readonly BearerResolver[] = [apiTokenResolver, oauthTokenResolver];

/**
 * Authorization をクライアントの認証（client_secret の Basic など）に使う OAuth のエンドポイント。
 * ここでは Authorization を wiki の資格情報として読まず、検証をライブラリに任せる。
 */
const OAUTH_CLIENT_AUTH_PATHS = new Set([OAUTH_TOKEN_PATH, OAUTH_REGISTER_PATH]);

/** 資格情報が無効なら null。 */
async function authenticate(c: Context<AppEnv>, now: () => number): Promise<Principal | null> {
  const authorization = c.req.header("Authorization");
  if (authorization === undefined || OAUTH_CLIENT_AUTH_PATHS.has(c.req.path)) {
    return authenticateSession(c, now);
  }

  const token = BEARER_PATTERN.exec(authorization)?.[1];
  if (token === undefined) return null;
  const resolver = BEARER_RESOLVERS.find((candidate) => candidate.accepts(token));
  return resolver === undefined ? null : resolver.resolve(c, token, now);
}

/**
 * 設定が 1 つでも欠けていれば、cookie の中身に関係なく staleSession の無い anonymous にする。
 * 設定が無い環境では cookie を検証できないだけで無効とは言えず、ログインもできないので、401 で
 * 再ログインを促す意味が無い。一時的な設定の誤りで owner の cookie を消させない意味もある。
 */
async function authenticateSession(c: Context<AppEnv>, now: () => number): Promise<Principal> {
  const value = sessionCookieOf(c);
  if (value === undefined) return { kind: "anonymous" };
  const config = readOwnerAuthConfig(c.env);
  if (config === null) return { kind: "anonymous" };
  return (await verifySessionValue(config, value, now()))
    ? { kind: "owner" }
    : { kind: "anonymous", staleSession: true };
}

/**
 * 検証できなかったセッション cookie をブラウザから消す。次のリクエストからは cookie の無い匿名になる。
 * /api/me だけが呼ぶ（どこで消すかの理由は resolvePrincipal）。
 */
export function clearStaleSession(c: Context<AppEnv>): void {
  const principal = currentPrincipal(c);
  if (principal.kind === "anonymous" && principal.staleSession === true) {
    deleteCookie(c, SESSION_COOKIE_NAME, SESSION_COOKIE_ATTRIBUTES);
  }
}

/**
 * 存在しないパスと同じレスポンスにする。500 にしないのは、宣言漏れと未知のパスをこの段階では
 * 区別できず、匿名の探索に対して宣言漏れの有無を見せないため。
 */
export const enforceDeclaredPolicy = defineBaseMiddleware(
  createMiddleware<AppEnv>(async (c, next) => {
    if (!everyRouteDeclared(matchedRoutes(c))) return c.notFound();
    await next();
  }),
);

function currentPrincipal(c: Context<AppEnv>): Principal {
  // resolvePrincipal より前に宣言が走る登録順の誤りでは未設定になる。最も狭い権限の anonymous に倒す
  return c.get("principal") ?? { kind: "anonymous" };
}

/** owner と、`scope` を持つ token を受け付ける。scope の判定は principalHasScope に任せる。 */
export function requireScope(scope: Scope): MiddlewareHandler<AppEnv> {
  return definePolicy(
    "requireScope",
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
    "requireToken",
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
    "requireOwner",
    createMiddleware<AppEnv>(async (c, next) => {
      const principal = currentPrincipal(c);
      if (principal.kind === "anonymous") return unauthorized(c);
      if (principal.kind !== "owner") return c.json({ error: "forbidden" }, 403);
      await next();
    }),
  );
}

const ANONYMOUS_READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * ページの読み取り。owner、read の scope を持つ token、anonymous を受け付ける。anonymous に何を
 * 見せるかはハンドラが readableVisibilityOf で決める。
 * - 検証できないセッション cookie は 401 にする。cookie は消さないので、同じ cookie の間は 401 が続く
 *   （理由は resolvePrincipal）
 * - anonymous は GET と HEAD だけ。読み取りの宣言を変更系のルートに付け間違えても、匿名には開かない
 * - レスポンスの Cache-Control は resolvePrincipal が principal から決める。ハンドラは Cache-Control を
 *   付けない（付けると anonymous の no-store が外れる）。例外は添付の配信で、名前ごとに中身が変わらず
 *   ETag で再検証できるので、anonymous の 200 と 304 にだけ private, no-cache を付ける（attachments/routes.ts）
 */
export function allowAnonymousRead(): MiddlewareHandler<AppEnv> {
  return definePolicy(
    "allowAnonymousRead",
    createMiddleware<AppEnv>(async (c, next) => {
      const principal = currentPrincipal(c);
      if (principal.kind === "anonymous") {
        if (principal.staleSession === true || !ANONYMOUS_READ_METHODS.has(c.req.method)) {
          return unauthorized(c);
        }
      } else if (!principalHasScope(principal, "read")) {
        return c.json({ error: "forbidden" }, 403);
      }
      await next();
    }),
  );
}

/** 呼び出し元を問わないルート（ヘルスチェック、SPA の配信など）であることを宣言する。 */
export function allowAnonymous(): MiddlewareHandler<AppEnv> {
  return definePolicy(
    "allowAnonymous",
    createMiddleware<AppEnv>(async (_c, next) => next()),
  );
}
