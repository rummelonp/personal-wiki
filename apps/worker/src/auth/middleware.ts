import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { matchedRoutes } from "hono/route";
import type { AppEnv } from "../env";
import { findActiveApiToken, recordApiTokenUse } from "./api-tokens";
import { hasScope, type Principal, type Scope } from "./principal";
import { hashApiToken, isWellFormedApiToken } from "./token";

/*
 * 認可の流れ（createApp が登録順を固定する）:
 *   1. rejectAmbiguousCredentials: Cookie と Authorization の併用を 400 にする
 *   2. resolvePrincipal: Authorization からリクエストの principal を決める
 *   3. enforceDeclaredPolicy: マッチしたルートに認可の宣言が無ければ、ハンドラを呼ばずに拒否する
 *   4. ルートごとの宣言（requireToken など）: principal と scope を検査する
 * 3 があるので、宣言を書き忘れたルートは公開されず、存在しないルートと同じ 404 になる。
 */

const policies = new WeakSet<MiddlewareHandler>();

/** ルートが受け付ける principal を宣言する middleware として登録する。 */
function definePolicy(handler: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> {
  policies.add(handler as MiddlewareHandler);
  return handler;
}

// app.route() で onError を持つ子 app を合成すると、Hono はハンドラを包み、元の関数を
// このキーに残す。包まれた宣言を見落とすと拒否側に倒れるだけだが、正しく辿れるようにする。
const COMPOSED_HANDLER = "__COMPOSED_HANDLER";

function isPolicy(handler: unknown): boolean {
  let current = handler;
  while (typeof current === "function") {
    if (policies.has(current as MiddlewareHandler)) return true;
    current = (current as unknown as Record<string, unknown>)[COMPOSED_HANDLER];
  }
  return false;
}

/**
 * 不正な形式・未登録・失効済みのトークンを区別させないため、どれも同じ応答にする。
 * error パラメータ（RFC 6750 の invalid_token など）も付けない。
 */
function unauthorized(c: Context<AppEnv>): Response {
  return c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
}

/**
 * どちらの権限で動いたかを曖昧にしないため、Cookie と Authorization の併用は中身を見ずに拒否する。
 * Cookie の名前を問わないのは、owner のセッション cookie を足す前から拒否を効かせておくため。
 */
export const rejectAmbiguousCredentials = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.header("Cookie") !== undefined && c.req.header("Authorization") !== undefined) {
    return c.json({ error: "ambiguous_credentials" }, 400);
  }
  await next();
});

const BEARER_PATTERN = /^Bearer +([^ ]+) *$/i;

export interface ResolvePrincipalOptions {
  /** UNIX エポックのミリ秒。テストで時刻を進めるために差し替える。 */
  now: () => number;
}

/**
 * Authorization が無ければ anonymous。付いていれば有効な Bearer トークンでなければならず、
 * 公開ルートであっても無効なトークンは 401 にする（送った資格情報が黙って無視されないように）。
 */
export function resolvePrincipal({ now }: ResolvePrincipalOptions): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const authorization = c.req.header("Authorization");
    if (authorization === undefined) {
      c.set("principal", { kind: "anonymous" });
      return next();
    }
    const token = BEARER_PATTERN.exec(authorization)?.[1];
    if (token === undefined || !isWellFormedApiToken(token)) return unauthorized(c);

    const found = await findActiveApiToken(c.env.DB, await hashApiToken(token));
    if (found === null) return unauthorized(c);

    // waitUntil に回さず待つ。書くのは 1 トークンあたり 1 時間に 1 回なので遅延は小さく、
    // 応答の時点で記録が終わっている方がテストと運用で扱いやすい。
    await recordApiTokenUse(c.env.DB, found, now());
    c.set("principal", { kind: "token", name: found.name, scopes: found.scopes });
    await next();
  });
}

export const enforceDeclaredPolicy = createMiddleware<AppEnv>(async (c, next) => {
  if (!matchedRoutes(c).some((route) => isPolicy(route.handler))) {
    return c.json({ error: "not_found" }, 404);
  }
  await next();
});

function currentPrincipal(c: Context<AppEnv>): Principal {
  // resolvePrincipal より前に宣言が走る登録順の誤りでは未設定になる。anonymous として拒否側に倒す
  return c.get("principal") ?? { kind: "anonymous" };
}

/**
 * Bearer トークンだけを受け付け、`scope` を要求する。
 * 認証済みの応答は呼び出し元ごとに内容が変わるので、共有キャッシュに載せない。
 */
export function requireToken(scope: Scope): MiddlewareHandler<AppEnv> {
  return definePolicy(
    createMiddleware<AppEnv>(async (c, next) => {
      const principal = currentPrincipal(c);
      if (principal.kind === "anonymous") return unauthorized(c);
      if (principal.kind !== "token" || !hasScope(principal.scopes, scope)) {
        return c.json({ error: "forbidden" }, 403);
      }
      c.header("Cache-Control", "private, no-store");
      await next();
    }),
  );
}

/** 呼び出し元を問わないルート（ヘルスチェックなど）であることを宣言する。 */
export function allowAnonymous(): MiddlewareHandler<AppEnv> {
  return definePolicy(createMiddleware<AppEnv>(async (_c, next) => next()));
}
