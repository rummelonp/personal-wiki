import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { isOwnerEmail, type OwnerAuthConfig } from "./owner-config";
import { signJson, verifyJson } from "./signed-value";

/*
 * owner のセッション cookie。Access の検証を通った後に /_auth/login が発行し、以後のリクエストでは
 * Access を通さずにこの cookie だけで owner を決める。サーバー側に状態を持たず、署名と期限だけで判定する。
 *
 * 値は `<payload の base64url>.<HMAC-SHA256 の base64url>`。payload は `{ e: email, exp: 秒 }`。
 * email を入れるのは、許可リストから外したメールの cookie を期限前でも無効にするため。
 */

/**
 * `__Host-` を付けると、ブラウザは Secure、Path=/、Domain 無しの cookie しか受け付けない。
 * 同じ親ドメインの別のサブドメインから同名の cookie を上書きされない。
 */
export const SESSION_COOKIE_NAME = "__Host-wiki_session";

/** Access のセッション期間の既定値に合わせる。 */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

// 署名の対象に入れる用途。同じ秘密で署名するほかの値（signed-value.ts の利用者）を session として通さない
const SIGNING_CONTEXT = "personal-wiki/session/v1.";

/** cookie の値を作る。now は UNIX エポックのミリ秒。 */
export function createSessionValue(
  config: OwnerAuthConfig,
  email: string,
  now: number,
): Promise<string> {
  return signJson(config.sessionSecret, SIGNING_CONTEXT, {
    e: email,
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  });
}

/** 署名、期限、許可リストのどれかが合わなければ false。 */
export async function verifySessionValue(
  config: OwnerAuthConfig,
  value: string,
  now: number,
): Promise<boolean> {
  const payload = await verifyJson(config.sessionSecret, SIGNING_CONTEXT, value);
  if (payload === null) return false;
  const { e: email, exp } = payload;
  if (typeof email !== "string" || typeof exp !== "number") return false;
  if (exp * 1000 <= now) return false;
  return isOwnerEmail(config, email);
}

/** 自前のセッション cookie の値。付いていなければ undefined（中身は検証しない）。 */
export function sessionCookieOf(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE_NAME);
}

/** Set-Cookie の属性。発行と削除で揃えないと、ブラウザが削除を別の cookie として扱う。 */
export const SESSION_COOKIE_ATTRIBUTES = {
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
} as const;
